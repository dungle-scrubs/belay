import assert from "node:assert/strict";
import { test } from "vitest";
import { type Corpus, contentHash, DOCS_CORPUS_VERSION, type Page } from "./corpus";
import { createCorpusStore, type DocsFs } from "./corpus-store";

/**
 * The store round-trips a corpus as inspectable JSON, derives the manifest completeness from a
 * temp-file+rename write that finalizes the manifest last, and exposes any interruption or
 * file-level corruption as a PARTIAL load with diagnostics instead of a silently healthy corpus.
 */

const ROOT = "/state/docs";

/** An in-memory `DocsFs` over a flat path->content map, with the backing map exposed so tests can
 *  corrupt or truncate individual files the way a crashed/partial write would. */
function makeFakeFs(): { fs: DocsFs; store: Map<string, string> } {
  const store = new Map<string, string>();
  const dirs = new Set<string>();

  const childrenOf = (path: string): string[] => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children = new Set<string>();

    for (const key of [...store.keys(), ...dirs]) {
      if (key.startsWith(prefix)) {
        const segment = key.slice(prefix.length).split("/")[0];
        if (segment) {
          children.add(segment);
        }
      }
    }

    return [...children];
  };

  const fs: DocsFs = {
    mkdir: async (path) => {
      dirs.add(path);
    },
    writeFile: async (path, data) => {
      store.set(path, data);
    },
    readFile: async (path) => {
      const data = store.get(path);
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return data;
    },
    rename: async (from, to) => {
      const data = store.get(from);
      if (data === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      store.delete(from);
      store.set(to, data);
    },
    readdir: async (path) => childrenOf(path),
    exists: async (path) => store.has(path) || dirs.has(path),
    remove: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(prefix)) {
          store.delete(key);
        }
      }
      for (const dir of [...dirs]) {
        if (dir === path || dir.startsWith(prefix)) {
          dirs.delete(dir);
        }
      }
    },
  };

  return { fs, store };
}

function makePage(corpusId: string, pageId: string, content: string): Page {
  return {
    version: DOCS_CORPUS_VERSION,
    pageId,
    corpusId,
    url: `https://example.com/${pageId}`,
    finalUrl: `https://example.com/${pageId}`,
    title: `Page ${pageId}`,
    contentType: "text/markdown",
    content,
    contentHash: contentHash(content),
    fetchedAt: "2026-06-29T00:00:00.000Z",
    staleAfter: "2026-07-06T00:00:00.000Z",
    backend: "static",
    provenance: "static fetch",
    truncated: false,
    diagnostics: [],
    links: [],
  };
}

function makeCorpus(pageCount: number): Corpus {
  return {
    version: DOCS_CORPUS_VERSION,
    corpusId: "effect-schema-abc123def456",
    subject: "Effect Schema",
    name: "Effect Schema",
    source: { rootUrl: "https://effect.website/docs", host: "effect.website", version: "3" },
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    staleAfter: "2026-07-06T00:00:00.000Z",
    policy: { maxPages: 40, fetchMode: "auto", freshnessHours: 168 },
    pageCount,
    byteCount: 1234,
    truncated: false,
    partial: false,
    provenance: "web_search discovery + web_fetch (static)",
    skipped: [],
    failed: [],
  };
}

test("saveCorpus then loadCorpus round-trips the corpus and pages as a healthy, non-partial load", async () => {
  const { fs } = makeFakeFs();
  const store = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(2);
  const pages = [
    makePage(corpus.corpusId, "0000000000000001", "# One\n\nbody one"),
    makePage(corpus.corpusId, "0000000000000002", "# Two\n\nbody two"),
  ];

  await store.saveCorpus(corpus, pages);
  const loaded = await store.loadCorpus(corpus.corpusId);

  assert.equal(loaded.state, "loaded");
  if (loaded.state !== "loaded") {
    return;
  }
  assert.equal(loaded.partial, false);
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.corpus.subject, "Effect Schema");
  assert.equal(loaded.pages.length, 2);
  assert.deepEqual(loaded.pages.map((page) => page.pageId).sort(), [
    "0000000000000001",
    "0000000000000002",
  ]);
});

test("the persisted corpus is inspectable, pretty-printed JSON with a format version", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(1);

  await corpusStore.saveCorpus(corpus, [makePage(corpus.corpusId, "0000000000000001", "body")]);

  const manifestRaw = store.get(`${ROOT}/${corpus.corpusId}/manifest.json`);
  assert.ok(manifestRaw, "manifest.json is written at the corpus root");
  assert.ok(manifestRaw.includes("\n  "), "manifest is pretty-printed");
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.version, DOCS_CORPUS_VERSION);
  assert.equal(manifest.partial, false);

  const pageRaw = store.get(`${ROOT}/${corpus.corpusId}/pages/0000000000000001.json`);
  assert.ok(pageRaw, "each page is written under pages/<pageId>.json");
  assert.equal(JSON.parse(pageRaw).version, DOCS_CORPUS_VERSION);
});

test("saveCorpus leaves no temp files behind once finalized", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(1);

  await corpusStore.saveCorpus(corpus, [makePage(corpus.corpusId, "0000000000000001", "body")]);

  assert.equal(
    [...store.keys()].filter((key) => key.endsWith(".tmp")).length,
    0,
    "no .tmp file survives a finalized write",
  );
});

test("a manifest left partial (interrupted before finalize) loads as PARTIAL with a diagnostic", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(1);
  const page = makePage(corpus.corpusId, "0000000000000001", "body");

  await corpusStore.saveCorpus(corpus, [page]);
  // Simulate a crash after the PARTIAL manifest but before finalize: rewrite the manifest as partial.
  const manifestKey = `${ROOT}/${corpus.corpusId}/manifest.json`;
  store.set(
    manifestKey,
    JSON.stringify({ ...corpus, version: DOCS_CORPUS_VERSION, partial: true }),
  );

  const loaded = await corpusStore.loadCorpus(corpus.corpusId);

  assert.equal(loaded.state, "loaded");
  if (loaded.state !== "loaded") {
    return;
  }
  assert.equal(loaded.partial, true);
  assert.ok(loaded.diagnostics.some((line) => line.includes("partial")));
});

test("a page whose content was corrupted fails its hash check and loads as PARTIAL", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(1);
  const page = makePage(corpus.corpusId, "0000000000000001", "original body");

  await corpusStore.saveCorpus(corpus, [page]);
  // Tamper with the stored content but keep the recorded hash (a truncated/corrupt page file).
  const pageKey = `${ROOT}/${corpus.corpusId}/pages/0000000000000001.json`;
  store.set(pageKey, JSON.stringify({ ...page, content: "tampered body" }));

  const loaded = await corpusStore.loadCorpus(corpus.corpusId);

  assert.equal(loaded.state, "loaded");
  if (loaded.state !== "loaded") {
    return;
  }
  assert.equal(loaded.partial, true);
  assert.ok(loaded.diagnostics.some((line) => line.includes("hash mismatch")));
});

test("a manifest pageCount that disagrees with the stored pages loads as PARTIAL", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(3);

  // Claim 3 pages but only store 1.
  await corpusStore.saveCorpus(corpus, [makePage(corpus.corpusId, "0000000000000001", "body")]);
  void store;

  const loaded = await corpusStore.loadCorpus(corpus.corpusId);

  assert.equal(loaded.state, "loaded");
  if (loaded.state !== "loaded") {
    return;
  }
  assert.equal(loaded.partial, true);
  assert.ok(loaded.diagnostics.some((line) => line.includes("pageCount")));
});

test("a corpus with an unparseable manifest loads as corrupt, not healthy", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);

  store.set(`${ROOT}/broken-corpus/manifest.json`, "{ not json");

  const loaded = await corpusStore.loadCorpus("broken-corpus");

  assert.equal(loaded.state, "corrupt");
  if (loaded.state !== "corrupt") {
    return;
  }
  assert.match(loaded.detail, /json/iu);
});

test("loadCorpus reports a missing corpus distinctly", async () => {
  const { fs } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);

  assert.equal((await corpusStore.loadCorpus("nope")).state, "missing");
});

test("listCorpora summarizes healthy corpora and flags corrupt ones as partial", async () => {
  const { fs, store } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(1);

  await corpusStore.saveCorpus(corpus, [makePage(corpus.corpusId, "0000000000000001", "body")]);
  store.set(`${ROOT}/broken-corpus/manifest.json`, "{ not json");

  const list = await corpusStore.listCorpora();

  const healthy = list.find((entry) => entry.corpusId === corpus.corpusId);
  assert.ok(healthy);
  assert.equal(healthy.subject, "Effect Schema");
  assert.equal(healthy.partial, false);

  const corrupt = list.find((entry) => entry.corpusId === "broken-corpus");
  assert.ok(corrupt);
  assert.equal(corrupt.partial, true);
});

test("removeCorpus deletes the corpus directory", async () => {
  const { fs } = makeFakeFs();
  const corpusStore = createCorpusStore(fs, ROOT);
  const corpus = makeCorpus(1);

  await corpusStore.saveCorpus(corpus, [makePage(corpus.corpusId, "0000000000000001", "body")]);
  await corpusStore.removeCorpus(corpus.corpusId);

  assert.equal((await corpusStore.loadCorpus(corpus.corpusId)).state, "missing");
});

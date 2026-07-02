import assert from "node:assert/strict";
import { test } from "vitest";
import { createCorpusStore, type DocsFs } from "./corpus-store";
import type { DocsDeps } from "./deps";
import { runDocs } from "./docs";
import type { DocsArgs } from "./params";
import type { WebFetchReader, WebSearchReader } from "./readers";

/**
 * End-to-end resolve/refresh wiring (Phases 3-4): a ready docs call runs discovery -> fetch ->
 * normalize -> store through the injected readers, persisting a real corpus, marking it partial when a
 * page read fails, and preserving createdAt across a refresh. No real disk or network is touched.
 */

const ROOT = "/state/docs";

/** An in-memory `DocsFs` over a flat path->content map (mirrors the corpus-store test fake). */
function makeFakeFs(): DocsFs {
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

  return {
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
    },
  };
}

function wf(url: string, content: string): string {
  return JSON.stringify({
    url,
    finalUrl: url,
    status: 200,
    content,
    byteCount: content.length,
    truncated: false,
    backend: "static",
    needsFallback: false,
    attempts: [{ backend: "static", status: "usable" }],
  });
}

const PAGE_A = "# A\n\nReal documentation page A body, long enough to avoid the thin-content flag.";
const PAGE_B = "# B\n\nReal documentation page B body, long enough to avoid the thin-content flag.";
const PAGE_ROOT =
  "# Guide\n\nThe documentation guide root page body, long enough to be substantial.";

function fetcher(map: Record<string, string>): WebFetchReader {
  return async ({ url }) =>
    map[url] ?? JSON.stringify({ content: "", status: 404, byteCount: 0, finalUrl: url });
}

const ACME_PAGES: Record<string, string> = {
  "https://docs.acme.dev/llms.txt": wf(
    "https://docs.acme.dev/llms.txt",
    "- [A](https://docs.acme.dev/guide/a)\n- [B](https://docs.acme.dev/guide/b)",
  ),
  "https://docs.acme.dev/guide": wf("https://docs.acme.dev/guide", PAGE_ROOT),
  "https://docs.acme.dev/guide/a": wf("https://docs.acme.dev/guide/a", PAGE_A),
  "https://docs.acme.dev/guide/b": wf("https://docs.acme.dev/guide/b", PAGE_B),
};

function deps(overrides: Partial<DocsDeps> = {}): DocsDeps {
  return {
    webFetch: fetcher(ACME_PAGES),
    corpusRoot: ROOT,
    fs: makeFakeFs(),
    now: () => "2026-06-29T00:00:00.000Z",
    ...overrides,
  };
}

async function run(args: DocsArgs, d: DocsDeps): Promise<Record<string, unknown>> {
  return JSON.parse(await runDocs(args, d));
}

test("resolve from a direct URL builds and persists a corpus end-to-end", async () => {
  const d = deps();
  const parsed = await run({ action: "resolve", url: "https://docs.acme.dev/guide" }, d);

  assert.equal(parsed.outcome, "ok");
  assert.equal(parsed.action, "resolve");
  const corpus = parsed.corpus as { corpusId: string; pageCount: number; partial: boolean };
  assert.equal(corpus.pageCount, 3);
  assert.equal(corpus.partial, false);

  const reloaded = await createCorpusStore(d.fs, ROOT).loadCorpus(corpus.corpusId);
  assert.equal(reloaded.state, "loaded");
  if (reloaded.state === "loaded") {
    assert.equal(reloaded.pages.length, 3);
    assert.equal(reloaded.partial, false);
  }
});

test("resolve from a subject discovers a root through web_search then builds a corpus", async () => {
  const search: WebSearchReader = async ({ query }) =>
    JSON.stringify({
      provider: "brave",
      query,
      results: [{ title: "Acme Docs", url: "https://docs.acme.dev/" }],
    });
  const parsed = await run({ action: "resolve", subject: "Acme SDK" }, deps({ webSearch: search }));

  assert.equal(parsed.outcome, "ok");
  const corpus = parsed.corpus as { subject: string; pageCount: number };
  assert.equal(corpus.subject, "Acme SDK");
  assert.ok(corpus.pageCount >= 2);
});

test("a failed page read marks the corpus partial without throwing the turn", async () => {
  const broken = {
    ...ACME_PAGES,
    "https://docs.acme.dev/guide/b": wf("https://docs.acme.dev/guide/b", ""),
  };
  const parsed = await run(
    { action: "resolve", url: "https://docs.acme.dev/guide" },
    deps({ webFetch: fetcher(broken) }),
  );

  assert.equal(parsed.outcome, "ok");
  const corpus = parsed.corpus as { pageCount: number; partial: boolean };
  assert.equal(corpus.pageCount, 2);
  assert.equal(corpus.partial, true);
  assert.ok((parsed.diagnostics as string[]).some((line) => /failed/.test(line)));
});

test("resolve with neither subject nor url is a typed error, not a throw", async () => {
  const parsed = await run({ action: "resolve" }, deps());

  assert.equal(parsed.outcome, "error");
  assert.match(parsed.detail as string, /subject or a url/);
});

test("resolve for a subject without a web_search seam reports it unavailable", async () => {
  const parsed = await run({ action: "resolve", subject: "Acme" }, deps());

  assert.equal(parsed.outcome, "unavailable");
  assert.deepEqual(parsed.missing, ["web_search"]);
});

test("refresh by corpusId rebuilds the corpus and preserves createdAt", async () => {
  let clock = "2026-06-29T00:00:00.000Z";
  const d = deps({ now: () => clock });

  const built = await run({ action: "resolve", url: "https://docs.acme.dev/guide" }, d);
  const corpusId = (built.corpus as { corpusId: string }).corpusId;

  clock = "2026-06-30T12:00:00.000Z";
  const refreshed = await run({ action: "refresh", corpusId }, d);

  assert.equal(refreshed.outcome, "ok");
  const reloaded = await createCorpusStore(d.fs, ROOT).loadCorpus(corpusId);
  assert.equal(reloaded.state, "loaded");
  if (reloaded.state === "loaded") {
    assert.equal(reloaded.corpus.createdAt, "2026-06-29T00:00:00.000Z");
    assert.equal(reloaded.corpus.updatedAt, "2026-06-30T12:00:00.000Z");
  }
});

test("refresh of an unknown corpusId is a typed not-found error", async () => {
  const parsed = await run({ action: "refresh", corpusId: "nope-000000000000" }, deps());

  assert.equal(parsed.outcome, "error");
  assert.match(parsed.detail as string, /not found/);
});

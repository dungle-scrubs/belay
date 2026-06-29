import assert from "node:assert/strict";
import { test } from "vitest";
import type { DocsFs } from "./corpus-store";
import { type DocsArgs, type DocsDeps, runDocs } from "./docs";
import type { WebFetchReader, WebSearchReader } from "./readers";

/**
 * Freshness and refresh through the tool entry: a fresh corpus is reused with zero network calls, a
 * resolve past the 24-hour window refreshes, a manual refresh always rebuilds, and a refresh whose
 * network fails falls back to the stale cached corpus with an explicit `stale: true` - stale content
 * is never presented as fresh. The injected clock makes every staleness boundary deterministic; no
 * real disk or network is touched.
 */

const ROOT = "/state/docs";
const FRESH = "2026-06-29T00:00:00.000Z";
const PAST_STALE = "2026-06-30T06:00:00.000Z";

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

const ACME_PAGES: Record<string, string> = {
  "https://docs.acme.dev/llms.txt": wf(
    "https://docs.acme.dev/llms.txt",
    "- [A](https://docs.acme.dev/guide/a)\n- [B](https://docs.acme.dev/guide/b)",
  ),
  "https://docs.acme.dev/guide": wf("https://docs.acme.dev/guide", PAGE_ROOT),
  "https://docs.acme.dev/guide/a": wf("https://docs.acme.dev/guide/a", PAGE_A),
  "https://docs.acme.dev/guide/b": wf("https://docs.acme.dev/guide/b", PAGE_B),
};

/** A deps factory over a single shared fs and clock, with web_fetch/web_search call counters. */
function harness(initialClock: string) {
  let clock = initialClock;
  const counts = { fetch: 0, search: 0 };
  const fs = makeFakeFs();
  let webFetch: WebFetchReader = async ({ url }) => {
    counts.fetch += 1;

    return (
      ACME_PAGES[url] ?? JSON.stringify({ content: "", status: 404, byteCount: 0, finalUrl: url })
    );
  };
  const webSearch: WebSearchReader = async ({ query }) => {
    counts.search += 1;

    return JSON.stringify({
      provider: "test",
      query,
      results: [{ title: "Acme Docs", url: "https://docs.acme.dev/" }],
    });
  };

  const deps = (): DocsDeps => ({
    webFetch: (input) => webFetch(input),
    webSearch,
    corpusRoot: ROOT,
    fs,
    now: () => clock,
  });

  return {
    counts,
    deps,
    setClock: (next: string) => {
      clock = next;
    },
    setWebFetch: (next: WebFetchReader) => {
      webFetch = next;
    },
    run: async (args: DocsArgs): Promise<Record<string, unknown>> =>
      JSON.parse(await runDocs(args, deps())),
  };
}

test("a fresh corpus is reused on the next resolve with zero web_fetch/web_search calls", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  assert.equal(built.outcome, "ok");
  assert.equal(built.stale, false);
  assert.ok(h.counts.fetch > 0, "the first resolve fetches");
  const after = { ...h.counts };

  const reused = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  assert.equal(reused.outcome, "ok");
  assert.equal(reused.stale, false);
  assert.equal(h.counts.fetch, after.fetch, "a fresh hit makes no new web_fetch call");
  assert.equal(h.counts.search, after.search, "a fresh hit makes no new web_search call");
  assert.match(reused.detail as string, /reused cached corpus/);
});

test("a subject resolve reuses a fresh corpus without re-searching the web", async () => {
  const h = harness(FRESH);

  await h.run({ action: "resolve", subject: "Acme Docs" });
  const after = { ...h.counts };

  const reused = await h.run({ action: "resolve", subject: "Acme Docs" });
  assert.equal(reused.outcome, "ok");
  assert.equal(h.counts.fetch, after.fetch);
  assert.equal(h.counts.search, after.search);
});

test("a resolve past the 24-hour window refreshes the corpus", async () => {
  const h = harness(FRESH);

  await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const after = { ...h.counts };

  h.setClock(PAST_STALE);
  const refreshed = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });

  assert.equal(refreshed.outcome, "ok");
  assert.equal(refreshed.stale, false);
  assert.ok(h.counts.fetch > after.fetch, "a stale resolve re-fetches");
  assert.equal((refreshed.corpus as { updatedAt: string }).updatedAt, PAST_STALE);
});

test("allowRefresh re-fetches even when the corpus is still fresh", async () => {
  const h = harness(FRESH);

  await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const after = { ...h.counts };

  const forced = await h.run({
    action: "resolve",
    url: "https://docs.acme.dev/guide",
    allowRefresh: true,
  });
  assert.equal(forced.outcome, "ok");
  assert.ok(h.counts.fetch > after.fetch, "allowRefresh forces a re-fetch");
});

test("allowStale serves a stale corpus without any network refresh", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const after = { ...h.counts };

  h.setClock(PAST_STALE);
  const stale = await h.run({
    action: "resolve",
    url: "https://docs.acme.dev/guide",
    allowStale: true,
  });

  assert.equal(stale.outcome, "ok");
  assert.equal(stale.stale, true);
  assert.equal(h.counts.fetch, after.fetch, "allowStale makes no network call");
  assert.equal(
    (stale.corpus as { pageCount: number }).pageCount,
    (built.corpus as { pageCount: number }).pageCount,
  );
});

test("a manual refresh rebuilds the corpus on demand", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const corpusId = (built.corpus as { corpusId: string }).corpusId;
  const after = { ...h.counts };

  h.setClock(PAST_STALE);
  const refreshed = await h.run({ action: "refresh", corpusId });

  assert.equal(refreshed.outcome, "ok");
  assert.equal(refreshed.stale, false);
  assert.ok(h.counts.fetch > after.fetch, "a manual refresh re-fetches");
  assert.equal((refreshed.corpus as { updatedAt: string }).updatedAt, PAST_STALE);
});

test("a refresh whose network fails falls back to the stale corpus marked stale, never as fresh", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const pageCount = (built.corpus as { pageCount: number }).pageCount;

  h.setClock(PAST_STALE);
  h.setWebFetch(async () => {
    throw new Error("network down");
  });

  const served = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });

  assert.equal(served.outcome, "ok");
  assert.equal(served.stale, true, "stale fallback is flagged stale, not fresh");
  assert.equal((served.corpus as { pageCount: number }).pageCount, pageCount);
  assert.match(served.detail as string, /STALE/);
  assert.ok((served.diagnostics as string[]).some((line) => /refresh failed/.test(line)));
});

test("a fresh result is never marked stale", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });

  assert.equal(built.stale, false);
});

test("a refresh by corpusId whose network fails falls back to the stale corpus", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const corpusId = (built.corpus as { corpusId: string }).corpusId;

  h.setClock(PAST_STALE);
  h.setWebFetch(async () => {
    throw new Error("network down");
  });

  const served = await h.run({ action: "refresh", corpusId });

  assert.equal(served.outcome, "ok");
  assert.equal(served.stale, true);
  assert.match(served.detail as string, /STALE/);
});

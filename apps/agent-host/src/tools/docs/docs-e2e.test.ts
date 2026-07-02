import assert from "node:assert/strict";
import { test } from "vitest";
import type { DocsFs } from "./corpus-store";
import type { DocsDeps } from "./deps";
import { runDocs } from "./docs";
import type { DocsArgs } from "./params";
import type { WebFetchReader, WebSearchReader } from "./readers";

/**
 * Plan 05 M8: full-workflow verification with MOCKED web_search + web_fetch (injected readers). These
 * are hermetic e2e-style tests over the real docs pipeline (discovery -> fetch -> normalize -> store ->
 * query) - no real disk or network is touched. They prove the search -> fetch -> corpus -> query
 * workflow surfaces content AND provenance that are both model-visible (in the serialized envelope) and
 * web-renderable (the exact field shape `apps/web/.../docs.tsx` reads), and that a stale refresh and a
 * post-stale network failure degrade to stale-with-metadata rather than a turn failure.
 */

const ROOT = "/state/docs";
const FRESH = "2026-06-29T00:00:00.000Z";
const PAST_STALE = "2026-06-30T06:00:00.000Z";

/** An in-memory `DocsFs` over a flat path->content map (mirrors the other docs test fakes). */
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

/** A web_fetch envelope for a page, mirroring the live web_fetch wire form. */
function wf(url: string, content: string, title?: string): string {
  return JSON.stringify({
    url,
    finalUrl: url,
    status: 200,
    ...(title !== undefined ? { title } : {}),
    content,
    byteCount: content.length,
    truncated: false,
    backend: "static",
    needsFallback: false,
    attempts: [{ backend: "static", status: "usable" }],
  });
}

const ACME_PAGES: Record<string, string> = {
  "https://docs.acme.dev/llms.txt": wf(
    "https://docs.acme.dev/llms.txt",
    [
      "- [Auth](https://docs.acme.dev/guide/auth)",
      "- [Tokens](https://docs.acme.dev/guide/tokens)",
    ].join("\n"),
  ),
  "https://docs.acme.dev/guide": wf(
    "https://docs.acme.dev/guide",
    "# Guide\n\nThe Acme API documentation guide root, long enough to be substantial content.",
    "Guide",
  ),
  "https://docs.acme.dev/guide/auth": wf(
    "https://docs.acme.dev/guide/auth",
    "# Authentication\n\nAuthentication uses an API token. Pass the token in the Authorization header.",
    "Authentication",
  ),
  "https://docs.acme.dev/guide/tokens": wf(
    "https://docs.acme.dev/guide/tokens",
    "# Tokens\n\nA token authorizes a request. Rotate the token regularly. Each token carries a scope.",
    "Tokens",
  ),
};

/** A deps factory over one shared fs + clock with web_fetch/web_search call counters. */
function harness(initialClock: string) {
  let clock = initialClock;
  const counts = { fetch: 0, search: 0 };
  const fs = makeFakeFs();
  let pages = ACME_PAGES;
  let webFetch: WebFetchReader = async ({ url }) => {
    counts.fetch += 1;

    return pages[url] ?? JSON.stringify({ content: "", status: 404, byteCount: 0, finalUrl: url });
  };
  const webSearch: WebSearchReader = async ({ query }) => {
    counts.search += 1;

    return JSON.stringify({
      provider: "test",
      query,
      results: [{ title: "Acme API Docs", url: "https://docs.acme.dev/" }],
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
    setClock: (next: string) => {
      clock = next;
    },
    setPages: (next: Record<string, string>) => {
      pages = next;
    },
    setWebFetch: (next: WebFetchReader) => {
      webFetch = next;
    },
    run: async (args: DocsArgs): Promise<Record<string, unknown>> =>
      JSON.parse(await runDocs(args, deps())),
  };
}

/**
 * The renderable view the web docs renderer (`docs.tsx`) extracts from the serialized envelope. Pulling
 * it here proves the wire shape the UI reads - corpus identity, cited excerpts, page content, and
 * provenance - is actually present on the model-facing result, tying the host output to the renderer.
 */
function renderableView(result: Record<string, unknown>) {
  const corpus = result.corpus as { subject?: string; rootUrl?: string } | undefined;
  const query = result.query as { excerpts?: unknown[] } | undefined;
  const previewExcerpts = result.excerpts as unknown[] | undefined;

  return {
    subject: corpus?.subject,
    rootUrl: corpus?.rootUrl,
    excerpts: (query?.excerpts ?? previewExcerpts ?? []) as {
      url?: string;
      title?: string;
      locator?: string;
      excerpt?: string;
    }[],
    provenance: typeof result.provenance === "string" ? result.provenance : undefined,
    stale: result.stale === true,
  };
}

test("search -> fetch -> corpus -> query: a subject resolves, then cached search cites provenance-bearing excerpts", async () => {
  const h = harness(FRESH);

  // Discovery (web_search) -> fetch (web_fetch) -> normalize -> store.
  const built = await h.run({ action: "resolve", subject: "Acme API" });
  assert.equal(built.outcome, "ok");
  assert.ok(h.counts.search > 0, "discovery went through the web_search seam");
  assert.ok(h.counts.fetch > 0, "pages were read through the web_fetch seam");

  const corpusId = (built.corpus as { corpusId: string }).corpusId;

  // The built result is web-renderable: a corpus identity plus a cited excerpt preview.
  const builtView = renderableView(built);
  assert.equal(builtView.subject, "Acme API", "the corpus subject is model-visible");
  assert.ok(
    builtView.rootUrl?.startsWith("https://docs.acme.dev"),
    "the doc root is model-visible",
  );
  assert.ok(builtView.excerpts.length > 0, "the resolve preview carries cited excerpts");

  // Query the CACHED corpus (no further network) -> ranked, cited excerpts.
  const after = { ...h.counts };
  const found = await h.run({ action: "search", corpusId, query: "token" });
  assert.equal(found.outcome, "ok");
  assert.equal(h.counts.fetch, after.fetch, "a cached search makes no new web_fetch call");
  assert.equal(h.counts.search, after.search, "a cached search makes no new web_search call");

  const view = renderableView(found);
  assert.ok(view.excerpts.length > 0, "search returns excerpts");
  for (const excerpt of view.excerpts) {
    assert.ok(excerpt.url?.startsWith("https://docs.acme.dev/"), "each excerpt cites a source URL");
    assert.ok((excerpt.locator ?? "").length > 0, "each excerpt carries a stable locator");
  }
  assert.ok(
    view.excerpts.some((excerpt) => /token/i.test(excerpt.excerpt ?? "")),
    "the matched documentation content is model-visible",
  );

  // status exposes provenance that names the discovery + fetch path.
  const status = await h.run({ action: "status", corpusId });
  const statusView = renderableView(status);
  assert.ok(statusView.provenance, "status carries a provenance line");
  assert.match(
    statusView.provenance ?? "",
    /web_fetch/,
    "provenance records the fetch backend path",
  );
});

test("stale refresh: a corpus past the 24-hour window is rebuilt with fresh content on the next resolve", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const corpusId = (built.corpus as { corpusId: string }).corpusId;
  const firstUpdated = (built.corpus as { updatedAt: string }).updatedAt;

  // The published docs change, and the clock advances past the freshness horizon.
  h.setPages({
    ...ACME_PAGES,
    "https://docs.acme.dev/guide/tokens": wf(
      "https://docs.acme.dev/guide/tokens",
      "# Tokens\n\nTokens now expire after ninety days and must be rotated before expiry.",
      "Tokens",
    ),
  });
  h.setClock(PAST_STALE);

  const refreshed = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  assert.equal(refreshed.outcome, "ok");
  assert.equal(refreshed.stale, false, "a successful refresh is served fresh, not stale");
  assert.equal((refreshed.corpus as { corpusId: string }).corpusId, corpusId, "same corpus id");
  assert.notEqual(
    (refreshed.corpus as { updatedAt: string }).updatedAt,
    firstUpdated,
    "the refresh advances the corpus updatedAt",
  );

  const found = await h.run({ action: "search", corpusId, query: "expire" });
  assert.ok(
    renderableView(found).excerpts.some((excerpt) => /ninety days/.test(excerpt.excerpt ?? "")),
    "the refreshed content is searchable",
  );
});

test("network-failure fallback: a refresh whose fetch fails serves the stale corpus with stale metadata, still searchable", async () => {
  const h = harness(FRESH);

  const built = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  const corpusId = (built.corpus as { corpusId: string }).corpusId;
  const pageCount = (built.corpus as { pageCount: number }).pageCount;

  // Past the freshness window, the network is down: refresh cannot complete.
  h.setClock(PAST_STALE);
  h.setWebFetch(async () => {
    throw new Error("network down");
  });

  const served = await h.run({ action: "resolve", url: "https://docs.acme.dev/guide" });
  assert.equal(served.outcome, "ok", "a network failure does not throw the turn");
  assert.equal(
    served.stale,
    true,
    "the fallback is explicitly flagged stale, never presented fresh",
  );
  assert.equal(
    (served.corpus as { pageCount: number }).pageCount,
    pageCount,
    "stale content served",
  );
  assert.match(served.detail as string, /STALE/, "the detail surfaces the stale fallback");
  assert.ok(
    (served.diagnostics as string[]).some((line) => /refresh failed/.test(line)),
    "a refresh-failed diagnostic is visible in the metadata",
  );

  // The stale corpus remains usable: a search still cites sources, flagged stale.
  const found = await h.run({ action: "search", corpusId, query: "token", allowStale: true });
  assert.equal(found.outcome, "ok");
  assert.equal(found.stale, true, "a search over a stale corpus is flagged stale");
  assert.ok(renderableView(found).excerpts.length > 0, "the stale corpus is still searchable");
});

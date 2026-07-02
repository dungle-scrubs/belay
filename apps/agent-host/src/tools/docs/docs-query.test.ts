import assert from "node:assert/strict";
import { test } from "vitest";
import type { DocsFs } from "./corpus-store";
import type { DocsDeps } from "./deps";
import { runDocs } from "./docs";
import type { DocsArgs } from "./params";
import { EXCERPT_MAX_CHARS, READ_MAX_CHARS } from "./query";

/**
 * The query actions through the tool entry: resolve/refresh return a corpus summary plus selected
 * cited excerpts, search ranks the cached pages and cites each excerpt (source URL + title +
 * locator), read returns one page bounded to a char cap, and list/status expose inventory and
 * freshness/provenance. Every action caps its output and reports continuation metadata, so a large
 * corpus never dumps wholesale into the prompt. No real disk or network is touched.
 */

const ROOT = "/state/docs";
const NOW = "2026-06-29T00:00:00.000Z";

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

const BIG_BODY = "token ".repeat(5_000);

const ACME_PAGES: Record<string, string> = {
  "https://docs.acme.dev/llms.txt": wf(
    "https://docs.acme.dev/llms.txt",
    [
      "- [Auth](https://docs.acme.dev/guide/auth)",
      "- [Errors](https://docs.acme.dev/guide/errors)",
      "- [Tokens](https://docs.acme.dev/guide/tokens)",
      "- [Big](https://docs.acme.dev/guide/big)",
    ].join("\n"),
  ),
  "https://docs.acme.dev/guide": wf(
    "https://docs.acme.dev/guide",
    "# Guide\n\nThe documentation guide root page body, long enough to be substantial.",
    "Guide",
  ),
  "https://docs.acme.dev/guide/auth": wf(
    "https://docs.acme.dev/guide/auth",
    "# Authentication\n\nAuthentication uses an API token. Pass the token in the Authorization header.",
    "Authentication",
  ),
  "https://docs.acme.dev/guide/errors": wf(
    "https://docs.acme.dev/guide/errors",
    "# Errors\n\nErrors are returned as JSON. A 401 means the request was not authenticated.",
    "Errors",
  ),
  "https://docs.acme.dev/guide/tokens": wf(
    "https://docs.acme.dev/guide/tokens",
    "# Tokens\n\nA token authorizes a request. Rotate the token regularly. Each token has a scope.",
    "Tokens",
  ),
  "https://docs.acme.dev/guide/big": wf(
    "https://docs.acme.dev/guide/big",
    `# Big\n\n${BIG_BODY}`,
    "Big",
  ),
};

function deps(): DocsDeps {
  return {
    webFetch: async ({ url }) =>
      ACME_PAGES[url] ?? JSON.stringify({ content: "", status: 404, byteCount: 0, finalUrl: url }),
    corpusRoot: ROOT,
    fs: makeFakeFs(),
    now: () => NOW,
  };
}

async function run(args: DocsArgs, d: DocsDeps): Promise<Record<string, unknown>> {
  return JSON.parse(await runDocs(args, d));
}

/** Resolves the ACME corpus and returns the live deps plus the new corpus id. */
async function resolved(): Promise<{ d: DocsDeps; corpusId: string }> {
  const d = deps();
  const built = await run({ action: "resolve", url: "https://docs.acme.dev/guide" }, d);

  assert.equal(built.outcome, "ok");

  return { d, corpusId: (built.corpus as { corpusId: string }).corpusId };
}

test("resolve returns a corpus summary plus selected cited excerpts, capped", async () => {
  const built = await run({ action: "resolve", url: "https://docs.acme.dev/guide" }, deps());

  assert.equal(built.outcome, "ok");
  assert.ok((built.corpus as { pageCount: number }).pageCount >= 4);
  const excerpts = built.excerpts as { url: string; locator: string }[];
  assert.ok(excerpts.length > 0);
  assert.ok(
    excerpts.every((excerpt) => excerpt.url.startsWith("https://") && excerpt.locator !== ""),
  );
  assert.equal((built.window as { unit: string }).unit, "excerpts");
});

test("search ranks the cached pages and cites each excerpt", async () => {
  const { d, corpusId } = await resolved();
  const found = await run({ action: "search", corpusId, query: "token", maxResults: 3 }, d);

  assert.equal(found.outcome, "ok");
  const query = found.query as {
    corpusId: string;
    query: string;
    excerpts: { url: string; title?: string; locator: string; excerpt: string }[];
  };
  assert.equal(query.corpusId, corpusId);
  assert.equal(query.query, "token");
  assert.ok(query.excerpts.length > 0);

  for (const excerpt of query.excerpts) {
    assert.ok(excerpt.url.startsWith("https://docs.acme.dev/"), "excerpt cites a source URL");
    assert.ok(excerpt.locator.length > 0, "excerpt carries a stable locator");
    assert.ok(excerpt.excerpt.length <= EXCERPT_MAX_CHARS + 6, "excerpt is compact");
  }

  assert.equal(found.stale, false);
});

test("search caps the excerpts and pages the rest via the continuation cursor", async () => {
  const { d, corpusId } = await resolved();

  const first = await run({ action: "search", corpusId, query: "token", maxResults: 1 }, d);
  const firstWindow = first.window as {
    returned: number;
    total: number;
    truncated: boolean;
    nextOffset?: number;
  };
  assert.equal(firstWindow.returned, 1);
  assert.ok(firstWindow.total > 1);
  assert.equal(firstWindow.truncated, true);
  assert.equal(firstWindow.nextOffset, 1);

  const next = await run(
    { action: "search", corpusId, query: "token", maxResults: 1, offset: firstWindow.nextOffset },
    d,
  );
  const nextExcerpts = (next.query as { excerpts: { pageId: string }[] }).excerpts;
  assert.equal(nextExcerpts.length, 1);
  assert.notEqual(
    nextExcerpts[0]?.pageId,
    (first.query as { excerpts: { pageId: string }[] }).excerpts[0]?.pageId,
  );
});

test("read returns one cached page bounded to a char cap, never dumping a large page wholesale", async () => {
  const { d, corpusId } = await resolved();
  const result = await run({ action: "read", corpusId, url: "https://docs.acme.dev/guide/big" }, d);

  assert.equal(result.outcome, "ok");
  const page = result.page as { content: string; url: string };
  assert.ok(page.content.length <= READ_MAX_CHARS, "page content is bounded");
  assert.equal(page.url, "https://docs.acme.dev/guide/big");

  const window = result.window as {
    unit: string;
    total: number;
    truncated: boolean;
    nextOffset?: number;
  };
  assert.equal(window.unit, "chars");
  assert.ok(window.total > READ_MAX_CHARS, "the full page is much larger than the returned slice");
  assert.equal(window.truncated, true);
  assert.equal(window.nextOffset, page.content.length);

  assert.ok(
    JSON.stringify(result).length < BIG_BODY.length / 3,
    "the serialized read result is far smaller than the full page",
  );
});

test("read continues a large page from the returned offset", async () => {
  const { d, corpusId } = await resolved();

  const head = await run({ action: "read", corpusId, url: "https://docs.acme.dev/guide/big" }, d);
  const nextOffset = (head.window as { nextOffset: number }).nextOffset;

  const tail = await run(
    { action: "read", corpusId, url: "https://docs.acme.dev/guide/big", offset: nextOffset },
    d,
  );

  assert.equal(tail.outcome, "ok");
  assert.ok((tail.page as { content: string }).content.length > 0);
});

test("list reports the corpus inventory with page/byte counts and freshness", async () => {
  const { d, corpusId } = await resolved();
  const listed = await run({ action: "list" }, d);

  assert.equal(listed.outcome, "ok");
  const corpora = listed.corpora as {
    corpusId: string;
    pageCount: number;
    byteCount: number;
    partial: boolean;
    stale: boolean;
  }[];
  const entry = corpora.find((row) => row.corpusId === corpusId);

  assert.ok(entry, "the resolved corpus is listed");
  assert.ok(entry.pageCount >= 4);
  assert.ok(entry.byteCount > 0);
  assert.equal(entry.partial, false);
  assert.equal(entry.stale, false);
  assert.equal((listed.window as { unit: string }).unit, "corpora");
});

test("status reports a corpus's freshness and provenance", async () => {
  const { d, corpusId } = await resolved();
  const status = await run({ action: "status", corpusId }, d);

  assert.equal(status.outcome, "ok");
  assert.equal((status.corpus as { corpusId: string }).corpusId, corpusId);
  assert.equal(status.stale, false);
  assert.equal(typeof status.provenance, "string");
  assert.ok((status.provenance as string).length > 0);
});

test("search without a query is a typed error, not a throw", async () => {
  const { d, corpusId } = await resolved();
  const parsed = await run({ action: "search", corpusId }, d);

  assert.equal(parsed.outcome, "error");
  assert.match(parsed.detail as string, /needs a query/);
});

test("search for an uncached corpus is a typed error", async () => {
  const parsed = await run(
    { action: "search", corpusId: "nope-000000000000", query: "token" },
    deps(),
  );

  assert.equal(parsed.outcome, "error");
  assert.match(parsed.detail as string, /no cached corpus/);
});

test("read without a pageId or url is a typed error", async () => {
  const { d, corpusId } = await resolved();
  const parsed = await run({ action: "read", corpusId }, d);

  assert.equal(parsed.outcome, "error");
  assert.match(parsed.detail as string, /pageId or url/);
});

test("status without a target is a typed error", async () => {
  const parsed = await run({ action: "status" }, deps());

  assert.equal(parsed.outcome, "error");
  assert.match(parsed.detail as string, /corpusId, subject, or url/);
});

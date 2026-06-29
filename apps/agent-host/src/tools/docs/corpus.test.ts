import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { canonicalUrl, contentHash, corpusIdFor, pageIdFor } from "./corpus";

/**
 * The corpus identity contract: ids are deterministic from their inputs (so a re-resolve targets the
 * same on-disk corpus and a re-fetch the same page), URL noise that does not change identity does not
 * split ids, and a real input difference does. The content hash is a plain sha256 of the content.
 */

test("corpusIdFor is stable for the same inputs", () => {
  const input = { subject: "Effect Schema", rootUrl: "https://effect.website/docs", version: "3" };

  assert.equal(corpusIdFor(input), corpusIdFor({ ...input }));
});

test("corpusIdFor carries a readable slug derived from the subject", () => {
  const id = corpusIdFor({ subject: "Effect Schema", rootUrl: "https://effect.website/docs" });

  assert.match(id, /^effect-schema-[0-9a-f]{12}$/u);
});

test("corpusIdFor changes when subject, version, channel, or root URL change", () => {
  const base = { subject: "Effect Schema", rootUrl: "https://effect.website/docs", version: "3" };

  assert.notEqual(corpusIdFor(base), corpusIdFor({ ...base, subject: "Effect Stream" }));
  assert.notEqual(corpusIdFor(base), corpusIdFor({ ...base, version: "4" }));
  assert.notEqual(corpusIdFor(base), corpusIdFor({ ...base, channel: "beta" }));
  assert.notEqual(corpusIdFor(base), corpusIdFor({ ...base, rootUrl: "https://other.dev/docs" }));
});

test("corpusIdFor is stable across root-URL case, trailing slash, and fragment noise", () => {
  const a = corpusIdFor({ subject: "X", rootUrl: "https://Docs.Example.com/api/" });
  const b = corpusIdFor({ subject: "X", rootUrl: "https://docs.example.com/api#intro" });

  assert.equal(a, b);
});

test("corpusIdFor falls back to the host slug when the subject is empty", () => {
  const id = corpusIdFor({ subject: "   ", rootUrl: "https://docs.example.com/api" });

  assert.match(id, /^docs-example-com-[0-9a-f]{12}$/u);
});

test("pageIdFor is stable and depends on the corpusId and the canonical page URL", () => {
  const id = pageIdFor("corpus-1", "https://example.com/docs/page/");

  assert.equal(id, pageIdFor("corpus-1", "https://example.com/docs/page#section"));
  assert.notEqual(id, pageIdFor("corpus-2", "https://example.com/docs/page/"));
  assert.notEqual(id, pageIdFor("corpus-1", "https://example.com/docs/other"));
  assert.match(id, /^[0-9a-f]{16}$/u);
});

test("pageIdFor keeps query-distinguished pages distinct", () => {
  assert.notEqual(
    pageIdFor("c", "https://example.com/docs?v=3"),
    pageIdFor("c", "https://example.com/docs?v=4"),
  );
});

test("canonicalUrl normalizes case, default port, fragment, and trailing slash", () => {
  assert.equal(
    canonicalUrl("HTTPS://Example.com:443/Docs/Page/#frag"),
    "https://example.com/Docs/Page",
  );
});

test("contentHash is the sha256 of the content", () => {
  const content = "# Title\n\nbody";
  const expected = createHash("sha256").update(content).digest("hex");

  assert.equal(contentHash(content), expected);
  assert.equal(contentHash(content), contentHash(content));
  assert.notEqual(contentHash(content), contentHash(`${content} `));
});

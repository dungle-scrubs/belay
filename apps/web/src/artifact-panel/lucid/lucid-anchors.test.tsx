import assert from "node:assert/strict";
import type { LucidElementAnchor } from "@belay/session";
import { test } from "vitest";
import { anchorResolves, lucidAnchorRuntime } from "./lucid-anchors";

/** Builds a detached document from an HTML body string, for DOM-pure anchor tests under jsdom. */
function docFrom(bodyHtml: string): Document {
  const doc = document.implementation.createHTMLDocument("artifact");
  doc.body.innerHTML = bodyHtml;
  return doc;
}

test("captures and resolves an element by unique data-lucid-id", () => {
  const runtime = lucidAnchorRuntime();
  const doc = docFrom(`<h1 data-lucid-id="title">Roadmap</h1><p>step one</p>`);
  const h1 = doc.querySelector("h1");
  assert.ok(h1);
  const anchor = runtime.captureElementAnchor(h1 as Element);
  assert.equal(anchor.lucidId, "title");
  assert.ok(anchor.fingerprint);
  assert.ok(anchor.domPath);
  assert.equal(runtime.resolveElementAnchor(anchor, doc), h1);
});

test("a DUPLICATE data-lucid-id is not used for capture and falls through on resolve", () => {
  const runtime = lucidAnchorRuntime();
  const doc = docFrom(`<p data-lucid-id="dup">alpha</p><p data-lucid-id="dup">beta</p>`);
  const first = doc.querySelector("p");
  assert.ok(first);
  const anchor = runtime.captureElementAnchor(first as Element);
  assert.equal(anchor.lucidId, undefined, "a non-unique id is not captured as the anchor");
  // Even if a stale anchor carried the duplicate id, resolution must not pick arbitrarily; the
  // distinct fingerprints ("alpha" vs "beta") still resolve it correctly.
  const withDupId: LucidElementAnchor = { ...anchor, lucidId: "dup" };
  assert.equal(runtime.resolveElementAnchor(withDupId, doc), first);
});

test("falls back to fingerprint, then domPath, then orphans a lost element", () => {
  const runtime = lucidAnchorRuntime();
  const doc = docFrom(`<section><h2>Goals</h2><p>ship it</p></section>`);
  const p = doc.querySelector("p");
  assert.ok(p);
  const anchor = runtime.captureElementAnchor(p as Element);
  // Fingerprint match after the id is gone.
  assert.equal(
    runtime.resolveElementAnchor({ type: "element", fingerprint: anchor.fingerprint }, doc),
    p,
  );
  // domPath-only resolution.
  assert.equal(runtime.resolveElementAnchor({ type: "element", domPath: anchor.domPath }, doc), p);
  // A stale fingerprint/path against a changed doc orphans (returns null) rather than mis-targeting.
  const changed = docFrom(`<article><h2>Different</h2></article>`);
  assert.equal(
    runtime.resolveElementAnchor(anchor, changed),
    null,
    "no plausible match => orphaned, never a wrong element",
  );
});

test("captures and resolves a text range with quote + position, and orphans a vanished quote", () => {
  const runtime = lucidAnchorRuntime();
  const doc = docFrom(`<p>The second step ships on Friday and must be reviewed.</p>`);
  const textNode = doc.querySelector("p")?.firstChild;
  assert.ok(textNode);
  const range = doc.createRange();
  // Select "second step".
  const full = textNode?.textContent ?? "";
  const start = full.indexOf("second step");
  range.setStart(textNode as Node, start);
  range.setEnd(textNode as Node, start + "second step".length);

  const anchor = runtime.captureRangeAnchor(range, doc.body);
  assert.ok(anchor);
  assert.equal(anchor?.quote, "second step");
  assert.equal(anchor?.start, start);

  const resolved = runtime.resolveRangeAnchor(anchor as never, doc.body);
  assert.deepEqual(resolved, { start, end: start + "second step".length });

  // A version where the quote no longer appears orphans the range.
  const changed = docFrom(`<p>Completely different content here.</p>`);
  assert.equal(runtime.resolveRangeAnchor(anchor as never, changed.body), null);
});

test("an ambiguous quote resolves via prefix/suffix context, not the first occurrence", () => {
  const runtime = lucidAnchorRuntime();
  const doc = docFrom(`<p>done. done. the final done matters.</p>`);
  const textNode = doc.querySelector("p")?.firstChild as Node;
  const full = textNode.textContent ?? "";
  const target = full.indexOf("final done") + "final ".length; // the "done" inside "final done"
  const range = doc.createRange();
  range.setStart(textNode, target);
  range.setEnd(textNode, target + "done".length);
  const anchor = runtime.captureRangeAnchor(range, doc.body);
  assert.ok(anchor);
  const resolved = runtime.resolveRangeAnchor(anchor as never, doc.body);
  assert.deepEqual(resolved, { start: target, end: target + "done".length });
});

test("anchorResolves is the shared orphan predicate", () => {
  const runtime = lucidAnchorRuntime();
  const doc = docFrom(`<p data-lucid-id="only">hi</p>`);
  const anchor = runtime.captureElementAnchor(doc.querySelector("p") as Element);
  assert.equal(anchorResolves(anchor, doc), true);
  assert.equal(anchorResolves(anchor, docFrom(`<span>gone</span>`)), false);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildLucidSrcdoc,
  isFromFrame,
  LUCID_IFRAME_SANDBOX,
  LUCID_OVERLAY_WIRE,
  parseOverlayOutbound,
} from "./overlay-bootstrap";

test("parseOverlayOutbound accepts well-formed messages and rejects junk", () => {
  assert.deepEqual(parseOverlayOutbound({ v: LUCID_OVERLAY_WIRE, kind: "ready" }), {
    v: LUCID_OVERLAY_WIRE,
    kind: "ready",
  });
  const target = parseOverlayOutbound({
    v: LUCID_OVERLAY_WIRE,
    kind: "target",
    target: "element",
    anchor: { type: "element", lucidId: "hero" },
    snippet: "Ship it",
  });
  assert.equal(target?.kind, "target");
  assert.equal(target?.snippet, "Ship it");

  // Wrong wire tag, missing fields, and non-objects are all rejected.
  assert.equal(parseOverlayOutbound({ v: "other", kind: "ready" }), null);
  assert.equal(parseOverlayOutbound({ v: LUCID_OVERLAY_WIRE, kind: "target" }), null);
  assert.equal(parseOverlayOutbound("nope"), null);
  assert.equal(parseOverlayOutbound(null), null);
});

test("isFromFrame trusts only the mounted frame window (opaque origin => identity check)", () => {
  const frame = {} as unknown as Window;
  const other = {} as unknown as Window;
  assert.equal(isFromFrame(frame, frame), true);
  assert.equal(isFromFrame(other, frame), false);
  assert.equal(isFromFrame(frame, null), false);
});

test("buildLucidSrcdoc injects the overlay before </body> without mutating the artifact markup", () => {
  const html = `<!doctype html><html><body><h1 data-lucid-id="t">Hi</h1></body></html>`;
  const srcdoc = buildLucidSrcdoc(html);
  assert.ok(srcdoc.includes(`<h1 data-lucid-id="t">Hi</h1>`), "artifact markup is preserved");
  assert.ok(srcdoc.includes("<script>"), "the overlay bootstrap is injected");
  assert.ok(
    srcdoc.includes("captureElementAnchor"),
    "the shared anchor runtime is embedded verbatim",
  );
  // The injected script sits inside the body, before its close.
  assert.ok(srcdoc.indexOf("<script>") < srcdoc.indexOf("</body>"));
});

test("a bodyless fragment still gets the overlay appended", () => {
  const srcdoc = buildLucidSrcdoc(`<h1>fragment</h1>`);
  assert.ok(srcdoc.startsWith("<h1>fragment</h1>"));
  assert.ok(srcdoc.includes("<script>"));
});

test("the iframe sandbox is scripts-only with NO allow-same-origin (opaque origin isolation)", () => {
  assert.ok(LUCID_IFRAME_SANDBOX.includes("allow-scripts"));
  assert.ok(
    !LUCID_IFRAME_SANDBOX.includes("allow-same-origin"),
    "same-origin would let the artifact reach Trevor's realm - it must NOT be granted",
  );
});

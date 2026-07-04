import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { isLucidArtifact, lucidArtifactRef } from "./lucid";
import {
  adaptLucidAnchor,
  importLucidSession,
  isValidLucidExternalAnchor,
  type LucidExternalAnchor,
  lucidIdFromPath,
} from "./lucid-compat";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./__fixtures__/lucid-external-session.ndjson", import.meta.url)),
  "utf8",
);

/** The parsed `annotation` targets from the fixture (lucid's own on-disk anchor shape). */
function fixtureAnchors(): LucidExternalAnchor[] {
  return FIXTURE.split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.t === "annotation")
    .map((e) => e.target as LucidExternalAnchor);
}

test("the committed fixture conforms to the standalone lucid CLI anchor contract", () => {
  const anchors = fixtureAnchors();
  assert.equal(anchors.length, 2);
  for (const anchor of anchors) {
    assert.ok(isValidLucidExternalAnchor(anchor), "fixture anchor must pass lucid's contract");
  }
});

test("importLucidSession maps an external lucid log into structured Trevor feedback (M8)", () => {
  const imported = importLucidSession(FIXTURE);
  assert.equal(imported.lucidId, "plan", "lucidId derives from the artifact path basename");
  assert.equal(imported.version, 2, "the latest version wins");
  assert.equal(imported.reviewStatus, "resolved");
  assert.equal(imported.htmlHash, "77bde4a1");
  assert.equal(imported.annotations.length, 2);

  const [element, range] = imported.annotations;
  assert.equal(element?.annotationId, "c0ffee01-0000-4000-8000-000000000001");
  assert.equal(element?.anchor.type, "element");
  assert.equal(element?.note, "Friday is too aggressive; move to next week.");
  assert.ok(element?.snippet.includes("Ship the beta"));

  assert.equal(range?.anchor.type, "range");
  if (range?.anchor.type === "range") {
    assert.equal(range.anchor.quote, "ring-0 cohort");
    assert.equal(range.anchor.prefix, "ship the beta to the ");
    assert.equal(range.anchor.start, 142);
  }
});

test("Trevor's import is NON-DESTRUCTIVE: the fixture anchors still pass lucid's contract after import", () => {
  const before = fixtureAnchors();
  const snapshot = JSON.parse(JSON.stringify(before));
  importLucidSession(FIXTURE);
  const after = fixtureAnchors();
  // The adapter never reshapes the input; the on-disk contract is preserved (the CLI still works).
  assert.deepEqual(after, snapshot);
  for (const anchor of after) {
    assert.ok(isValidLucidExternalAnchor(anchor));
  }
});

test("an imported session becomes a panel-openable addressable Trevor artifact", () => {
  const imported = importLucidSession(FIXTURE);
  const ref = lucidArtifactRef({
    htmlHash: imported.htmlHash ?? "0".repeat(8),
    size: 0,
    meta: {
      lucidId: imported.lucidId,
      version: imported.version,
      provenance: "external",
      reviewStatus: imported.reviewStatus,
      ...(imported.title ? { title: imported.title } : {}),
    },
  });
  assert.ok(isLucidArtifact(ref), "the imported artifact routes to the addressable viewer");
  assert.equal(ref.lucid?.provenance, "external");
});

test("adaptLucidAnchor and lucidIdFromPath handle edge shapes", () => {
  assert.equal(lucidIdFromPath("/a/b/roadmap.html"), "roadmap");
  assert.equal(lucidIdFromPath("noext"), "noext");
  const adapted = adaptLucidAnchor({
    kind: "element",
    fingerprint: 'p·"x"',
    domPath: "body>p",
    snippet: "<p>x</p>",
  });
  assert.equal(adapted.anchor.type, "element");
  assert.equal(adapted.snippet, "<p>x</p>");
});

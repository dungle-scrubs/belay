import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import { artifactViewerFor } from "./artifact-registry";

function ref(input: Partial<ArtifactRef>): ArtifactRef {
  return {
    kind: input.kind ?? "file",
    hash: input.hash ?? "a".repeat(64),
    mimeType: input.mimeType ?? "application/octet-stream",
    name: input.name,
    size: input.size ?? 20,
    ...(input.lucid ? { lucid: input.lucid } : {}),
  };
}

test("maps artifact kind, MIME, and source metadata to viewer components", () => {
  assert.equal(artifactViewerFor(ref({ kind: "image", mimeType: "image/png" })).kind, "image");
  assert.equal(
    artifactViewerFor(ref({ kind: "document", mimeType: "application/pdf" })).kind,
    "document",
  );
  assert.equal(artifactViewerFor(ref({ mimeType: "text/html" })).kind, "html");
  assert.equal(artifactViewerFor(ref({ mimeType: "application/json" })).kind, "diagnostic");
  assert.equal(
    artifactViewerFor(ref({ name: "doctor-report.txt", mimeType: "text/plain" })).kind,
    "diagnostic",
  );
  assert.equal(artifactViewerFor(ref({ kind: "file" })).kind, "file");
});

test("a Lucid-marked HTML artifact routes to the addressable lucid-html viewer (M1)", () => {
  const lucid = ref({
    kind: "document",
    mimeType: "text/html",
    name: "roadmap.html",
    lucid: { lucidId: "roadmap", version: 1, provenance: "agent", reviewStatus: "open" },
  });
  assert.equal(artifactViewerFor(lucid).kind, "lucid-html");
  assert.equal(artifactViewerFor(lucid).label, "Lucid");
});

test("a plain HTML artifact WITHOUT the marker degrades to the non-addressable html viewer (M1)", () => {
  const plain = ref({ kind: "document", mimeType: "text/html", name: "notes.html" });
  assert.equal(artifactViewerFor(plain).kind, "html", "no lucid marker => plain HTML rendering");
});

test("exposes safe viewer capabilities through registry entries", () => {
  const image = artifactViewerFor(ref({ kind: "image", mimeType: "image/png" }));
  assert.deepEqual([...image.capabilities].sort(), ["download", "openExternal"]);

  const diagnostic = artifactViewerFor(ref({ mimeType: "application/json" }));
  assert.ok(diagnostic.capabilities.includes("copyMetadata"));
});

test("unknown viewer renders metadata fallback", () => {
  const artifact = ref({ name: "archive.bin" });
  const { Viewer } = artifactViewerFor(artifact);
  render(<Viewer artifact={artifact} srcOf={() => "mem://artifact"} />);
  assert.ok(screen.getByText("archive.bin"));
  assert.ok(screen.getByText("application/octet-stream"));
});

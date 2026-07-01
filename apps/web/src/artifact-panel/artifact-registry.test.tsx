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

import assert from "node:assert/strict";
import type { ArtifactRef } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import { MessageAttachments } from "./message-attachments";

function image(seed: string): ArtifactRef {
  return {
    kind: "image",
    hash: seed.repeat(64).slice(0, 64),
    mimeType: "image/png",
    name: `${seed}.png`,
    size: 100,
  };
}

const documentRef: ArtifactRef = {
  kind: "document",
  hash: "d".repeat(64),
  mimeType: "application/pdf",
  name: "report.pdf",
  size: 200,
};

test("opens transcript image artifacts in the shared panel when wired", () => {
  const opened: ArtifactRef[] = [];
  render(
    <MessageAttachments
      artifacts={[image("a"), documentRef]}
      onOpenArtifact={(artifact) => opened.push(artifact)}
      srcOf={() => "mem://artifact"}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "open image 1: a.png" }));
  fireEvent.click(screen.getByRole("button", { name: /report.pdf/ }));

  assert.deepEqual(
    opened.map((artifact) => artifact.name),
    ["a.png", "report.pdf"],
  );
  assert.equal(screen.queryByRole("dialog"), null, "shared-panel mode does not open the carousel");
});

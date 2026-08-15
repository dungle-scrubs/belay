import assert from "node:assert/strict";
import type { ArtifactRef } from "@belay/session";
import { render, screen, waitFor } from "@testing-library/react";
import { test } from "vitest";
import { LucidArtifactViewer } from "./lucid-viewer";

const HTML = `<!doctype html><html><body><h1 data-lucid-id="title">Roadmap</h1></body></html>`;

function lucidRef(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    kind: "document",
    mimeType: "text/html",
    hash: "a".repeat(64),
    size: HTML.length,
    name: "Roadmap",
    lucid: { lucidId: "roadmap", version: 1, provenance: "agent", reviewStatus: "open" },
    ...overrides,
  };
}

test("mounts the artifact in a sandboxed iframe INSIDE the panel (M2/M3), not a separate tab", async () => {
  render(
    <LucidArtifactViewer
      artifact={lucidRef()}
      lucid={{
        delivered: null,
        onDeliver: () => {},
        onReviewChange: () => {},
        loadHtml: async () => HTML,
      }}
    />,
  );
  const frame = await screen.findByTitle("Roadmap");
  assert.equal(frame.tagName, "IFRAME");
  const sandbox = frame.getAttribute("sandbox") ?? "";
  assert.ok(sandbox.includes("allow-scripts"), "overlay scripts run");
  assert.ok(
    !sandbox.includes("allow-same-origin"),
    "opaque origin: the artifact can never reach Belay's realm",
  );
  const srcdoc = frame.getAttribute("srcdoc") ?? "";
  assert.ok(srcdoc.includes(`data-lucid-id="title"`), "the artifact HTML is embedded");
  assert.ok(srcdoc.includes("captureElementAnchor"), "the addressability overlay is injected");
  // The native review chrome renders alongside the surface.
  assert.ok(screen.getByLabelText("Lucid review"));
});

test("falls back to a safe external-open link when the artifact bytes fail to load (M2)", async () => {
  render(
    <LucidArtifactViewer
      artifact={lucidRef()}
      srcOf={(hash) => `mem://blob/${hash}`}
      lucid={{
        delivered: null,
        onDeliver: () => {},
        onReviewChange: () => {},
        loadHtml: async () => {
          throw new Error("blob 404");
        },
      }}
    />,
  );
  const link = await screen.findByRole("link", { name: /open the raw HTML externally/i });
  assert.equal(link.getAttribute("href"), `mem://blob/${"a".repeat(64)}`);
  assert.equal(link.getAttribute("target"), "_blank");
});

test("reflects a delivered review's status from the fold (resume/agent) into the chrome (M6)", async () => {
  render(
    <LucidArtifactViewer
      artifact={lucidRef({
        lucid: { lucidId: "roadmap", version: 1, provenance: "agent", reviewStatus: "resolved" },
      })}
      lucid={{
        delivered: {
          lucidId: "roadmap",
          version: 1,
          htmlHash: "a".repeat(64),
          provenance: "agent",
          reviewStatus: "resolved",
          annotations: [],
          lastCursor: 2,
        },
        onDeliver: () => {},
        onReviewChange: () => {},
        loadHtml: async () => HTML,
      }}
    />,
  );
  await waitFor(() => assert.ok(screen.getByText(/approved/)));
});

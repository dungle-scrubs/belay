import assert from "node:assert/strict";
import type { ArtifactRef } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import { ArtifactPanel } from "./artifact-panel";
import { ARTIFACT_PANEL_WIDTH } from "./artifact-panel-state";

const artifact: ArtifactRef = {
  kind: "image",
  hash: "a".repeat(64),
  mimeType: "image/png",
  name: "screen.png",
  size: 1000,
};

test("renders toolbar, title, resize handle, close control, loading, empty, and error states", () => {
  let closed = 0;
  const { rerender } = render(
    <ArtifactPanel
      artifact={artifact}
      layout="push"
      width={520}
      onClose={() => (closed += 1)}
      srcOf={() => "mem://artifact"}
    />,
  );

  assert.ok(screen.getByLabelText("artifact workspace"));
  assert.ok(screen.getByText("screen.png"));
  assert.ok(screen.getByLabelText("Resize artifact panel"));
  fireEvent.click(screen.getByLabelText("Close artifact panel"));
  assert.equal(closed, 1);

  rerender(<ArtifactPanel artifact={null} layout="push" width={520} onClose={() => {}} />);
  assert.ok(screen.getByText("Select an artifact from the transcript to open it here."));

  rerender(
    <ArtifactPanel
      artifact={artifact}
      layout="push"
      width={520}
      loadStatus="loading"
      onClose={() => {}}
    />,
  );
  assert.ok(screen.getByText("loading artifact..."));

  rerender(
    <ArtifactPanel
      artifact={artifact}
      layout="push"
      width={520}
      loadStatus="error"
      onClose={() => {}}
    />,
  );
  assert.ok(screen.getByText(/could not be loaded/));
});

test("resizes within min and max constraints", () => {
  let width = 520;
  render(
    <ArtifactPanel
      artifact={artifact}
      layout="push"
      width={width}
      onClose={() => {}}
      onWidthChange={(next) => {
        width = next;
      }}
    />,
  );

  const handle = screen.getByLabelText("Resize artifact panel");
  fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 1200, pointerId: 1 });
  assert.equal(width, 520, "dragging previews locally without persisting every move");
  fireEvent.pointerUp(handle, { clientX: 1200, pointerId: 1 });
  assert.equal(width, ARTIFACT_PANEL_WIDTH.min);
  fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: -200, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: -200, pointerId: 1 });
  assert.equal(width, ARTIFACT_PANEL_WIDTH.max);
});

test("focuses the workspace and supports keyboard resize semantics", () => {
  let width = 520;
  render(
    <ArtifactPanel
      artifact={artifact}
      layout="push"
      width={width}
      onClose={() => {}}
      onWidthChange={(next) => {
        width = next;
      }}
    />,
  );

  assert.equal(document.activeElement, screen.getByLabelText("artifact workspace"));
  const handle = screen.getByLabelText("Resize artifact panel");
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  assert.equal(width, 544);
  fireEvent.keyDown(handle, { key: "Home" });
  assert.equal(width, ARTIFACT_PANEL_WIDTH.min);
  fireEvent.keyDown(handle, { key: "End" });
  assert.equal(width, ARTIFACT_PANEL_WIDTH.max);
});

import assert from "node:assert/strict";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import {
  ARTIFACT_PANEL_WIDTH,
  artifactId,
  closeArtifactPanel,
  createArtifactPanelState,
  openArtifactPanel,
  resetArtifactPanelPreference,
  resizeArtifactPanel,
  selectedArtifact,
  setArtifactPanelLayout,
} from "./artifact-panel-state";

const artifact: ArtifactRef = {
  kind: "image",
  hash: "a".repeat(64),
  mimeType: "image/png",
  name: "screen.png",
  size: 1200,
};

test("tracks selected artifact id, open state, layout, width, min, max, and reset", () => {
  const state = createArtifactPanelState({ layout: "overlap", width: 9000 });
  assert.equal(state.open, false);
  assert.equal(state.selectedArtifactId, null);
  assert.equal(state.preference.layout, "overlap");
  assert.equal(state.preference.width, ARTIFACT_PANEL_WIDTH.max);

  const opened = openArtifactPanel(state, { artifact, layout: "push", width: 100 });
  assert.equal(opened.open, true);
  assert.equal(opened.selectedArtifactId, artifactId(artifact));
  assert.equal(opened.preference.layout, "push");
  assert.equal(opened.preference.width, ARTIFACT_PANEL_WIDTH.min);

  const resized = resizeArtifactPanel(opened, 640);
  assert.equal(resized.preference.width, 640);

  const reset = resetArtifactPanelPreference(resized);
  assert.equal(reset.preference.layout, "push");
  assert.equal(reset.preference.width, ARTIFACT_PANEL_WIDTH.default);
});

test("switches artifacts, closes, reopens, and returns null for missing selected artifacts", () => {
  const second: ArtifactRef = { ...artifact, hash: "b".repeat(64), name: "other.png" };
  const state = createArtifactPanelState();
  const firstOpen = openArtifactPanel(state, { artifact });
  const secondOpen = openArtifactPanel(firstOpen, { artifact: second });

  assert.equal(selectedArtifact([artifact, second], secondOpen)?.name, "other.png");
  assert.equal(selectedArtifact([artifact], secondOpen), null);

  const closed = closeArtifactPanel(secondOpen);
  assert.equal(closed.open, false);
  assert.equal(closed.selectedArtifactId, artifactId(second));
  assert.equal(selectedArtifact([second], closed), null);

  const reopened = openArtifactPanel(closed, { artifact });
  assert.equal(reopened.open, true);
  assert.equal(reopened.selectedArtifactId, artifactId(artifact));
});

test("updates layout without coupling to transcript message state", () => {
  const state = openArtifactPanel(createArtifactPanelState(), { artifact });
  const next = setArtifactPanelLayout(state, "replace");

  assert.notEqual(next, state);
  assert.equal(next.selectedArtifactId, state.selectedArtifactId);
  assert.equal(next.open, state.open);
  assert.equal(next.preference.layout, "replace");
});

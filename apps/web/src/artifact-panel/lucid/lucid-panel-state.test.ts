import assert from "node:assert/strict";
import type { LucidAnchor } from "@trevor/session";
import { test } from "vitest";
import {
  applyLucidVersion,
  clearLucidQueue,
  commitLucidDraft,
  createLucidPanelState,
  deliverableLucidAnnotations,
  discardLucidDraft,
  editLucidDraftNote,
  hasPendingWork,
  lucidVersionArrived,
  orphanedLucidAnnotations,
  removeLucidQueued,
  setLucidReviewStatus,
  targetLucidElement,
} from "./lucid-panel-state";

const anchor = (id: string): LucidAnchor => ({ type: "element", lucidId: id });

function withQueued(id: string) {
  let state = createLucidPanelState({ lucidId: "p1", version: 1 });
  state = targetLucidElement(state, { anchor: anchor(id), snippet: `snip ${id}` });
  state = editLucidDraftNote(state, `note ${id}`);
  state = commitLucidDraft(state, id);
  return state;
}

test("target -> draft -> commit moves a composed annotation into the queue", () => {
  let state = createLucidPanelState({ lucidId: "p1", version: 1 });
  state = targetLucidElement(state, { anchor: anchor("hero"), snippet: "Ship it" });
  assert.ok(state.draft);
  assert.equal(state.draft?.note, "");
  // A note-less draft cannot commit.
  assert.equal(commitLucidDraft(state, "a1").queue.length, 0);
  state = editLucidDraftNote(state, "make it bolder");
  state = commitLucidDraft(state, "a1");
  assert.equal(state.draft, null);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0]?.version, 1, "authored against the current version");
});

test("discard and remove clear drafts and queued cards", () => {
  let state = withQueued("a1");
  assert.equal(removeLucidQueued(state, "a1").queue.length, 0);
  state = targetLucidElement(state, { anchor: anchor("x"), snippet: "s" });
  assert.equal(discardLucidDraft(state).draft, null);
});

test("hasPendingWork ignores a bare selection but counts a noted draft or a queued card", () => {
  let state = createLucidPanelState({ lucidId: "p1", version: 1 });
  state = targetLucidElement(state, { anchor: anchor("x"), snippet: "s" });
  assert.equal(hasPendingWork(state), false, "a bare selection is not pending work");
  state = editLucidDraftNote(state, "note");
  assert.equal(hasPendingWork(state), true);
  assert.equal(hasPendingWork(withQueued("a1")), true);
});

test("a new version swaps live with no pending work, dropping a stale bare draft", () => {
  let state = createLucidPanelState({ lucidId: "p1", version: 1 });
  state = targetLucidElement(state, { anchor: anchor("x"), snippet: "s" }); // bare draft
  state = lucidVersionArrived(state, 2);
  assert.equal(state.version, 2);
  assert.equal(state.pendingVersion, null);
  assert.equal(state.draft, null, "a stale bare draft is dropped on a live swap");
  // A stale/equal version is ignored.
  assert.equal(lucidVersionArrived(state, 2).version, 2);
});

test("a new version DEFERS while pending work exists, then applies with orphan re-resolution", () => {
  let state = withQueued("a1");
  state = withQueuedInto(state, "a2");
  state = lucidVersionArrived(state, 2);
  assert.equal(state.version, 1, "swap deferred, artifact stays live at v1");
  assert.equal(state.pendingVersion, 2);

  // The overlay re-resolves against v2 and reports a1 as no longer attachable.
  state = applyLucidVersion(state, 2, ["a1"]);
  assert.equal(state.version, 2);
  assert.equal(state.pendingVersion, null);
  assert.deepEqual(
    orphanedLucidAnnotations(state).map((q) => q.annotationId),
    ["a1"],
  );
  assert.deepEqual(
    deliverableLucidAnnotations(state).map((q) => q.annotationId),
    ["a2"],
    "only non-orphaned annotations are deliverable",
  );
});

test("delivery clears the queue; review status toggles resolved/open", () => {
  let state = withQueued("a1");
  state = clearLucidQueue(state);
  assert.equal(state.queue.length, 0);
  state = setLucidReviewStatus(state, "resolved");
  assert.equal(state.reviewStatus, "resolved");
  state = setLucidReviewStatus(state, "open");
  assert.equal(state.reviewStatus, "open");
});

/** Appends a second committed annotation into an existing state (helper for the defer test). */
function withQueuedInto(state: ReturnType<typeof createLucidPanelState>, id: string) {
  let next = targetLucidElement(state, { anchor: anchor(id), snippet: `snip ${id}` });
  next = editLucidDraftNote(next, `note ${id}`);
  return commitLucidDraft(next, id);
}

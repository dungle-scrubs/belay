import assert from "node:assert/strict";
import type { LucidAnchor } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import { LucidChrome } from "./lucid-chrome";
import {
  commitLucidDraft,
  createLucidPanelState,
  editLucidDraftNote,
  type LucidPanelState,
  targetLucidElement,
} from "./lucid-panel-state";

const anchor = (id: string): LucidAnchor => ({ type: "element", lucidId: id });

const noop = () => {};

function baseProps(state: LucidPanelState) {
  return {
    state,
    delivered: null,
    onEditNote: noop,
    onCommit: noop,
    onDiscard: noop,
    onRemoveQueued: noop,
    onDeliver: noop,
    onApplyVersion: noop,
    onResolve: noop,
    onReopen: noop,
  };
}

function queued(id: string, state = createLucidPanelState({ lucidId: "p1", version: 1 })) {
  let next = targetLucidElement(state, { anchor: anchor(id), snippet: `snippet ${id}` });
  next = editLucidDraftNote(next, `note ${id}`);
  return commitLucidDraft(next, id);
}

test("shows the composer when a target is drafted and gates the add button on a note", () => {
  const state = targetLucidElement(createLucidPanelState({ lucidId: "p1", version: 1 }), {
    anchor: anchor("hero"),
    snippet: "Ship on Friday",
  });
  render(<LucidChrome {...baseProps(state)} />);
  assert.ok(screen.getByLabelText("Annotation note"));
  assert.ok(screen.getByText(/Ship on Friday/));
  const add = screen.getByRole("button", { name: /add/i });
  assert.equal((add as HTMLButtonElement).disabled, true, "no note => cannot add");
});

test("renders queued annotations and enables sending them to the agent", () => {
  const state = queued("a1");
  let delivered = 0;
  render(<LucidChrome {...baseProps(state)} onDeliver={() => (delivered += 1)} />);
  assert.ok(screen.getByLabelText("Queued annotations"));
  assert.ok(screen.getByText("note a1"));
  const send = screen.getByRole("button", { name: /send/i });
  assert.equal((send as HTMLButtonElement).disabled, false);
  fireEvent.click(send);
  assert.equal(delivered, 1);
});

test("shows the orphan tray after a version swap orphans an annotation (M4/M6)", () => {
  let state = queued("a1");
  state = { ...state, version: 2, queue: state.queue.map((q) => ({ ...q, orphaned: true })) };
  render(<LucidChrome {...baseProps(state)} />);
  assert.ok(screen.getByLabelText("Orphaned annotations"));
  assert.ok(screen.getByText(/orphaned · 1/));
  // An orphaned-only queue has nothing deliverable.
  assert.equal((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled, true);
});

test("surfaces a deferred newer version as a non-blocking reload banner (M6)", () => {
  let state = queued("a1");
  state = { ...state, pendingVersion: 2 };
  let reloaded = 0;
  render(<LucidChrome {...baseProps(state)} onApplyVersion={() => (reloaded += 1)} />);
  assert.ok(screen.getByText(/version 2 is ready/));
  fireEvent.click(screen.getByRole("button", { name: /reload/i }));
  assert.equal(reloaded, 1);
});

test("review controls toggle between approve and reopen (M6)", () => {
  let resolved = 0;
  let reopened = 0;
  const open = createLucidPanelState({ lucidId: "p1", version: 1 });
  const { rerender } = render(
    <LucidChrome {...baseProps(open)} onResolve={() => (resolved += 1)} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /approve/i }));
  assert.equal(resolved, 1);

  const approved = createLucidPanelState({ lucidId: "p1", version: 1, reviewStatus: "resolved" });
  rerender(<LucidChrome {...baseProps(approved)} onReopen={() => (reopened += 1)} />);
  assert.ok(screen.getByText(/approved/));
  fireEvent.click(screen.getByRole("button", { name: /reopen review/i }));
  assert.equal(reopened, 1);
});

test("renders delivered feedback count as history, distinct from the pending queue", () => {
  const state = createLucidPanelState({ lucidId: "p1", version: 2 });
  render(
    <LucidChrome
      {...baseProps(state)}
      delivered={{
        lucidId: "p1",
        version: 2,
        htmlHash: "a".repeat(64),
        provenance: "agent",
        reviewStatus: "open",
        annotations: [
          { annotationId: "d1", anchor: anchor("x"), snippet: "s", note: "n" },
          { annotationId: "d2", anchor: anchor("y"), snippet: "s", note: "n" },
        ],
        lastCursor: 1,
      }}
    />,
  );
  assert.ok(screen.getByText(/2 delivered/));
});

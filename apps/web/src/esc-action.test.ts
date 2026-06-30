import { describe, expect, it } from "vitest";
import { type EscState, escapeAction } from "./esc-action";

const base: EscState = {
  active: null,
  awaiting: false,
  compacting: false,
  draft: "",
  modalOpen: false,
  handoffPending: false,
  queued: 0,
};

describe("escapeAction", () => {
  // The reported bug: opening the worktree (or resume / command) picker and pressing Escape to
  // close it ALSO cancelled the in-flight turn on the transcript behind the modal.
  it("does NOT cancel an in-flight run while a modal owns Escape", () => {
    expect(escapeAction({ ...base, active: "run-1", modalOpen: true })).toBe("none");
    expect(escapeAction({ ...base, awaiting: true, modalOpen: true })).toBe("none");
    expect(escapeAction({ ...base, compacting: true, modalOpen: true })).toBe("none");
    expect(escapeAction({ ...base, draft: "half typed", modalOpen: true })).toBe("none");
  });

  // An open modal owns Escape even with queued prompts behind it - it must close, not steer.
  it("does NOT flush queued steer while a modal owns Escape", () => {
    expect(escapeAction({ ...base, active: "run-1", queued: 2, modalOpen: true })).toBe("none");
  });

  it("cancels an active run, an awaiting turn, or a manual fold when the queue is empty", () => {
    expect(escapeAction({ ...base, active: "run-1" })).toBe("cancel");
    expect(escapeAction({ ...base, awaiting: true })).toBe("cancel");
    expect(escapeAction({ ...base, compacting: true })).toBe("cancel");
  });

  // The handoff approval/generating surface is a composer takeover; Escape dismisses it (which also
  // escapes a stuck "Drafting…" whose host died), but a modal over it still wins.
  it("dismisses a pending handoff, ahead of cancel/draft but behind a modal", () => {
    expect(escapeAction({ ...base, handoffPending: true })).toBe("dismiss-handoff");
    expect(escapeAction({ ...base, handoffPending: true, draft: "x" })).toBe("dismiss-handoff");
    expect(escapeAction({ ...base, handoffPending: true, modalOpen: true })).toBe("none");
  });

  // D-001: queued steering wins over cancel on the first press. With work in progress and a
  // non-empty queue, Escape folds the queue into one steering prompt instead of cancelling.
  it("flushes queued steer (not cancel) on the first Escape with queued prompts", () => {
    expect(escapeAction({ ...base, active: "run-1", queued: 1 })).toBe("flush-queued-steer");
    expect(escapeAction({ ...base, active: "run-1", queued: 3 })).toBe("flush-queued-steer");
    expect(escapeAction({ ...base, awaiting: true, queued: 2 })).toBe("flush-queued-steer");
    expect(escapeAction({ ...base, compacting: true, queued: 2 })).toBe("flush-queued-steer");
  });

  // After the flush empties the queue, the deliberate second Escape cancels the still-active turn.
  it("cancels once the queue has been flushed (queued back to zero)", () => {
    expect(escapeAction({ ...base, active: "run-1", queued: 0 })).toBe("cancel");
    expect(escapeAction({ ...base, awaiting: true, queued: 0 })).toBe("cancel");
  });

  // Queued prompts with nothing in progress are not a steer target - there is no turn to steer.
  it("ignores a queue when no run or fold is in progress", () => {
    expect(escapeAction({ ...base, queued: 2 })).toBe("none");
    expect(escapeAction({ ...base, queued: 2, draft: "hi" })).toBe("clear-draft");
  });

  it("clears the draft only when there is nothing to cancel", () => {
    expect(escapeAction({ ...base, draft: "hello" })).toBe("clear-draft");
    // a run to cancel wins over clearing the draft
    expect(escapeAction({ ...base, active: "run-1", draft: "hello" })).toBe("cancel");
  });

  it("does nothing with no run, no fold, and an empty draft", () => {
    expect(escapeAction(base)).toBe("none");
  });
});

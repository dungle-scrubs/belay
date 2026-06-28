import { describe, expect, it } from "vitest";
import { type EscState, escapeAction } from "./esc-action";

const base: EscState = {
  active: null,
  awaiting: false,
  compacting: false,
  draft: "",
  modalOpen: false,
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

  it("cancels an active run, an awaiting turn, or a manual fold when no modal is open", () => {
    expect(escapeAction({ ...base, active: "run-1" })).toBe("cancel");
    expect(escapeAction({ ...base, awaiting: true })).toBe("cancel");
    expect(escapeAction({ ...base, compacting: true })).toBe("cancel");
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

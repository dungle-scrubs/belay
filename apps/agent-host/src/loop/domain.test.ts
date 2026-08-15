import type { LoopSpec } from "@belay/session";
import { describe, expect, it } from "vitest";
import {
  cancelLoop,
  completeLoop,
  confirmLoop,
  createLoop,
  deleteLoop,
  failLoop,
  isActivatableLoop,
  isBoundedLoop,
  type LoopState,
  pauseLoop,
  recordIteration,
  requestConfirmation,
  resumeLoop,
  stopLoop,
} from "./domain";

/**
 * The pure `/loop` lifecycle state machine (plan 17, M4): legal transitions, stop reasons, the bounded-work
 * activation rule, and guards that reject illegal transitions with an explainable reason.
 */

const bounded: LoopSpec = {
  runner: "current_session_prompt",
  durability: "session",
  action: "run the tests",
  max: 3,
};

/** Advances a fresh draft to `running` (the common precondition for the active-state tests). */
function running(spec: LoopSpec = bounded): LoopState {
  const confirmed = requestConfirmation(createLoop("loop_1", spec));
  if (!confirmed.ok) {
    throw new Error(confirmed.reason);
  }
  const started = confirmLoop(confirmed.state);
  if (!started.ok) {
    throw new Error(started.reason);
  }
  return started.state;
}

describe("loop activation rules (M4)", () => {
  it("requires an action AND at least one bound", () => {
    expect(isActivatableLoop(bounded)).toBe(true);
    expect(isBoundedLoop(bounded)).toBe(true);
    expect(isActivatableLoop({ ...bounded, action: "   " })).toBe(false);
    expect(isActivatableLoop({ runner: "process", durability: "session", action: "curl x" })).toBe(
      false,
    ); // no bound
  });

  it("accepts every kind of bound as sufficient", () => {
    const base = { runner: "process", durability: "session", action: "x" } as const;
    expect(isBoundedLoop({ ...base, max: 2 })).toBe(true);
    expect(isBoundedLoop({ ...base, everyMs: 1000 })).toBe(true);
    expect(isBoundedLoop({ ...base, until: "done" })).toBe(true);
    expect(isBoundedLoop({ ...base, timeoutMs: 5000 })).toBe(true);
    expect(isBoundedLoop(base)).toBe(false);
  });

  it("rejects a process loop bounded ONLY by until (it cannot judge the condition), but allows a co-bound", () => {
    const proc = { runner: "process", durability: "session", action: "curl x" } as const;
    // until alone: a process can't detect it, so it would never self-terminate -> not activatable.
    expect(isActivatableLoop({ ...proc, until: "healthy" })).toBe(false);
    // until PLUS a deterministic bound is fine.
    expect(isActivatableLoop({ ...proc, until: "healthy", max: 10 })).toBe(true);
    expect(isActivatableLoop({ ...proc, until: "healthy", timeoutMs: 60_000 })).toBe(true);
    // A prompt/background loop CAN judge until (the runner signals), so until-only is allowed there.
    expect(
      isActivatableLoop({
        runner: "current_session_prompt",
        durability: "session",
        action: "check",
        until: "green",
      }),
    ).toBe(true);
  });
});

describe("loop confirmation path (M4)", () => {
  it("draft -> pending -> running", () => {
    const draft = createLoop("loop_1", bounded);
    expect(draft.status).toBe("draft");
    const pending = requestConfirmation(draft);
    expect(pending.ok && pending.state.status).toBe("pending");
    const started = pending.ok ? confirmLoop(pending.state) : { ok: false as const, reason: "" };
    expect(started.ok && started.state.status).toBe("running");
  });

  it("refuses to confirm an unbounded/actionless draft", () => {
    const draft = createLoop("loop_1", {
      runner: "process",
      durability: "session",
      action: "x",
    });
    const result = requestConfirmation(draft);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("at least one of");
  });

  it("cancel from draft or pending soft-deletes (never ran)", () => {
    expect(cancelLoop(createLoop("l", bounded)).ok).toBe(true);
    const pending = requestConfirmation(createLoop("l", bounded));
    const cancelled = pending.ok ? cancelLoop(pending.state) : { ok: false as const, reason: "" };
    expect(cancelled.ok && cancelled.state.status).toBe("deleted");
  });
});

describe("loop active-state transitions (M4)", () => {
  it("pause and resume toggle between running and paused", () => {
    const paused = pauseLoop(running());
    expect(paused.ok && paused.state.status).toBe("paused");
    const resumed = paused.ok ? resumeLoop(paused.state) : { ok: false as const, reason: "" };
    expect(resumed.ok && resumed.state.status).toBe("running");
  });

  it("stop marks stopped with the `stopped` reason", () => {
    const stopped = stopLoop(running());
    expect(stopped.ok && stopped.state.status).toBe("stopped");
    expect(stopped.ok && stopped.state.stopReason).toBe("stopped");
  });

  it("complete carries a bound-driven reason", () => {
    const done = completeLoop(running(), "until_satisfied");
    expect(done.ok && done.state.status).toBe("completed");
    expect(done.ok && done.state.stopReason).toBe("until_satisfied");
  });

  it("fail marks failed with the error and the error reason", () => {
    const failed = failLoop(running(), "boom");
    expect(failed.ok && failed.state.status).toBe("failed");
    expect(failed.ok && failed.state.stopReason).toBe("error");
    expect(failed.ok && failed.state.error).toBe("boom");
  });
});

describe("loop iteration + max auto-completion (M4)", () => {
  it("counts iterations and auto-completes at max", () => {
    let state = running({ ...bounded, max: 2 });
    const first = recordIteration(state);
    expect(first.ok && first.state.completed).toBe(1);
    expect(first.ok && first.state.status).toBe("running");
    state = first.ok ? first.state : state;
    const second = recordIteration(state);
    expect(second.ok && second.state.completed).toBe(2);
    expect(second.ok && second.state.status).toBe("completed");
    expect(second.ok && second.state.stopReason).toBe("max_iterations");
  });

  it("a cadence loop with no max keeps running across iterations", () => {
    const state = running({ runner: "process", durability: "session", action: "x", everyMs: 1000 });
    const next = recordIteration(state);
    expect(next.ok && next.state.status).toBe("running");
    expect(next.ok && next.state.completed).toBe(1);
  });
});

describe("loop guards reject illegal transitions (M4)", () => {
  it("cannot pause a draft, resume a running, or iterate a paused loop", () => {
    expect(pauseLoop(createLoop("l", bounded)).ok).toBe(false);
    expect(resumeLoop(running()).ok).toBe(false);
    const paused = pauseLoop(running());
    const iterated = paused.ok ? recordIteration(paused.state) : { ok: true as const };
    expect(iterated.ok).toBe(false);
  });

  it("re-deleting a terminal loop is rejected", () => {
    const stopped = stopLoop(running());
    const deleted = stopped.ok ? deleteLoop(stopped.state) : { ok: false as const, reason: "" };
    expect(deleted.ok && deleted.state.status).toBe("deleted");
    const again = deleted.ok ? deleteLoop(deleted.state) : { ok: true as const };
    expect(again.ok).toBe(false);
  });
});

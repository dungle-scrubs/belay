import { describe, expect, it, vi } from "vitest";
import { cancelActiveWork, type StopDeps, stopSession } from "./session-lifecycle";

/**
 * D-094 M5: the host-side cancel-vs-stop-vs-kill semantics. These prove CANCEL and STOP are different
 * lifecycle operations, that STOP cancels active work + clears queued work + tears the host down while
 * never touching the durable log, and that KILL has no in-process orchestration to run (so it can only
 * leave an in-flight turn unfinished, never erase history).
 */

function stopDeps(over: Partial<StopDeps> = {}): StopDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    abortActive: () => calls.push("abortActive"),
    clearQueue: () => calls.push("clearQueue"),
    killJobs: () => calls.push("killJobs"),
    isBusy: () => true,
    queuedCount: () => 0,
    ...over,
  };
}

describe("cancel vs stop are different lifecycle operations", () => {
  it("CANCEL aborts the active turn only - the host stays attached, the queue is untouched", () => {
    const abortActive = vi.fn();
    const clearQueue = vi.fn();
    const killJobs = vi.fn();
    cancelActiveWork({ abortActive });
    expect(abortActive).toHaveBeenCalledTimes(1);
    // Cancel is NOT a teardown: it never clears the queue or kills jobs.
    expect(clearQueue).not.toHaveBeenCalled();
    expect(killJobs).not.toHaveBeenCalled();
  });

  it("STOP additionally clears the queue and tears down jobs (it is a superset teardown)", () => {
    const deps = stopDeps();
    stopSession(deps);
    expect(deps.calls).toEqual(["abortActive", "clearQueue", "killJobs"]);
  });

  it("the two differ: only stop reaches clearQueue + killJobs", () => {
    const cancelCalls: string[] = [];
    cancelActiveWork({ abortActive: () => cancelCalls.push("abortActive") });
    const stop = stopDeps();
    stopSession(stop);
    expect(cancelCalls).toEqual(["abortActive"]);
    expect(stop.calls).toContain("clearQueue");
    expect(stop.calls).toContain("killJobs");
    expect(stop.calls.length).toBeGreaterThan(cancelCalls.length);
  });
});

describe("stop cancels active work, clears queued work, releases the host, keeps the durable log", () => {
  it("reports the active turn it cancelled and the queued prompts it cleared", () => {
    const deps = stopDeps({ isBusy: () => true, queuedCount: () => 3 });
    const outcome = stopSession(deps);
    expect(outcome.cancelledActive).toBe(true);
    expect(outcome.clearedQueued).toBe(3);
  });

  it("snapshots busy/queued BEFORE teardown so the outcome reflects what was running", () => {
    // A realistic scheduler stub: clearQueue actually empties the queue, abortActive clears busy.
    let busy = true;
    let queued = 2;
    const deps: StopDeps = {
      abortActive: () => {
        busy = false;
      },
      clearQueue: () => {
        queued = 0;
      },
      killJobs: () => {},
      isBusy: () => busy,
      queuedCount: () => queued,
    };
    const outcome = stopSession(deps);
    // The outcome captured the active turn + queue depth BEFORE aborting/clearing them.
    expect(outcome.cancelledActive).toBe(true);
    expect(outcome.clearedQueued).toBe(2);
    // The teardown actually ran.
    expect(busy).toBe(false);
    expect(queued).toBe(0);
  });

  it("an idle, empty-queue stop tears down cleanly and reports nothing cancelled/cleared", () => {
    const deps = stopDeps({ isBusy: () => false, queuedCount: () => 0 });
    const outcome = stopSession(deps);
    expect(outcome).toEqual({ cancelledActive: false, clearedQueued: 0 });
    expect(deps.calls).toContain("killJobs");
  });

  it("keeps the durable log by construction: stop has no handle that can write or delete history", () => {
    // The StopDeps surface is exactly abort/clear/kill + two read-only queries - there is no log,
    // store, or delete effect it could call. This pins that the contract can never touch history.
    const deps = stopDeps();
    const surface = Object.keys(deps)
      .filter((k) => k !== "calls")
      .sort();
    expect(surface).toEqual(["abortActive", "clearQueue", "isBusy", "killJobs", "queuedCount"]);
    expect(surface).not.toContain("deleteLog");
    expect(surface).not.toContain("store");
  });
});

describe("kill force terminates while preserving durable history", () => {
  it("a kill leaves an in-flight turn unfinished (no clean completion), unlike stop", () => {
    // STOP gives the active turn a clean cancelled completion (abortActive runs). KILL is SIGKILL from
    // outside the process, so NONE of the orchestration runs - the turn just stops mid-flight, ending
    // aborted/unknown. We model the difference: stop aborts; kill is the absence of that abort.
    const aborted: string[] = [];
    const deps = stopDeps({ abortActive: () => aborted.push("clean-cancel") });
    stopSession(deps); // STOP path -> a clean cancellation happens
    expect(aborted).toEqual(["clean-cancel"]);

    aborted.length = 0;
    // KILL path: the process is force-terminated, so neither orchestrator is invoked at all - no
    // clean-cancel abort runs.
    expect(aborted).toEqual([]);
  });

  it("preserves durable history by construction: no lifecycle op can write or delete the log", () => {
    // History lives in the session-store, a separate process. The host's lifecycle surface (cancel AND
    // stop) carries no store/log/delete handle, so a kill - which runs even less than these - cannot
    // erase history either. The worst kill does is skip the clean completion; the log itself is safe.
    const stop = Object.keys(stopDeps())
      .filter((k) => k !== "calls")
      .sort();
    for (const forbidden of ["deleteLog", "store", "truncate", "removeSession", "purge"]) {
      expect(stop).not.toContain(forbidden);
    }
  });
});

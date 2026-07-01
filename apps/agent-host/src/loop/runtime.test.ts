import type { LoopSnapshot } from "@trevor/session";
import { describe, expect, it } from "vitest";
import type { LoopIterationRunner } from "./runner";
import { LoopScheduler, type SchedulerClock } from "./scheduler";
import { LoopStore } from "./store";

/**
 * The loop runtime (plan 17, M6): a confirmed loop schedules + runs iterations, honors cadence/max/until/
 * timeout bounds, and responds to the control surface (pause/resume/stop/delete/run-now). Driven by a manual
 * async clock + a fake runner so cadence and lifecycle are deterministic without real waits.
 */

/** Flush pending microtasks so an async iteration settles + reschedules before the clock advances again. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A manual clock whose timers fire only when the test advances time, awaiting async work between fires. */
class AsyncClock implements SchedulerClock {
  private t = 0;
  private nextId = 0;
  private timers: { id: number; at: number; cb: () => void }[] = [];

  now(): number {
    return this.t;
  }

  setTimer(ms: number, cb: () => void): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, cb });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (let guard = 0; guard < 1000; guard++) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.t = due.at;
      due.cb();
      await flush();
    }
    this.t = target;
  }

  activeTimers(): number {
    return this.timers.length;
  }
}

/** A fake iteration runner: records call count; optionally fails or signals `until` satisfied on call N. */
function fakeRunner(opts: { fail?: boolean; conditionMetOnCall?: number } = {}): {
  runner: LoopIterationRunner;
  count: () => number;
} {
  let calls = 0;
  return {
    count: () => calls,
    runner: {
      run: async () => {
        calls += 1;
        if (opts.fail) {
          return { ok: false, summary: "boom", error: "boom" };
        }
        const conditionMet =
          opts.conditionMetOnCall !== undefined && calls >= opts.conditionMetOnCall;
        return { ok: true, summary: "ran", ...(conditionMet ? { conditionMet: true } : {}) };
      },
    },
  };
}

function makeStore(
  clock: AsyncClock,
  runner: LoopIterationRunner,
): { store: LoopStore; events: LoopSnapshot[] } {
  const events: LoopSnapshot[] = [];
  let n = 0;
  const store = new LoopStore({
    emit: (snapshot) => events.push(snapshot),
    makeId: () => `loop_${(n += 1)}`,
    runner,
    scheduler: new LoopScheduler(clock),
  });
  return { store, events };
}

describe("loop cadence scheduling (M6)", () => {
  it("runs a cadence loop on its interval, one timer per loop, completing at max", async () => {
    const clock = new AsyncClock();
    const { runner, count } = fakeRunner();
    const { store } = makeStore(clock, runner);
    store.submit('/loop every 100ms max 3 do "tick"');
    store.confirm("loop_1");
    expect(clock.activeTimers()).toBe(1); // exactly one pending timer

    await clock.advance(100);
    expect(count()).toBe(1);
    expect(store.get("loop_1")?.completed).toBe(1);
    expect(clock.activeTimers()).toBe(1); // still exactly one

    await clock.advance(100);
    await clock.advance(100);
    expect(count()).toBe(3);
    expect(store.get("loop_1")?.status).toBe("completed");
    expect(store.get("loop_1")?.stopReason).toBe("max_iterations");
    expect(clock.activeTimers()).toBe(0); // terminal: no timer left
  });

  it("publishes the next-run time on a running cadence snapshot", async () => {
    const clock = new AsyncClock();
    const { store, events } = makeStore(clock, fakeRunner().runner);
    store.submit('/loop every 5s max 2 do "x"');
    store.confirm("loop_1");
    expect(events.at(-1)?.nextRun).toBe(5000);
  });

  it("runs a continuous (no-cadence) loop back-to-back until max", async () => {
    const clock = new AsyncClock();
    const { runner, count } = fakeRunner();
    const { store } = makeStore(clock, runner);
    store.submit('/loop max 3 do "x"');
    store.confirm("loop_1");
    await clock.advance(0); // delay-0 reschedules fire within the same instant
    expect(count()).toBe(3);
    expect(store.get("loop_1")?.status).toBe("completed");
  });
});

describe("loop bound handling (M6)", () => {
  it("completes with timeout when the wall-clock deadline is reached", async () => {
    const clock = new AsyncClock();
    const { runner, count } = fakeRunner();
    const { store } = makeStore(clock, runner);
    store.submit('/loop every 20ms timeout 50ms do "x"');
    store.confirm("loop_1");
    await clock.advance(50);
    expect(store.get("loop_1")?.status).toBe("completed");
    expect(store.get("loop_1")?.stopReason).toBe("timeout");
    // Two iterations ran at 20ms and 40ms; the 50ms fire hit the deadline instead.
    expect(count()).toBe(2);
  });

  it("completes with until_satisfied when the runner signals the condition met", async () => {
    const clock = new AsyncClock();
    const { runner, count } = fakeRunner({ conditionMetOnCall: 2 });
    const { store } = makeStore(clock, runner);
    store.submit('/loop until "done" do "x"');
    store.confirm("loop_1");
    await clock.advance(0);
    expect(count()).toBe(2); // ran twice; the 2nd signalled done
    expect(store.get("loop_1")?.status).toBe("completed");
    expect(store.get("loop_1")?.stopReason).toBe("until_satisfied");
  });

  it("fails the loop when an iteration errors", async () => {
    const clock = new AsyncClock();
    const { store } = makeStore(clock, fakeRunner({ fail: true }).runner);
    store.submit('/loop max 3 do "x"');
    store.confirm("loop_1");
    await clock.advance(0);
    expect(store.get("loop_1")?.status).toBe("failed");
    expect(store.get("loop_1")?.error).toBe("boom");
  });
});

describe("loop controls (M6)", () => {
  it("pause cancels the timer and resume reschedules it", async () => {
    const clock = new AsyncClock();
    const { store } = makeStore(clock, fakeRunner().runner);
    store.submit('/loop every 100ms max 9 do "x"');
    store.confirm("loop_1");
    expect(store.pause("loop_1").ok).toBe(true);
    expect(store.get("loop_1")?.status).toBe("paused");
    expect(clock.activeTimers()).toBe(0);
    // Time passing while paused runs nothing.
    await clock.advance(1000);
    expect(store.get("loop_1")?.completed).toBe(0);
    expect(store.resume("loop_1").ok).toBe(true);
    expect(clock.activeTimers()).toBe(1);
  });

  it("stop and delete cancel the timer and reach a terminal status", async () => {
    const clock = new AsyncClock();
    const { store } = makeStore(clock, fakeRunner().runner);
    store.submit('/loop every 100ms max 9 do "x"');
    store.confirm("loop_1");
    expect(store.stop("loop_1").ok).toBe(true);
    expect(store.get("loop_1")?.status).toBe("stopped");
    expect(clock.activeTimers()).toBe(0);
    expect(store.delete("loop_1").ok).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("run-now fires an iteration immediately, then the cadence continues", async () => {
    const clock = new AsyncClock();
    const { runner, count } = fakeRunner();
    const { store } = makeStore(clock, runner);
    store.submit('/loop every 1h max 9 do "x"');
    store.confirm("loop_1");
    expect(count()).toBe(0); // nothing has run; next cadence fire is an hour out
    store.runNow("loop_1");
    await clock.advance(0);
    expect(count()).toBe(1); // ran now, pre-empting the wait
    expect(store.get("loop_1")?.completed).toBe(1);
    // The cadence timer is back for the next hourly run.
    expect(clock.activeTimers()).toBe(1);
  });

  it("rejects run-now on a non-running loop", () => {
    const clock = new AsyncClock();
    const { store } = makeStore(clock, fakeRunner().runner);
    store.submit('/loop every 1h max 9 do "x"'); // pending, not running
    expect(store.runNow("loop_1").ok).toBe(false);
  });
});

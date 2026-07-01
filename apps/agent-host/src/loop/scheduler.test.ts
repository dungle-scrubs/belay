import { describe, expect, it } from "vitest";
import { LoopScheduler, type SchedulerClock } from "./scheduler";

/**
 * The loop scheduler (plan 17, M6): exactly one active timer per loop, deterministic next-run math, and
 * clean cancellation. Driven by a manual clock so cadence is testable without real waits.
 */

/** A manual clock: timers fire only when the test advances time. */
class ManualClock implements SchedulerClock {
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

  /** Advance to `t + ms`, firing every timer due at or before it in time order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.t = due.at;
      due.cb();
    }
    this.t = target;
  }

  pendingCount(): number {
    return this.timers.length;
  }
}

describe("loop scheduler (M6)", () => {
  it("keeps exactly one active timer per loop across reschedules", () => {
    const clock = new ManualClock();
    const scheduler = new LoopScheduler(clock);
    let fires = 0;
    scheduler.schedule("loop_1", 100, () => fires++);
    scheduler.schedule("loop_1", 100, () => fires++); // reschedule replaces, does not add
    expect(scheduler.activeTimerCount()).toBe(1);
    expect(clock.pendingCount()).toBe(1);
    clock.advance(100);
    expect(fires).toBe(1);
    // After firing, the timer is gone (until rescheduled).
    expect(scheduler.activeTimerCount()).toBe(0);
  });

  it("computes next-run as now + delay and clears it on fire", () => {
    const clock = new ManualClock();
    const scheduler = new LoopScheduler(clock);
    scheduler.schedule("loop_1", 5000, () => {});
    expect(scheduler.nextRunAt("loop_1")).toBe(5000);
    expect(scheduler.isScheduled("loop_1")).toBe(true);
    clock.advance(5000);
    expect(scheduler.nextRunAt("loop_1")).toBeUndefined();
  });

  it("cancel stops a pending timer and is idempotent", () => {
    const clock = new ManualClock();
    const scheduler = new LoopScheduler(clock);
    let fired = false;
    scheduler.schedule("loop_1", 100, () => {
      fired = true;
    });
    scheduler.cancel("loop_1");
    scheduler.cancel("loop_1"); // idempotent
    clock.advance(1000);
    expect(fired).toBe(false);
    expect(scheduler.activeTimerCount()).toBe(0);
  });

  it("tracks independent timers for different loops", () => {
    const clock = new ManualClock();
    const scheduler = new LoopScheduler(clock);
    scheduler.schedule("loop_1", 100, () => {});
    scheduler.schedule("loop_2", 200, () => {});
    expect(scheduler.activeTimerCount()).toBe(2);
    clock.advance(100);
    expect(scheduler.activeTimerCount()).toBe(1);
    expect(scheduler.isScheduled("loop_2")).toBe(true);
  });
});

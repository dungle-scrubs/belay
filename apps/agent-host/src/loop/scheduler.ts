/**
 * The `/loop` SCHEDULER (plan 17, M6): owns the ONE active timer per loop and the next-run clock. A cadence
 * (`every`) loop fires on its interval; a continuous loop (a bound with no cadence) reschedules with a zero
 * delay so iterations run back-to-back. Either way there is exactly one pending timer per loop id - a
 * (re)schedule always cancels the prior one - so a loop can never double-fire or leak a timer. Time is
 * injected ({@link SchedulerClock}) so cadence + next-run are deterministically testable without real waits.
 */

/** The injectable time source: a cancelable timer and a monotonic clock. */
export interface SchedulerClock {
  /** Runs `cb` after `ms`; returns a canceller. */
  setTimer(ms: number, cb: () => void): () => void;
  /** Epoch milliseconds now. */
  now(): number;
}

/** The real clock: an unref'd setTimeout (never keeps the host alive on a loop timer alone) + Date.now. */
export const defaultSchedulerClock: SchedulerClock = {
  setTimer(ms, cb) {
    const timer = setTimeout(cb, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
};

export class LoopScheduler {
  private readonly cancellers = new Map<string, () => void>();
  private readonly nextRun = new Map<string, number>();

  constructor(private readonly clock: SchedulerClock = defaultSchedulerClock) {}

  /**
   * Schedule `fire` for `loopId` after `ms`, REPLACING any pending timer (the one-timer-per-loop invariant).
   * The next-run time is recorded for status/persistence and cleared when the timer fires.
   */
  schedule(loopId: string, ms: number, fire: () => void): void {
    this.cancel(loopId);
    this.nextRun.set(loopId, this.clock.now() + ms);
    this.cancellers.set(
      loopId,
      this.clock.setTimer(ms, () => {
        this.cancellers.delete(loopId);
        this.nextRun.delete(loopId);
        fire();
      }),
    );
  }

  /** Cancel a loop's pending timer (idempotent). */
  cancel(loopId: string): void {
    const canceller = this.cancellers.get(loopId);
    if (canceller !== undefined) {
      canceller();
    }
    this.cancellers.delete(loopId);
    this.nextRun.delete(loopId);
  }

  /** Epoch milliseconds now (delegates to the injected clock), for deadline math against `nextRunAt`. */
  now(): number {
    return this.clock.now();
  }

  /** The epoch-ms time a loop is next scheduled to fire, or undefined when it has no pending timer. */
  nextRunAt(loopId: string): number | undefined {
    return this.nextRun.get(loopId);
  }

  /** Whether a loop currently has a pending timer. */
  isScheduled(loopId: string): boolean {
    return this.cancellers.has(loopId);
  }

  /** The number of pending timers across all loops (a leaked/duplicate timer would show up here). */
  activeTimerCount(): number {
    return this.cancellers.size;
  }
}

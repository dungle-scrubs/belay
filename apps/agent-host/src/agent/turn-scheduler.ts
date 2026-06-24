import type { SessionEvent } from "@trevor/session";

/** A turn in flight: its run id and a function to abort it (interrupts its fiber). */
export interface ActiveTurn {
  readonly runId: string;
  readonly cancel: () => void;
}

export interface TurnSchedulerDeps {
  /** True when this host holds the lease - only the leader starts turns. */
  readonly isLeader: () => boolean;
  /**
   * Records this prompt into the prompt view and, if this host should answer it now,
   * forks its turn and returns the handle. Returns null when the prompt is recorded
   * but not answered (replay, or a standby that is not the leader). The scheduler
   * tracks whatever handle this returns as the single active run.
   */
  readonly start: (event: SessionEvent) => ActiveTurn | null;
}

/**
 * Owns *when turns run*: the one-turn-at-a-time invariant, the deferred-prompt FIFO,
 * and the active run's lifecycle. It is the home for the turn-dispatch state that was
 * scattered across main.ts module mutables (`activeRun`, `deferredUserEvents`,
 * `lastUserEvent`, `lastAnswerSeq`) and the respondTo / handleUserMessage /
 * drainDeferred / onBecomeLeader functions.
 *
 * The contract:
 *   - submit(event)        answer now if idle, else queue behind the active turn
 *   - settle(runId)        the turn's fiber exited: free the slot (NO drain)
 *   - recordAnswer(id,seq) the completion event landed: free the slot + note the seq
 *   - drain()              start the next queued prompt, if idle and leader
 *   - cancel(runId)        interrupt the active run
 *   - pendingCatchUp()     the latest still-unanswered prompt, for leader catch-up
 *
 * `settle` and the completion path are deliberately split: draining is tied to the
 * completion EVENT, not the fiber exit, because the next turn's prompt view must
 * already include the just-finished turn's reply (admitted alongside recordAnswer in
 * main.ts). The fiber observer is only a backstop that frees the slot promptly.
 *
 * One-turn-at-a-time is now structural: `start` is invoked only from submit/drain,
 * both of which run only while idle - so a turn can never be dispatched over a live
 * one (the old `respondTo while a turn is active` runtime check is no longer needed).
 *
 * It is NOT responsible for *what the model sees* - building the prompt history from
 * the event log is the projection's job (history-projection.ts). It records prompts
 * through the injected `start`; it does not fold history itself.
 */
export class TurnScheduler {
  private active: ActiveTurn | null = null;
  private queue: SessionEvent[] = [];
  /** The most recently recorded prompt and the highest answered seq - together they
   *  say whether the latest prompt still needs an answer (leader catch-up). */
  private lastUser: SessionEvent | null = null;
  private lastAnswerSeq = -1;

  constructor(private readonly deps: TurnSchedulerDeps) {}

  /** True while a turn is in flight. */
  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * Submits a user prompt: answer it now if idle, else queue it (FIFO) behind the
   * active turn so turns never overlap. Recording the prompt (and deciding whether
   * to dispatch it) is delegated to `start`; a deferred prompt is recorded only when
   * it is later drained, which keeps the prompt view strictly paired.
   */
  submit(event: SessionEvent): void {
    if (this.active) {
      this.queue.push(event);
      return;
    }
    this.startNow(event);
  }

  /** The active turn's fiber exited (backstop): free the slot if it matches. Does not
   *  drain - the completion event owns that, so the next turn sees the finished reply. */
  settle(runId: string): void {
    if (this.active?.runId === runId) {
      this.active = null;
    }
  }

  /** The completion event landed: note the answered seq and free the slot if it matches.
   *  The caller drains afterward (only when live), mirroring the old handler order. */
  recordAnswer(runId: string, seq: number): void {
    this.lastAnswerSeq = Math.max(this.lastAnswerSeq, seq);
    if (this.active?.runId === runId) {
      this.active = null;
    }
  }

  /** Starts the next queued prompt, if idle and the leader. A non-leader holds the
   *  queue (it must not pop a prompt it cannot answer). */
  drain(): void {
    if (this.active || !this.deps.isLeader()) {
      return;
    }
    const next = this.queue.shift();
    if (next) {
      this.startNow(next);
    }
  }

  /** Aborts the active turn if it matches `runId`, or `""` to cancel whatever is active
   *  (the browser sends an empty runId before assistant.started has landed). */
  cancel(runId: string): void {
    if (this.active && (this.active.runId === runId || runId === "")) {
      this.active.cancel();
    }
  }

  /** The latest prompt that has not yet been answered, or null - used to catch up a
   *  prompt that arrived while this host was a standby, on becoming leader. */
  pendingCatchUp(): SessionEvent | null {
    return this.lastUser && this.lastUser.seq > this.lastAnswerSeq ? this.lastUser : null;
  }

  /** On /clear: drop the queued prompts and the catch-up target so the cleared prompts
   *  never get answered, but leave the active run alone (a clear mid-turn does not kill
   *  the turn) and keep lastAnswerSeq (the answered-watermark still holds). */
  clearPending(): void {
    this.queue = [];
    this.lastUser = null;
  }

  /** On reconnect: drop the deferred queue (rebuilt from replay) but leave an in-flight
   *  run intact - its turn keeps emitting over REST and its replayed completion clears
   *  it; resetting could race a concurrent turn. lastUser/lastAnswerSeq are rebuilt from
   *  replay too. */
  resetForReconnect(): void {
    this.queue = [];
    this.lastUser = null;
    this.lastAnswerSeq = -1;
  }

  /** A snapshot of the turn machine for /doctor: what is running and what waits. */
  debug(): {
    readonly active: string | null;
    readonly queued: number;
    readonly lastAnswerSeq: number;
  } {
    return {
      active: this.active ? this.active.runId.slice(0, 8) : null,
      queued: this.queue.length,
      lastAnswerSeq: this.lastAnswerSeq,
    };
  }

  private startNow(event: SessionEvent): void {
    this.lastUser = event;
    const turn = this.deps.start(event);
    if (turn) {
      this.active = turn;
    }
  }
}

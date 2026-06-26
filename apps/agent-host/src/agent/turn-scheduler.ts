import { decodeTrevorEvent, type SessionEvent } from "@trevor/session";

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
  /**
   * The compaction policy (D-041), as ONE optional unit because the two halves are meaningless
   * apart. The scheduler owns the gate MECHANISM (hold the idle slot, drain after a fold); the host
   * injects the POLICY here. Omit it to disable compaction gating entirely (plain turns).
   *   - needed(): true when the prompt projection has crossed the budget and a fold must run before
   *     the next turn starts (blocking-before). The host must return false once a fold brought the
   *     projection back under budget (or it could not fold further), so the gate never loops.
   *   - run(): kicks off ONE fold off the idle slot (async); the host plans + summarizes + emits the
   *     fold, then calls `finishCompaction` once the projection has updated. The scheduler holds all
   *     turns behind it (the same one-at-a-time gate that serializes turns), so a fold never runs
   *     concurrently with a turn.
   */
  readonly compaction?: {
    readonly needed: () => boolean;
    readonly run: () => void;
  };
}

/**
 * Owns *when turns run*: the one-turn-at-a-time invariant, the deferred-prompt FIFO,
 * and the active run's lifecycle. It is the home for the turn-dispatch state that was
 * scattered across main.ts module mutables (`activeRun`, `deferredUserEvents`,
 * `lastUserEvent`, `lastAnswerSeq`) and the respondTo / handleUserMessage /
 * drainDeferred / onBecomeLeader functions.
 *
 * The contract is two inbound LIFECYCLE entry points plus recovery hooks; callers
 * drive lifecycle, never the internal micro-mutations or their ordering:
 *   - noteTurn(event)         a turn-relevant event landed: a user prompt to answer
 *                             /queue, or an assistant.started marking a turn attempt
 *   - processCompletion(id,s) the completion event landed: free the slot, note the
 *                             seq, drain the next prompt, then fold proactively if
 *                             over budget - in that exact order, hidden from callers
 *   - settle(runId)           the turn's fiber exited (backstop): free the slot (NO drain)
 *   - finishCompaction()      a fold finished: release the gate + drain what waited
 *   - cancel/clearPending/resetForReconnect   recovery entry points
 *   - isBusy/pendingCatchUp/debug             queries
 *
 * `settle` and the completion path are deliberately split: draining is tied to the
 * completion EVENT, not the fiber exit, because the next turn's prompt view must
 * already include the just-finished turn's reply (admitted alongside the completion in
 * main.ts). The fiber observer is only a backstop that frees the slot promptly.
 *
 * The `recordAnswer → drain → maybeCompact` ordering used to be three separate calls
 * the caller made in sequence (an implicit, unenforced contract); `processCompletion`
 * folds that ordering inside so a caller can no longer get it wrong or skip a step.
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
  /** The highest seq of any assistant.started seen (this host's or another's), i.e. the latest
   *  prompt ATTEMPT. Catch-up only re-runs a prompt nothing has attempted yet, so a prompt already
   *  attempted (then orphaned by a crash/restart) is never auto-re-run on the next leadership. */
  private lastStartSeq = -1;
  /** A compaction fold is running in the idle slot: hold every turn behind it (D-041). */
  private compacting = false;

  constructor(private readonly deps: TurnSchedulerDeps) {}

  /** True while a turn is in flight. */
  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * A turn-relevant event landed - dispatches it to the right internal handler so callers drive one
   * lifecycle entry instead of choosing between `submit` and `noteAttempt`. A `user.message` is a
   * prompt to answer now or queue (`submit`); an `assistant.started` marks a turn ATTEMPT, recording
   * its seq so catch-up never re-runs an already-attempted prompt (`noteAttempt`). Other event types
   * are ignored. The caller's own producer/relevance filtering still decides which events reach here.
   */
  noteTurn(event: SessionEvent): void {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "user.message") {
      this.submit(event);
    } else if (decoded?.type === "assistant.started") {
      this.noteAttempt(event.seq);
    }
  }

  /**
   * The completion event landed: free the slot + note the answered seq (`recordAnswer`), start the
   * next queued prompt (`drain`), then fold proactively if idle and over budget (`maybeCompact`) -
   * in that exact order. Folding the ordering inside is the point: the next turn's prompt view must
   * already include this reply (the caller admits it before calling), draining must follow that, and
   * a proactive fold only makes sense once the slot is free. Inert during replay/standby: `drain`'s
   * `start` returns null off-live and `maybeCompact` gates on liveness, so a replayed completion just
   * advances the answered watermark.
   */
  processCompletion(runId: string, seq: number): void {
    this.recordAnswer(runId, seq);
    this.drain();
    this.maybeCompact();
  }

  /**
   * Submits a user prompt: answer it now if idle, else queue it (FIFO) behind the active turn
   * (or a running compaction) so turns never overlap. Recording the prompt (and deciding whether
   * to dispatch it) is delegated to `start`; a deferred prompt is recorded only when it is later
   * drained, which keeps the prompt view strictly paired.
   */
  private submit(event: SessionEvent): void {
    if (this.active || this.compacting) {
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

  /** The completion event landed: note the answered seq and free the slot if it matches. Private:
   *  reached only through `processCompletion`, which drains + folds in the right order afterward. */
  private recordAnswer(runId: string, seq: number): void {
    this.lastAnswerSeq = Math.max(this.lastAnswerSeq, seq);
    if (this.active?.runId === runId) {
      this.active = null;
    }
  }

  /** Starts the next queued prompt, if idle and the leader. A non-leader holds the queue (it must
   *  not pop a prompt it cannot answer); a running compaction holds it too (blocking-before). Private:
   *  reached through `processCompletion` (after a completion) and `finishCompaction` (after a fold). */
  private drain(): void {
    if (this.active || this.compacting || !this.deps.isLeader()) {
      return;
    }
    const next = this.queue.shift();
    if (next) {
      this.startNow(next);
    }
  }

  /**
   * Background-after compaction (D-041): when idle and over budget, fold proactively even with no
   * prompt waiting, so the NEXT turn starts pre-compacted with no visible pause. A no-op when a
   * turn or fold is already running, when not the leader, or when compaction is disabled/not needed.
   * Private: reached only through `processCompletion`, in the idle slot a completion just freed.
   */
  private maybeCompact(): void {
    if (this.active || this.compacting || !this.deps.isLeader()) {
      return;
    }
    if (this.deps.compaction?.needed()) {
      this.compacting = true;
      this.deps.compaction.run();
    }
  }

  /** The host signals its fold finished (the projection has updated): release the gate and start
   *  whatever waited behind it. Idempotent - a no-op when no compaction was running. */
  finishCompaction(): void {
    if (!this.compacting) {
      return;
    }
    this.compacting = false;
    this.drain();
  }

  /** Aborts the active turn if it matches `runId`, or `""` to cancel whatever is active
   *  (the browser sends an empty runId before assistant.started has landed). */
  cancel(runId: string): void {
    if (this.active && (this.active.runId === runId || runId === "")) {
      this.active.cancel();
    }
  }

  /** Notes a prompt attempt (an assistant.started landed): records its seq so catch-up never
   *  re-runs a prompt that was already attempted - replayed from the log too, so the watermark
   *  survives a restart. Private: reached through `noteTurn` when an assistant.started arrives. */
  private noteAttempt(seq: number): void {
    this.lastStartSeq = Math.max(this.lastStartSeq, seq);
  }

  /**
   * The latest prompt to catch up on becoming leader, or null. Catch-up answers a prompt that
   * arrived while this host was a standby/probing - but ONLY one nothing has acted on yet: no answer
   * AND no prior attempt (an assistant.started after it). A prompt already attempted (by any host,
   * then orphaned by a crash/restart) is NOT re-run - the orphan reap closes it and the host idles -
   * so a restart can never loop re-running the same prompt.
   */
  pendingCatchUp(): SessionEvent | null {
    if (!this.lastUser) {
      return null;
    }
    const answered = this.lastUser.seq <= this.lastAnswerSeq;
    const attempted = this.lastUser.seq <= this.lastStartSeq;
    return answered || attempted ? null : this.lastUser;
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
    this.lastStartSeq = -1;
  }

  /** A snapshot of the turn machine for /doctor: what is running and what waits. */
  debug(): {
    readonly active: string | null;
    readonly queued: number;
    readonly lastAnswerSeq: number;
    readonly compacting: boolean;
  } {
    return {
      active: this.active ? this.active.runId.slice(0, 8) : null,
      queued: this.queue.length,
      lastAnswerSeq: this.lastAnswerSeq,
      compacting: this.compacting,
    };
  }

  private startNow(event: SessionEvent): void {
    // Blocking-before (D-041): a turn must never start over the compaction budget. Defer it to the
    // front of the queue behind a fold; finishCompaction() drains it once the projection shrinks.
    // The host's needsCompaction must return false after a fold (or when it cannot fold further),
    // so a turn re-drained here proceeds rather than looping.
    if (this.deps.compaction?.needed()) {
      this.compacting = true;
      this.queue.unshift(event);
      this.lastUser = event;
      this.deps.compaction.run();
      return;
    }
    this.lastUser = event;
    const turn = this.deps.start(event);
    if (turn) {
      this.active = turn;
    }
  }
}

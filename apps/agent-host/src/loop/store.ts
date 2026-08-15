import { extractLoopSpec, type LoopSnapshot, type LoopSpec } from "@belay/session";
import {
  cancelLoop,
  completeLoop,
  confirmLoop,
  createLoop,
  deleteLoop,
  failLoop,
  type LoopState,
  type LoopTransition,
  pauseLoop,
  recordIteration,
  requestConfirmation,
  resumeLoop,
  stopLoop,
} from "./domain";
import type { PersistedLoop } from "./persistence";
import type { LoopIterationRunner } from "./runner";
import { LoopScheduler } from "./scheduler";

/**
 * The runtime `/loop` STORE (plan 17, M4-M6): the in-memory registry that holds every loop by id, drives the
 * CONFIRMATION FLOW (D-004: a ready submission parks `pending`, only confirm activates), and once activated
 * SCHEDULES + RUNS iterations - a cadence (`every`) loop on its interval, a continuous loop back-to-back -
 * through the injected {@link LoopIterationRunner}, applying the pure domain transitions and publishing a
 * structured {@link LoopSnapshot} on every change. It exposes the full control surface (pause/resume/stop/
 * delete/run-now/list) and a persistence seam for durable loops.
 *
 * Transient state (the in-memory map + timers) is kept separate from durability: the store calls `persist`
 * on each durable-loop change and rehydrates via {@link LoopStore.hydrate} at startup; it never does file IO.
 *
 * Responsible for: the runtime loop registry: confirmation flow, scheduling, and iteration runs.
 * Not for: file IO (persistence.ts) or the transition rules (domain.ts).
 */

/** The sink the store publishes each loop's status snapshot to (wired to `emit(events.loopStatus(...))`). */
export type LoopEventSink = (snapshot: LoopSnapshot) => void;

export interface LoopStoreDeps {
  readonly emit: LoopEventSink;
  /** Mints a fresh loop id (injectable for deterministic tests); defaults to a monotonic `loop_N`. */
  readonly makeId?: () => string;
  /** Runs one iteration's body. When present (with `scheduler`), confirmed loops actually execute. */
  readonly runner?: LoopIterationRunner;
  /** The timer owner. Defaults to a real-clock scheduler; a manual clock makes cadence deterministic. */
  readonly scheduler?: LoopScheduler;
  /** Called on every DURABLE loop change with its latest record (state + next-run), for persistence (M6). */
  readonly persist?: (record: PersistedLoop) => void;
}

/** A store operation result: the affected loop's snapshot, or an explainable rejection. */
export type LoopResult =
  | { readonly ok: true; readonly snapshot: LoopSnapshot }
  | { readonly ok: false; readonly error: string };

/**
 * The control surface the `/loop` command routes to (the {@link LoopStore} implements it). Keeping the
 * command handler to this narrow interface lets it drive loops headlessly without depending on the store's
 * scheduling/persistence internals - the SAME surface a web helper's inventory controls submit through.
 */
export interface LoopController {
  submit(input: string): LoopResult;
  confirm(loopId: string): LoopResult;
  list(): LoopState[];
  get(loopId: string): LoopState | undefined;
  pause(loopId: string): LoopResult;
  resume(loopId: string): LoopResult;
  stop(loopId: string): LoopResult;
  delete(loopId: string): LoopResult;
  runNow(loopId: string): LoopResult;
}

/** Compact `NNN{unit}` for a millisecond bound, preferring the largest whole unit. */
function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1_000 === 0) {
    return `${ms / 1_000}s`;
  }
  return `${ms}ms`;
}

/** A one-line, UI-neutral human summary of a spec's bounds + action (for the snapshot + transcript). */
export function summarizeLoopSpec(spec: LoopSpec): string {
  const bounds: string[] = [];
  if (spec.max !== undefined) {
    bounds.push(`max ${spec.max}`);
  }
  if (spec.everyMs !== undefined) {
    bounds.push(`every ${formatMs(spec.everyMs)}`);
  }
  if (spec.until !== undefined) {
    bounds.push(`until "${spec.until}"`);
  }
  if (spec.timeoutMs !== undefined) {
    bounds.push(`timeout ${formatMs(spec.timeoutMs)}`);
  }
  return `${bounds.join(" · ")} · do "${spec.action}"`;
}

/** The read-model snapshot of one loop state (the payload of a `loop.status` event). */
function loopSnapshot(state: LoopState, nextRun?: number): LoopSnapshot {
  return {
    loopId: state.id,
    status: state.status,
    runner: state.spec.runner,
    durability: state.spec.durability,
    summary: summarizeLoopSpec(state.spec),
    completed: state.completed,
    ...(state.spec.max !== undefined ? { max: state.spec.max } : {}),
    ...(nextRun !== undefined ? { nextRun } : {}),
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
}

/** The floor delay between iterations of a CONTINUOUS loop (a bound with no `every` cadence). Without it a
 *  continuous loop reschedules at delay 0 and, with an instant-resolving prompt/background seam, would flood
 *  the turn queue; the floor paces it to a sane rate while still running effectively back-to-back. */
const CONTINUOUS_ITERATION_FLOOR_MS = 1_000;

export class LoopStore {
  private readonly loops = new Map<string, LoopState>();
  private readonly deadlines = new Map<string, number>();
  /** Loop ids with an iteration currently executing - guards against a second concurrent run (from a
   *  run-now/resume racing an in-flight iteration) double-advancing `completed`. */
  private readonly inFlight = new Set<string>();
  private readonly emit: LoopEventSink;
  private readonly makeId: () => string;
  private readonly runner?: LoopIterationRunner;
  private readonly scheduler: LoopScheduler;
  private readonly persist?: (record: PersistedLoop) => void;
  private counter = 0;

  constructor(deps: LoopStoreDeps) {
    this.emit = deps.emit;
    this.makeId =
      deps.makeId ??
      (() => {
        this.counter += 1;
        return `loop_${this.counter}`;
      });
    this.runner = deps.runner;
    this.scheduler = deps.scheduler ?? new LoopScheduler();
    this.persist = deps.persist;
  }

  /** Whether this store actually executes iterations (both a runner and its scheduler are wired). */
  private get driving(): boolean {
    return this.runner !== undefined;
  }

  /** All non-deleted loops, oldest first (insertion order). */
  list(): LoopState[] {
    return [...this.loops.values()].filter((loop) => loop.status !== "deleted");
  }

  get(loopId: string): LoopState | undefined {
    return this.loops.get(loopId);
  }

  /**
   * Restore loops (durable ones) at startup WITHOUT re-running any effects or re-emitting. A loop that was
   * `running` when the host stopped is restored as `paused` (not `running`): its timer did not survive the
   * restart, so a "running" badge would be a lie - the user explicitly resumes it. `deleted` records are
   * dropped. Kept side-effect-free (no emit/schedule) so hydration is idempotent.
   */
  hydrate(states: readonly LoopState[]): void {
    for (const state of states) {
      if (state.status === "deleted") {
        continue;
      }
      const restored: LoopState =
        state.status === "running" ? { ...state, status: "paused" } : state;
      this.loops.set(restored.id, restored);
    }
  }

  /**
   * Submit explicit `/loop` command text. A READY creation becomes a `pending` loop awaiting confirmation
   * (never started directly); an unready one is rejected so the client keeps editing in the builder.
   */
  submit(input: string): LoopResult {
    const spec = extractLoopSpec(input);
    if (spec === undefined) {
      return { ok: false, error: "not a ready loop creation (needs an action and a bound)" };
    }
    const pending = requestConfirmation(createLoop(this.makeId(), spec));
    if (!pending.ok) {
      return { ok: false, error: pending.reason };
    }
    return this.commit(pending.state);
  }

  /** Confirm a `pending` loop: activation. Sets any timeout deadline and starts driving iterations. The
   *  timer is scheduled BEFORE the snapshot is published so the running snapshot carries its `nextRun`. */
  confirm(loopId: string): LoopResult {
    const loop = this.loops.get(loopId);
    if (loop === undefined) {
      return { ok: false, error: `unknown loop ${loopId}` };
    }
    const next = confirmLoop(loop);
    if (!next.ok) {
      return { ok: false, error: next.reason };
    }
    if (next.state.spec.timeoutMs !== undefined) {
      this.deadlines.set(loopId, this.scheduler.now() + next.state.spec.timeoutMs);
    }
    this.scheduleNext(next.state);
    return this.commit(next.state);
  }

  /** Replace a still-`pending` loop's definition with a re-parsed submission, keeping it `pending`. */
  edit(loopId: string, input: string): LoopResult {
    const loop = this.loops.get(loopId);
    if (loop === undefined) {
      return { ok: false, error: `unknown loop ${loopId}` };
    }
    if (loop.status !== "pending") {
      return { ok: false, error: `cannot edit a ${loop.status} loop` };
    }
    const spec = extractLoopSpec(input);
    if (spec === undefined) {
      return { ok: false, error: "not a ready loop creation (needs an action and a bound)" };
    }
    const pending = requestConfirmation(createLoop(loopId, spec));
    if (!pending.ok) {
      return { ok: false, error: pending.reason };
    }
    return this.commit(pending.state);
  }

  /** Cancel a `draft`/`pending` loop before it activates (soft-delete). */
  cancel(loopId: string): LoopResult {
    return this.transition(loopId, cancelLoop);
  }

  /** Pause a running loop: cancel its timer, keep its progress. */
  pause(loopId: string): LoopResult {
    const result = this.transition(loopId, pauseLoop);
    if (result.ok) {
      this.scheduler.cancel(loopId);
    }
    return result;
  }

  /** Resume a paused loop: reschedule its next iteration (before publishing, so `nextRun` is present). */
  resume(loopId: string): LoopResult {
    const loop = this.loops.get(loopId);
    if (loop === undefined) {
      return { ok: false, error: `unknown loop ${loopId}` };
    }
    const next = resumeLoop(loop);
    if (!next.ok) {
      return { ok: false, error: next.reason };
    }
    // Re-establish a lost timeout deadline: the in-memory `deadlines` map does not survive a restart, so a
    // durable timeout loop restored + resumed would otherwise run ignoring its timeout. Resuming restarts
    // the timeout budget (a paused loop already holding its deadline keeps it).
    if (next.state.spec.timeoutMs !== undefined && !this.deadlines.has(loopId)) {
      this.deadlines.set(loopId, this.scheduler.now() + next.state.spec.timeoutMs);
    }
    this.scheduleNext(next.state);
    return this.commit(next.state);
  }

  /** Stop a running/paused loop: cancel its timer and mark it stopped. */
  stop(loopId: string): LoopResult {
    const result = this.transition(loopId, stopLoop);
    if (result.ok) {
      this.clearTiming(loopId);
    }
    return result;
  }

  /** Soft-delete a loop from any state: cancel its timer and hide it. */
  delete(loopId: string): LoopResult {
    const result = this.transition(loopId, deleteLoop);
    if (result.ok) {
      this.clearTiming(loopId);
    }
    return result;
  }

  /** Run one iteration NOW (a running loop), pre-empting the cadence wait; the cadence then continues. */
  runNow(loopId: string): LoopResult {
    const loop = this.loops.get(loopId);
    if (loop === undefined) {
      return { ok: false, error: `unknown loop ${loopId}` };
    }
    if (loop.status !== "running") {
      return { ok: false, error: `cannot run-now a ${loop.status} loop` };
    }
    // Fire immediately (delay 0), replacing the pending cadence timer (one-timer invariant preserved).
    this.scheduler.schedule(loopId, 0, () => this.tick(loopId));
    return { ok: true, snapshot: this.snapshotOf(loop) };
  }

  /** Applies a domain transition to a stored loop, committing + publishing the result. */
  private transition(loopId: string, step: (state: LoopState) => LoopTransition): LoopResult {
    const loop = this.loops.get(loopId);
    if (loop === undefined) {
      return { ok: false, error: `unknown loop ${loopId}` };
    }
    const next = step(loop);
    if (!next.ok) {
      return { ok: false, error: next.reason };
    }
    return this.commit(next.state);
  }

  /** Schedule the next iteration of a running loop, honoring the cadence and any timeout deadline. */
  private scheduleNext(state: LoopState): void {
    if (!this.driving || state.status !== "running") {
      return;
    }
    // A cadence loop waits its interval; a continuous loop (no `every`) is floored so it cannot delay-0 spin.
    const cadence = state.spec.everyMs ?? CONTINUOUS_ITERATION_FLOOR_MS;
    const deadline = this.deadlines.get(state.id);
    if (deadline === undefined) {
      this.scheduler.schedule(state.id, cadence, () => this.tick(state.id));
      return;
    }
    const remaining = deadline - this.scheduler.now();
    if (remaining <= 0) {
      this.finishTimeout(state);
      return;
    }
    this.scheduler.schedule(state.id, Math.min(cadence, remaining), () => this.tick(state.id));
  }

  /** A scheduled fire: complete on a reached deadline, else run one iteration. */
  private tick(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop === undefined || loop.status !== "running") {
      return;
    }
    const deadline = this.deadlines.get(loopId);
    if (deadline !== undefined && this.scheduler.now() >= deadline) {
      this.finishTimeout(loop);
      return;
    }
    void this.runIteration(loopId);
  }

  /** Run one iteration's body, apply the resulting transition, and reschedule while still running. Guarded
   *  against re-entrancy (a run-now/resume racing an in-flight iteration) so a body never runs concurrently
   *  for the same loop, and against a THROWING runner (a rejected seam) so it cannot crash the host. */
  private async runIteration(loopId: string): Promise<void> {
    const before = this.loops.get(loopId);
    if (this.runner === undefined || before === undefined || before.status !== "running") {
      return;
    }
    if (this.inFlight.has(loopId)) {
      return; // an iteration is already executing for this loop; do not start a second concurrently
    }
    this.inFlight.add(loopId);
    let next: LoopTransition;
    try {
      const outcome = await this.runner.run(before.spec);
      // The loop may have been paused/stopped/deleted while the body ran; re-read and bail if so.
      const current = this.loops.get(loopId);
      if (current === undefined || current.status !== "running") {
        return;
      }
      if (!outcome.ok) {
        next = failLoop(current, outcome.error ?? "iteration failed");
      } else if (outcome.conditionMet && current.spec.until !== undefined) {
        next = completeLoop(current, "until_satisfied");
      } else {
        next = recordIteration(current); // increments; auto-completes at max
      }
    } catch (error) {
      // A runner that REJECTS (not the ok:false contract) - e.g. a transport blip - fails the loop instead
      // of escaping as an unhandled rejection that would crash the host.
      const current = this.loops.get(loopId);
      if (current === undefined || current.status !== "running") {
        return;
      }
      next = failLoop(current, error instanceof Error ? error.message : String(error));
    } finally {
      this.inFlight.delete(loopId);
    }
    if (!next.ok) {
      return;
    }
    // Schedule/clear the timer BEFORE committing so the published + persisted snapshot carries a fresh
    // next-run (the just-fired timer cleared the old one).
    if (next.state.status === "running") {
      this.scheduleNext(next.state);
    } else {
      this.clearTiming(loopId);
    }
    this.commit(next.state);
  }

  /** Complete a loop because its wall-clock timeout elapsed. */
  private finishTimeout(state: LoopState): void {
    const done = completeLoop(state, "timeout");
    if (done.ok) {
      this.commit(done.state);
    }
    this.clearTiming(state.id);
  }

  /** Drop a loop's timer + deadline (a terminal loop keeps neither). */
  private clearTiming(loopId: string): void {
    this.scheduler.cancel(loopId);
    this.deadlines.delete(loopId);
  }

  /** Builds a snapshot with the loop's live next-run time (when scheduled). */
  private snapshotOf(state: LoopState): LoopSnapshot {
    return loopSnapshot(state, this.scheduler.nextRunAt(state.id));
  }

  /** Stores the new state, persists it when durable, and publishes its snapshot. */
  private commit(state: LoopState): LoopResult {
    this.loops.set(state.id, state);
    const nextRun = this.scheduler.nextRunAt(state.id);
    if (state.spec.durability === "durable" && this.persist !== undefined) {
      this.persist({ ...state, ...(nextRun !== undefined ? { nextRun } : {}) });
    }
    const snapshot = loopSnapshot(state, nextRun);
    this.emit(snapshot);
    return { ok: true, snapshot };
  }
}

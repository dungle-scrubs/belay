import {
  extractLoopSpec,
  type LoopSnapshot,
  type LoopSpec,
  type LoopStatus,
} from "@trevor/session";
import {
  cancelLoop,
  confirmLoop,
  createLoop,
  type LoopState,
  type LoopTransition,
  requestConfirmation,
} from "./domain";

/**
 * The runtime `/loop` STORE (plan 17, M4 tasks 5-6): the in-memory registry that holds every loop by id and
 * drives the CONFIRMATION FLOW - a ready `/loop` submission becomes a `pending` draft awaiting the user's
 * confirm/edit/cancel, and only an explicit confirm activates recurring work (D-004: never start work
 * directly). Every transition publishes a structured {@link LoopSnapshot} through the injected sink, so a
 * client - the rich web helper or a headless one - drives and observes loops entirely over the protocol.
 *
 * The store owns lifecycle + the confirmation flow ONLY. Scheduling, runner execution, and durable
 * persistence layer on top in M5/M6; the pure transitions live in `domain.ts`.
 */

/** The sink the store publishes each loop's status snapshot to (wired to `emit(events.loopStatus(...))`). */
export type LoopEventSink = (snapshot: LoopSnapshot) => void;

export interface LoopStoreDeps {
  readonly emit: LoopEventSink;
  /** Mints a fresh loop id (injectable for deterministic tests); defaults to a monotonic `loop_N`. */
  readonly makeId?: () => string;
}

/** A store operation result: the affected loop's snapshot, or an explainable rejection. */
export type LoopResult =
  | { readonly ok: true; readonly snapshot: LoopSnapshot }
  | { readonly ok: false; readonly error: string };

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
export function loopSnapshot(state: LoopState): LoopSnapshot {
  return {
    loopId: state.id,
    status: state.status,
    runner: state.spec.runner,
    durability: state.spec.durability,
    summary: summarizeLoopSpec(state.spec),
    completed: state.completed,
    ...(state.spec.max !== undefined ? { max: state.spec.max } : {}),
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
}

/** The client-facing {@link LoopStatus} (6 states) a full lifecycle status projects to. `pending` shows as
 *  a draft awaiting confirmation; `deleted` loops are hidden and never projected into an inventory row. */
export function toClientStatus(status: LoopState["status"]): LoopStatus | "hidden" {
  switch (status) {
    case "draft":
    case "pending":
      return "draft";
    case "deleted":
      return "hidden";
    default:
      return status;
  }
}

export class LoopStore {
  private readonly loops = new Map<string, LoopState>();
  private readonly emit: LoopEventSink;
  private readonly makeId: () => string;
  private counter = 0;

  constructor(deps: LoopStoreDeps) {
    this.emit = deps.emit;
    this.makeId = deps.makeId ?? (() => `loop_${(this.counter += 1)}`);
  }

  /** All non-deleted loops, oldest first (insertion order). */
  list(): LoopState[] {
    return [...this.loops.values()].filter((loop) => loop.status !== "deleted");
  }

  get(loopId: string): LoopState | undefined {
    return this.loops.get(loopId);
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

  /** Confirm a `pending` loop: activation. Recurring work begins (execution/scheduling land in M5/M6). */
  confirm(loopId: string): LoopResult {
    return this.transition(loopId, confirmLoop);
  }

  /**
   * Replace a still-`pending` loop's definition with a re-parsed submission, keeping it `pending` (D-012:
   * edit before activation). Rejected once the loop is running or terminal.
   */
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

  /** Stores the new state and publishes its snapshot. */
  private commit(state: LoopState): LoopResult {
    this.loops.set(state.id, state);
    const snapshot = loopSnapshot(state);
    this.emit(snapshot);
    return { ok: true, snapshot };
  }
}

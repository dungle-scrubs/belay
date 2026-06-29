import { newSerialRun, type SerialRun } from "./journal";
import { parseSerialQueue } from "./queue";

/**
 * The serial-run entry (plan 02, M1): turns a conversational trigger into a durable, re-openable run and
 * hands it off to a dedicated session, freeing the launching one. Pure over injected deps - the parse
 * list, id mint, clock, journal persistence, and the handoff spawn - so the entry sequence is unit-tested
 * without a running host. The journal is persisted BEFORE the handoff so the spawned run can load it by
 * id (re-openable), and the launching session is never blocked on the run (handoff moves it on).
 *
 * `handoff-flow` stays generic: this is just a consumer that builds the run's seed prompt and calls it.
 */

/** The effects starting a serial run orchestrates; the host wires the real listing/mint/persist/handoff. */
export interface SerialRunStartDeps {
  /** The plan dirs under `.plans/` available to queue. */
  availablePlans(): readonly string[];
  newRunId(): string;
  now(): string;
  /** Persist the run journal (so the spawned run is re-openable by id). */
  saveRun(run: SerialRun): void;
  /** Spawn a dedicated durable session for the run via handoff-flow, seeded with `prompt`. Resolves to
   *  the target session id (or null if the handoff itself failed). */
  handoff(prompt: string): Promise<{ readonly ok: boolean; readonly targetSessionId?: string }>;
}

export interface SerialRunStartResult {
  readonly ok: boolean;
  readonly text: string;
  readonly runId?: string;
  readonly targetSessionId?: string;
}

/** The first prompt the spawned serial-run session replays - it names the run id (so the host can load
 *  the journal) and the queue + disposition contract. Kept here so the entry and the run share one wording. */
export function serialRunSeedPrompt(runId: string, queue: readonly string[]): string {
  return [
    `Serial worktree-implement run ${runId}.`,
    `Implement these plans strictly one worktree at a time, in order: ${queue.join(", ")}.`,
    "For each plan: create + enter its managed worktree, implement it, and when the tree is green and",
    "clean, merge it back and delete it; on the first red / conflict / dirty tree, STOP and surface it,",
    "leaving that tree intact. Never create the next plan's tree until the prior one is merged + deleted.",
  ].join(" ");
}

/**
 * Parses the request into a plan queue, records a durable run, and hands off to a dedicated run session.
 * A request that names no resolvable plan fails early - no run is recorded and no handoff happens, so the
 * launching session is untouched (mirrors handoff-flow's empty-prompt guard).
 */
export async function startSerialRun(
  request: string,
  deps: SerialRunStartDeps,
): Promise<SerialRunStartResult> {
  const parsed = parseSerialQueue(request, deps.availablePlans());
  if (!parsed.ok) {
    return { ok: false, text: parsed.error };
  }
  const runId = deps.newRunId();
  deps.saveRun(newSerialRun(runId, parsed.queue, deps.now()));

  const handoff = await deps.handoff(serialRunSeedPrompt(runId, parsed.queue));
  if (!handoff.ok) {
    return { ok: false, text: `serial run ${runId} recorded, but handoff failed`, runId };
  }
  return {
    ok: true,
    text: `✓ serial run ${runId} started over ${parsed.queue.length} plan(s): ${parsed.queue.join(", ")}`,
    runId,
    ...(handoff.targetSessionId ? { targetSessionId: handoff.targetSessionId } : {}),
  };
}

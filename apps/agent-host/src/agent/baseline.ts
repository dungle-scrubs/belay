import type { ArtifactRef, DecodedEvent, SessionEvent, TaskSnapshot } from "@trevor/session";

/**
 * The baseline that both the prompt projection (history-projection.ts) and the compaction planner
 * (compactor.ts) operate over: everything after the last non-self `/clear`, plus the latest fold in
 * that baseline, the goal pin (its first non-self user.message), and the live task list. Computed in
 * ONE pass over the PRE-DECODED log, so both callers read the SAME baseline - the fold the planner
 * emits must match the prefix the projection collapses, so these rules cannot live in two places (the
 * same drift the shared toolCallGrouper guards against).
 */
export interface Baseline {
  /** Index of the first event after the last non-self /clear (0 if there was none). */
  readonly start: number;
  /** The latest context.compacted in the baseline (a later one supersedes), or null. */
  readonly fold: {
    readonly throughSeq: number;
    readonly summary: string;
    readonly foldId: string;
  } | null;
  /** The goal pin: the first non-self user.message of the baseline (re-injected outside the fold). */
  readonly goal: { readonly text: string; readonly artifacts: readonly ArtifactRef[] } | null;
  /** The live task list (latest tasks.current), which rides in the fold message. */
  readonly tasks: readonly TaskSnapshot[];
}

export function analyzeBaseline(
  events: readonly SessionEvent[],
  decoded: readonly (DecodedEvent | null)[],
  selfProducerId: string | undefined,
): Baseline {
  const isSelf = (event: SessionEvent): boolean =>
    selfProducerId !== undefined && event.producerId === selfProducerId;
  let start = 0;
  let fold: Baseline["fold"] = null;
  let goal: Baseline["goal"] = null;
  let tasks: readonly TaskSnapshot[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const d = decoded[i];
    if (!event || !d) {
      continue;
    }
    if (d.type === "user.command" && d.command === "/clear" && !isSelf(event)) {
      // A clear resets the baseline, dropping any fold + pins before it. Self-authored clears are
      // the host's own echo - ignored.
      start = i + 1;
      fold = null;
      goal = null;
      tasks = [];
    } else if (d.type === "user.message" && !isSelf(event)) {
      goal ??= { text: d.text, artifacts: d.artifacts };
    } else if (d.type === "tasks.current") {
      tasks = d.tasks;
    } else if (d.type === "context.compacted") {
      fold = { throughSeq: d.throughSeq, summary: d.summary, foldId: d.foldId };
    }
  }
  return { start, fold, goal, tasks };
}

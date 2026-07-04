/**
 * The run journal + resume cache (plan 21 M4). Each `agent()` invocation is wrapped by
 * `journaledAgent`: it consumes its deterministic call ordinal (ordinal.ts, D-019), fingerprints
 * `(prompt, opts)`, and either replays the cached result (an unchanged prefix on resume) or runs the
 * leaf live - emitting a `workflow.agent` event that carries the ordinal + fingerprint + Usage + the
 * typed result. Resume keys by ORDINAL (not content), using the fingerprint only as the per-position
 * invalidation check; a cached leaf restores its Usage so budget-dependent loops replay identically.
 *
 * Responsible for: the (prompt,opts) fingerprint, the ordinal-keyed resume cache (build from prior
 * `workflow.agent` events), and the `journaledAgent` wrapper that replays-or-runs + journals.
 * Not for: the ordinal machinery (ordinal.ts), running a leaf (leaf-host.ts), or the budget governor
 * (M5 - it wires `onUsage`).
 */
import { events, type TrevorEventInput } from "@trevor/session";
import { Effect } from "effect";
import type { LeafResult, TurnUsage } from "./leaf";
import { consumeOrdinal, type Ordinal, ordinalKey } from "./ordinal";

/**
 * A stable, function-free stringify for fingerprinting: objects key-sorted, arrays in order,
 * functions/undefined dropped. Same effective inputs -> same string; a changed prompt/model/budget
 * changes it. Equality of the raw string IS the per-ordinal invalidation check (D-009).
 */
export function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "function" || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => {
        const rendered = stableStringify(record[key]);
        return rendered === "" ? "" : `${JSON.stringify(key)}:${rendered}`;
      })
      .filter((part) => part !== "");
    return `{${parts.join(",")}}`;
  }
  return "";
}

/** The per-ordinal invalidation key: a stable fingerprint of `(prompt, opts)`. */
export function fingerprint(prompt: string, opts: unknown): string {
  return `${stableStringify(prompt)}|${stableStringify(opts)}`;
}

/** A journaled leaf the cache can replay: its fingerprint, its typed result, and its Usage. */
export interface CachedLeaf {
  readonly fingerprint: string;
  readonly result: LeafResult;
  readonly usage: TurnUsage;
}

export interface RunCache {
  /** A hit iff the ordinal is journaled AND its fingerprint still matches (else re-run live). */
  readonly lookup: (ordinal: Ordinal, fingerprint: string) => CachedLeaf | undefined;
  readonly size: number;
}

/** A fresh-run cache: everything runs live. */
export function emptyCache(): RunCache {
  return { lookup: () => undefined, size: 0 };
}

export function buildRunCache(
  entries: readonly { readonly ordinal: Ordinal; readonly cached: CachedLeaf }[],
): RunCache {
  const byKey = new Map(entries.map((entry) => [ordinalKey(entry.ordinal), entry.cached]));
  return {
    lookup: (ordinal, fp) => {
      const hit = byKey.get(ordinalKey(ordinal));
      return hit !== undefined && hit.fingerprint === fp ? hit : undefined;
    },
    size: byKey.size,
  };
}

/** Reconstruct a resume cache from a prior run's journaled `workflow.agent` events. */
export function cacheFromEvents(
  journalEvents: readonly { readonly type: string; readonly payload: Record<string, unknown> }[],
): RunCache {
  const entries: { ordinal: Ordinal; cached: CachedLeaf }[] = [];
  for (const event of journalEvents) {
    if (event.type !== "workflow.agent") {
      continue;
    }
    const payload = event.payload;
    const ordinal = Array.isArray(payload.ordinal) ? (payload.ordinal as number[]) : [];
    const fp = typeof payload.fingerprint === "string" ? payload.fingerprint : "";
    const result = payload.result as LeafResult | undefined;
    const usage = (payload.usage as TurnUsage | undefined) ?? { input: 0, output: 0 };
    if (result !== undefined) {
      entries.push({ ordinal, cached: { fingerprint: fp, result, usage } });
    }
  }
  return buildRunCache(entries);
}

/** What the journaled `agent()` wrapper needs: the run id, the resume cache, the event sink, and an
 *  optional Usage hook (the budget governor wires it in M5). */
export interface AgentJournal {
  readonly runId: string;
  readonly cache: RunCache;
  readonly emit: (event: TrevorEventInput) => Effect.Effect<void>;
  readonly onUsage?: (usage: TurnUsage) => Effect.Effect<void>;
}

const usageOf = (result: LeafResult): TurnUsage =>
  result.ok ? result.usage : { input: 0, output: 0 };

/**
 * Wrap one `agent()` invocation for the journal + resume. Consumes its ordinal, and on a cache hit
 * (unchanged ordinal + fingerprint) restores the cached Usage and replays the journaled result; else
 * runs the leaf live. Either way it emits a `workflow.agent` event and returns the SAME typed result,
 * so this is one call ordinal whether replayed or live (D-019). Never throws.
 */
export function journaledAgent<E = never>(
  journal: AgentJournal,
  prompt: string,
  opts: unknown,
  live: () => Effect.Effect<LeafResult, E>,
): Effect.Effect<LeafResult, E> {
  return Effect.gen(function* () {
    const ordinal = yield* consumeOrdinal;
    const fp = fingerprint(prompt, opts);

    const cached = journal.cache.lookup(ordinal, fp);
    if (cached !== undefined) {
      if (journal.onUsage !== undefined) {
        yield* journal.onUsage(cached.usage);
      }
      yield* journal.emit(
        events.workflowAgent({
          runId: journal.runId,
          ordinal,
          fingerprint: fp,
          status: "replayed",
          usage: cached.usage,
          result: cached.result,
        }),
      );
      return cached.result;
    }

    const result = yield* live();
    const usage = usageOf(result);
    if (journal.onUsage !== undefined) {
      yield* journal.onUsage(usage);
    }
    yield* journal.emit(
      events.workflowAgent({
        runId: journal.runId,
        ordinal,
        fingerprint: fp,
        status: "completed",
        usage,
        result,
      }),
    );
    return result;
  });
}

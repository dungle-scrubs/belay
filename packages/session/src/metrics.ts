import type { SessionEvent } from "./event";
import type { ProviderIncidentReason, Usage } from "./protocol";
import { decodeTrevorEvent } from "./protocol-decode";

/**
 * The usage-metrics READ MODEL (plan 43). A pure, presentation-free projection of the durable session
 * log into aggregate usage - the single source both the host and the web usage surface derive from,
 * kept beside the token-`breakdown` schema (its sibling) so the two never drift. This is deliberately a
 * derived read model, not new persistence: it folds `readonly SessionEvent[]` the store already keeps,
 * so there is nothing extra to write, migrate, or reap.
 *
 * Three properties the contract holds to on purpose:
 *
 *  - REDACTION. A metric carries only opaque ids (runId/model/provider), typed enum reasons, and
 *    numeric counts - never prompt/answer text, never a provider's free-text `diagnostic.detail`. So a
 *    summary can be copied/exported without leaking conversation content or secrets.
 *  - PER-SEGMENT ATTRIBUTION. A single turn can span multiple models/reasoning levels via the plan 09.1
 *    `model.switched` event. Usage is therefore partitioned PER MODEL SEGMENT, split at each applied
 *    switch, never attributed to one model per turn. `input` (context size) is NOT summed across
 *    segments - it is an overlapping running total, so only `output` tokens and wall-time sum; `input`
 *    is reported as a peak.
 *  - HONEST TRUST. Every provider reports usage differently (some never report a context window or
 *    per-step usage at all). A segment/turn with no measured usage sample is marked `trusted: false`
 *    with zeroed figures rather than guessed, so a caller can label estimates conservatively.
 *
 * Metrics are read-only and never influence model selection or routing - this module has no write side.
 */

/** How a turn terminated. `in_flight` is a turn still running (no terminal `assistant.completed`). */
export type TurnOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "no_reply"
  | "in_flight";

/**
 * Usage attributed to ONE model/reasoning segment of a turn - the span between two applied
 * `model.switched` boundaries (or the whole turn when it never switched). `outputTokens`/`genMs` are the
 * segment's own delta (summable); `inputPeakTokens` is the largest prompt size observed in the segment
 * (a peak, NOT summable - the context overlaps the neighbouring segments).
 */
export interface SegmentUsage {
  readonly model: string;
  /** The reasoning/effort level in effect, when the selection carried one. */
  readonly reasoning?: string;
  /** The provider/source the segment ran under (a switch keeps the turn's source). */
  readonly provider: string;
  /** Generated (output) tokens attributed to this segment - summed across its steps. */
  readonly outputTokens: number;
  /** Peak prompt/context tokens observed in this segment. Never summed with other segments. */
  readonly inputPeakTokens: number;
  /** The reported context window at this segment, or 0 when the provider never reported one. */
  readonly contextWindow: number;
  /** Generation wall-time attributed to this segment (ms), summed across its steps. */
  readonly genMs: number;
  /** Measured usage samples folded in. 0 means no usage was reported, so the figures are untrusted. */
  readonly samples: number;
  /** True when at least one usage sample backs this segment's token/latency figures. */
  readonly trusted: boolean;
}

/** Usage for one turn (`runId`), split into per-model segments. */
export interface TurnUsage {
  readonly runId: string;
  /** 0-based ordinal by `assistant.started` order within the session. */
  readonly index: number;
  /** Epoch-ms of `assistant.started`, or null when unparseable/absent. */
  readonly startedAt: number | null;
  /** Epoch-ms of `assistant.completed`, or null while the turn is still in flight. */
  readonly completedAt: number | null;
  /** The provider/source the turn started on. */
  readonly provider: string;
  /** Per-model segments in seq order - length > 1 only for a mid-turn switch. */
  readonly segments: readonly SegmentUsage[];
  readonly outcome: TurnOutcome;
  /** The typed provider incident reason when the turn failed, else undefined (redacted of free text). */
  readonly failureReason?: ProviderIncidentReason;
  /** Provider auto-retries (`assistant.reconnecting`) observed during the turn. */
  readonly retries: number;
  /** Applied mid-turn model switches. */
  readonly switches: number;
  /** Summed output tokens across segments. */
  readonly outputTokens: number;
  /** Peak context tokens across the whole turn (max segment peak). */
  readonly inputPeakTokens: number;
  /** Summed generation wall-time (ms). */
  readonly genMs: number;
  /** True when every segment's figures are trusted (no missing-usage segment). */
  readonly trusted: boolean;
}

/** Aggregate totals over a set of turns. `output`/`genMs` sum; `input` is a peak, never a sum. */
export interface UsageTotals {
  readonly turns: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly retries: number;
  readonly switches: number;
  readonly outputTokens: number;
  readonly genMs: number;
  /** The largest single-turn peak context observed - the honest "how big did context get". */
  readonly peakInputTokens: number;
  /** True when every folded turn's figures were trusted (no missing-usage turn). */
  readonly trusted: boolean;
}

/** Per-provider (source) rollup. A turn's segments share its source, so this rolls up whole turns. */
export interface ProviderUsage extends UsageTotals {
  readonly provider: string;
}

/** Per-model rollup over SEGMENTS, so a mid-turn switch splits a turn across two model rows. */
export interface ModelUsage {
  readonly model: string;
  readonly outputTokens: number;
  readonly genMs: number;
  readonly peakInputTokens: number;
  readonly segments: number;
  readonly trusted: boolean;
}

/** A typed failure row: how often each provider incident reason terminated a turn. */
export interface IncidentRow {
  readonly reason: ProviderIncidentReason;
  readonly count: number;
}

/** The whole read model for a session (or a time-windowed slice of it). */
export interface SessionUsage {
  readonly totals: UsageTotals;
  readonly turns: readonly TurnUsage[];
  readonly byProvider: readonly ProviderUsage[];
  readonly byModel: readonly ModelUsage[];
  readonly incidents: readonly IncidentRow[];
}

/** A time window over turns, by `startedAt`: `[from, to)` (both bounds optional). */
export interface UsageWindow {
  /** Inclusive lower bound (epoch-ms); a turn counts when `startedAt >= from`. */
  readonly from?: number;
  /** Exclusive upper bound (epoch-ms); a turn counts when `startedAt < to`. */
  readonly to?: number;
}

/**
 * Defensive segment cap per turn: a turn's segments are bounded by its applied switches, themselves
 * bounded by the host's step budget - but a corrupt/adversarial log must not grow this array without
 * bound, so past the cap further switches fold into the current segment rather than opening a new one.
 */
const MAX_SEGMENTS_PER_TURN = 256;

/** The turn's selected model/reasoning carried from the preceding `user.message`, seeding segment 0. */
interface PendingSelection {
  readonly provider?: string;
  readonly modelId?: string;
  readonly reasoning?: string;
}

interface SegmentBuilder {
  model: string;
  reasoning?: string;
  provider: string;
  startCumOutput: number;
  startCumGenMs: number;
  inputPeak: number;
  contextWindow: number;
  samples: number;
}

interface TurnBuilder {
  runId: string;
  index: number;
  startedAt: number | null;
  provider: string;
  /** Segments already closed at a `model.switched` boundary; `current` is the open one. */
  segments: SegmentUsage[];
  current: SegmentBuilder;
  cumOutput: number;
  cumGenMs: number;
  retries: number;
  switches: number;
}

/** Epoch-ms from an event's ISO `createdAt`, or null when unparseable. */
function eventTime(event: SessionEvent): number | null {
  const ms = Date.parse(event.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

function openSegment(
  model: string,
  reasoning: string | undefined,
  provider: string,
  startCumOutput: number,
  startCumGenMs: number,
): SegmentBuilder {
  return {
    model,
    ...(reasoning !== undefined ? { reasoning } : {}),
    provider,
    startCumOutput,
    startCumGenMs,
    inputPeak: 0,
    contextWindow: 0,
    samples: 0,
  };
}

/** Folds the turn's running cumulative usage into the open segment's peak/window/sample counters. */
function noteUsage(turn: TurnBuilder, usage: Usage): void {
  // output/genMs are cumulative across the whole turn (turn.ts never resets them at a switch), so a
  // segment's own total is its end-cumulative minus its start-cumulative, computed at close.
  turn.cumOutput = usage.output;
  turn.cumGenMs = usage.genMs;
  // input/contextWindow are the latest step's snapshot (current context), so the segment keeps the peak.
  turn.current.inputPeak = Math.max(turn.current.inputPeak, usage.input);
  if (usage.contextWindow > 0) {
    turn.current.contextWindow = usage.contextWindow;
  }
  turn.current.samples += 1;
}

/** Materializes an open segment builder into the immutable {@link SegmentUsage} at its close. */
function closeSegment(turn: TurnBuilder, seg: SegmentBuilder): SegmentUsage {
  const outputTokens = Math.max(0, turn.cumOutput - seg.startCumOutput);
  const genMs = Math.max(0, turn.cumGenMs - seg.startCumGenMs);
  return {
    model: seg.model,
    ...(seg.reasoning !== undefined ? { reasoning: seg.reasoning } : {}),
    provider: seg.provider,
    outputTokens,
    inputPeakTokens: seg.inputPeak,
    contextWindow: seg.contextWindow,
    genMs,
    samples: seg.samples,
    trusted: seg.samples > 0,
  };
}

/** Picks the terminal outcome + typed reason from a decoded `assistant.completed`. */
function outcomeOf(completed: {
  readonly cancelled: boolean;
  readonly interrupted: boolean;
  readonly noReply: boolean;
  readonly error?: string;
  readonly diagnostic?: { readonly reason: ProviderIncidentReason };
}): { outcome: TurnOutcome; failureReason?: ProviderIncidentReason } {
  if (completed.cancelled) {
    return { outcome: "cancelled" };
  }
  if (completed.interrupted) {
    return { outcome: "interrupted" };
  }
  if (completed.error !== undefined || completed.diagnostic !== undefined) {
    return {
      outcome: "failed",
      ...(completed.diagnostic ? { failureReason: completed.diagnostic.reason } : {}),
    };
  }
  if (completed.noReply) {
    return { outcome: "no_reply" };
  }
  return { outcome: "completed" };
}

/** Finalizes a turn builder (closing its open segment) into an immutable {@link TurnUsage}. */
function finalizeTurn(
  turn: TurnBuilder,
  outcome: TurnOutcome,
  completedAt: number | null,
  failureReason?: ProviderIncidentReason,
): TurnUsage {
  const segments = [...turn.segments, closeSegment(turn, turn.current)];
  const outputTokens = segments.reduce((sum, s) => sum + s.outputTokens, 0);
  const genMs = segments.reduce((sum, s) => sum + s.genMs, 0);
  const inputPeakTokens = segments.reduce((max, s) => Math.max(max, s.inputPeakTokens), 0);
  return {
    runId: turn.runId,
    index: turn.index,
    startedAt: turn.startedAt,
    completedAt,
    provider: turn.provider,
    segments,
    outcome,
    ...(failureReason !== undefined ? { failureReason } : {}),
    retries: turn.retries,
    switches: turn.switches,
    outputTokens,
    inputPeakTokens,
    genMs,
    trusted: segments.every((s) => s.trusted),
  };
}

/**
 * Projects the durable log into per-turn usage, partitioned per model/reasoning segment (plan 43 M2).
 * Turns are keyed by `runId` and finalized on `assistant.completed`; a turn still in flight at the end
 * of the log is emitted with outcome `in_flight` and whatever usage streamed so far. Pure and
 * seq-ordered (the input is sorted defensively, since the segment split depends on order).
 */
export function collectTurns(events: readonly SessionEvent[]): readonly TurnUsage[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const active = new Map<string, TurnBuilder>();
  const finished: TurnUsage[] = [];
  let pending: PendingSelection = {};
  let started = 0;

  for (const event of ordered) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }

    if (decoded.type === "user.message") {
      pending = {
        ...(decoded.provider ? { provider: decoded.provider } : {}),
        ...(decoded.model?.modelId ? { modelId: decoded.model.modelId } : {}),
        ...(decoded.model?.reasoning
          ? { reasoning: decoded.model.reasoning }
          : decoded.reasoning
            ? { reasoning: decoded.reasoning }
            : {}),
      };
      continue;
    }

    if (decoded.type === "assistant.started") {
      const provider = decoded.provider ?? pending.provider ?? "unknown";
      const model = decoded.model || pending.modelId || "unknown";
      const turn: TurnBuilder = {
        runId: decoded.runId,
        index: started,
        startedAt: eventTime(event),
        provider,
        segments: [],
        current: openSegment(model, pending.reasoning, provider, 0, 0),
        cumOutput: 0,
        cumGenMs: 0,
        retries: 0,
        switches: 0,
      };
      active.set(decoded.runId, turn);
      started += 1;
      continue;
    }

    if (decoded.type === "assistant.progress") {
      const turn = active.get(decoded.runId);
      if (turn && decoded.usage) {
        noteUsage(turn, decoded.usage);
      }
      continue;
    }

    if (decoded.type === "assistant.reconnecting") {
      const turn = active.get(decoded.runId);
      if (turn) {
        turn.retries += 1;
      }
      continue;
    }

    if (decoded.type === "model.switched") {
      const turn = active.get(decoded.runId);
      // A blocked switch never moved the model (D-007), so it opens no new segment - mirror fork.ts.
      if (turn && decoded.outcome === "applied") {
        turn.switches += 1;
        if (turn.segments.length < MAX_SEGMENTS_PER_TURN) {
          turn.segments.push(closeSegment(turn, turn.current));
          turn.current = openSegment(
            decoded.to.model,
            decoded.to.reasoning,
            turn.current.provider,
            turn.cumOutput,
            turn.cumGenMs,
          );
        }
      }
      continue;
    }

    if (decoded.type === "assistant.completed") {
      const turn = active.get(decoded.runId);
      if (!turn) {
        continue;
      }
      if (decoded.usage) {
        noteUsage(turn, decoded.usage);
      }
      const { outcome, failureReason } = outcomeOf(decoded);
      finished.push(finalizeTurn(turn, outcome, eventTime(event), failureReason));
      active.delete(decoded.runId);
    }
  }

  // Turns still in flight at the end of the log (no terminal completion) - emit their partial usage.
  for (const turn of active.values()) {
    finished.push(finalizeTurn(turn, "in_flight", null));
  }

  return finished.sort((a, b) => a.index - b.index);
}

/** Whether a turn's `startedAt` falls inside a window (a turn with no time counts as inside). */
function inWindow(turn: TurnUsage, window: UsageWindow): boolean {
  if (turn.startedAt === null) {
    return true;
  }
  if (window.from !== undefined && turn.startedAt < window.from) {
    return false;
  }
  if (window.to !== undefined && turn.startedAt >= window.to) {
    return false;
  }
  return true;
}

/** Folds a set of turns into the additive totals (output/genMs sum; input is a peak). */
function foldTotals(turns: readonly TurnUsage[]): UsageTotals {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let retries = 0;
  let switches = 0;
  let outputTokens = 0;
  let genMs = 0;
  let peakInputTokens = 0;
  let trusted = true;
  for (const turn of turns) {
    if (turn.outcome === "completed") {
      completed += 1;
    } else if (turn.outcome === "failed") {
      failed += 1;
    } else if (turn.outcome === "cancelled") {
      cancelled += 1;
    }
    retries += turn.retries;
    switches += turn.switches;
    outputTokens += turn.outputTokens;
    genMs += turn.genMs;
    peakInputTokens = Math.max(peakInputTokens, turn.inputPeakTokens);
    trusted = trusted && turn.trusted;
  }
  return {
    turns: turns.length,
    completed,
    failed,
    cancelled,
    retries,
    switches,
    outputTokens,
    genMs,
    peakInputTokens,
    trusted: turns.length === 0 ? true : trusted,
  };
}

/** Rolls turns up by provider/source, in descending output-token order. */
function foldProviders(turns: readonly TurnUsage[]): readonly ProviderUsage[] {
  const byProvider = new Map<string, TurnUsage[]>();
  for (const turn of turns) {
    const bucket = byProvider.get(turn.provider) ?? [];
    bucket.push(turn);
    byProvider.set(turn.provider, bucket);
  }
  return [...byProvider.entries()]
    .map(([provider, bucket]) => ({ provider, ...foldTotals(bucket) }))
    .sort((a, b) => b.outputTokens - a.outputTokens);
}

/** Rolls SEGMENTS up by model, in descending output-token order (a switch splits a turn's rows). */
function foldModels(turns: readonly TurnUsage[]): readonly ModelUsage[] {
  const byModel = new Map<
    string,
    {
      outputTokens: number;
      genMs: number;
      peakInputTokens: number;
      segments: number;
      trusted: boolean;
    }
  >();
  for (const turn of turns) {
    for (const seg of turn.segments) {
      const acc = byModel.get(seg.model) ?? {
        outputTokens: 0,
        genMs: 0,
        peakInputTokens: 0,
        segments: 0,
        trusted: true,
      };
      acc.outputTokens += seg.outputTokens;
      acc.genMs += seg.genMs;
      acc.peakInputTokens = Math.max(acc.peakInputTokens, seg.inputPeakTokens);
      acc.segments += 1;
      acc.trusted = acc.trusted && seg.trusted;
      byModel.set(seg.model, acc);
    }
  }
  return [...byModel.entries()]
    .map(([model, acc]) => ({ model, ...acc }))
    .sort((a, b) => b.outputTokens - a.outputTokens);
}

/** Counts failed turns by their typed incident reason, in descending count order (bounded by the enum). */
function foldIncidents(turns: readonly TurnUsage[]): readonly IncidentRow[] {
  const byReason = new Map<ProviderIncidentReason, number>();
  for (const turn of turns) {
    if (turn.outcome === "failed" && turn.failureReason !== undefined) {
      byReason.set(turn.failureReason, (byReason.get(turn.failureReason) ?? 0) + 1);
    }
  }
  return [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Aggregates already-projected turns into the {@link SessionUsage} read model, optionally scoped to a
 * time window. Cardinality is bounded by design: provider/model keys are ids (bounded by the catalog)
 * and incident reasons are a fixed enum, so no rollup grows without bound.
 */
export function aggregateUsage(
  turns: readonly TurnUsage[],
  window: UsageWindow = {},
): SessionUsage {
  const scoped = turns.filter((turn) => inWindow(turn, window));
  return {
    totals: foldTotals(scoped),
    turns: scoped,
    byProvider: foldProviders(scoped),
    byModel: foldModels(scoped),
    incidents: foldIncidents(scoped),
  };
}

/** Convenience: project the log and aggregate in one call (optionally windowed). */
export function sessionUsage(
  events: readonly SessionEvent[],
  window: UsageWindow = {},
): SessionUsage {
  return aggregateUsage(collectTurns(events), window);
}

/** A compact fixed-notation token count for the plain-text export (e.g. 6100 -> "6.1k"). */
function reportTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * A conservative, source-attributed plain-text export of a usage summary (plan 43 M3), for the
 * copy/export affordance. Every token/latency figure is labelled - `~` marks a value that includes an
 * untrusted (unmeasured) turn, and input is labelled a peak so it is never read as a sum. Deterministic
 * and text-only (no ids beyond model/provider), so it unit-tests on its own and leaks no content.
 */
export function formatUsageReport(usage: SessionUsage): string {
  const { totals } = usage;
  if (totals.turns === 0) {
    return "No usage recorded yet.";
  }
  const approx = totals.trusted ? "" : "~";
  const lines: string[] = [
    "Usage summary",
    `Turns: ${totals.turns} (${totals.completed} completed, ${totals.failed} failed, ${totals.cancelled} cancelled)`,
    `Output tokens: ${approx}${reportTokens(totals.outputTokens)}`,
    `Peak context: ${reportTokens(totals.peakInputTokens)} tokens`,
    `Generation time: ${(totals.genMs / 1000).toFixed(1)}s`,
    `Retries: ${totals.retries} · Model switches: ${totals.switches}`,
  ];
  if (usage.byProvider.length > 0) {
    lines.push("", "By provider:");
    for (const p of usage.byProvider) {
      lines.push(`  ${p.provider}: ${reportTokens(p.outputTokens)} out · ${p.turns} turns`);
    }
  }
  if (usage.byModel.length > 0) {
    lines.push("", "By model:");
    for (const m of usage.byModel) {
      const est = m.trusted ? "" : "~";
      lines.push(
        `  ${m.model}: ${est}${reportTokens(m.outputTokens)} out · ${m.segments} segments`,
      );
    }
  }
  if (usage.incidents.length > 0) {
    lines.push("", "Failures:");
    for (const i of usage.incidents) {
      lines.push(`  ${i.reason}: ${i.count}`);
    }
  }
  return lines.join("\n");
}

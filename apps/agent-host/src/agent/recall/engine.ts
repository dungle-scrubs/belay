import type { SessionEvent } from "@trevor/session";
import { Effect } from "effect";
import { warn } from "../../log";
import type { Provider } from "../../providers";
import { assembleCorpus, type SessionInput } from "./corpus";
import { distillRecall } from "./distill";
import { expandNeighborhoods, type NeighborhoodCaps } from "./neighborhood";
import { type RecallSearchCaps, searchCorpus } from "./search";
import type {
  RecallActivity,
  RecallCitedSource,
  RecallDiagnostic,
  RecallFilters,
  RecallNeighborhood,
  RecallResult,
  RecallSessionRef,
  RecallStatus,
} from "./types";

/**
 * The recall orchestrator (D-044): assemble the corpus, search it, expand the top anchors into
 * bounded neighborhoods, run the isolated reasoning pass, and project a typed {@link RecallResult}.
 * The impure inputs - reading the current session, enumerating + reading project siblings, and
 * the reasoning provider - are behind {@link RecallDeps}, so `runRecall` is testable end to end
 * with a fake reader + fake provider.
 */

/** The current session's live state the engine reads from host memory (no transport). */
export interface CurrentSessionView {
  readonly sessionId: string;
  readonly label: string;
  readonly project: string | null;
  readonly events: readonly SessionEvent[];
  /** Latest fold throughSeq: the boundary between compacted-away (recallable) and active prompt. */
  readonly foldThroughSeq: number | null;
}

/** One readable sibling session: its provenance + full durable event log. */
export interface SiblingSession {
  readonly session: RecallSessionRef;
  readonly events: readonly SessionEvent[];
}

/** The result of enumerating + reading sibling sessions: what was read + what could not be. */
export interface SiblingRead {
  readonly sessions: readonly SiblingSession[];
  readonly diagnostics: readonly RecallDiagnostic[];
}

/** The impure data + provider seam the engine depends on (injected; faked in tests). */
export interface RecallDeps {
  readonly current: () => CurrentSessionView;
  readonly siblings: () => Promise<SiblingRead>;
  /** The provider for the reasoning pass (the current/last turn's model), or null if none. */
  readonly provider: () => Provider | null;
}

/** A recall request: the query plus optional filters and caps. */
export interface RecallRequest {
  readonly query: string;
  readonly filters?: RecallFilters;
  readonly searchCaps?: RecallSearchCaps;
  readonly neighborhoodCaps?: NeighborhoodCaps;
}

/** Counts context.compacted events in a log (the folded spans available to search). */
function countFolds(events: readonly SessionEvent[]): number {
  return events.reduce((n, event) => (event.type === "context.compacted" ? n + 1 : n), 0);
}

/** Rejects semantically invalid filters (e.g. an inverted turn range) before any work. */
function invalidFilterReason(filters: RecallFilters | undefined): string | null {
  const range = filters?.turnRange;
  if (range && range.fromSeq != null && range.toSeq != null && range.fromSeq > range.toSeq) {
    return `turnRange.fromSeq (${range.fromSeq}) is after toSeq (${range.toSeq})`;
  }
  return null;
}

/** Builds a transcript source row from a neighborhood's anchor record. */
function sourceOf(neighborhood: RecallNeighborhood): RecallCitedSource {
  const { record } = neighborhood.anchor;
  return {
    id: record.id,
    sessionId: record.session.sessionId,
    sessionLabel: record.session.label,
    origin: record.session.origin,
    seq: record.seq,
    range: record.range,
    kind: record.kind,
    timestamp: record.timestamp,
    excerpt: neighborhood.anchor.excerpt,
  };
}

/**
 * An engine-level diagnostic not tied to a specific session: the empty `sessionId` is the "not a
 * particular session" encoding. The one owner of that convention, so neither the engine's six call
 * sites nor the sibling reader hand-spell `{ sessionId: "" }`.
 */
export function engineDiagnostic(kind: RecallDiagnostic["kind"], detail: string): RecallDiagnostic {
  return { sessionId: "", kind, detail };
}

/** A recall-activity counter; callers override only the fields they have actually searched. */
function recallActivity(over: Partial<RecallActivity> = {}): RecallActivity {
  return {
    searchedSessions: 0,
    searchedFolds: 0,
    searchedRecords: 0,
    anchors: 0,
    neighborhoods: 0,
    ...over,
  };
}

/** A status is `partial` when any diagnostics accompany it, else the base status. */
function resolveStatus(base: RecallStatus, diagnostics: readonly RecallDiagnostic[]): RecallStatus {
  return diagnostics.length > 0 ? "partial" : base;
}

/** An empty-result envelope carrying a status, the query, diagnostics, and the activity so far. */
function empty(
  query: string,
  status: RecallStatus,
  diagnostics: readonly RecallDiagnostic[],
  activity: RecallActivity,
): RecallResult {
  return { status, query, findings: [], sources: [], diagnostics, activity };
}

/**
 * Runs one recall end to end and returns a typed result. Never throws: a provider failure in the
 * reasoning pass is caught and surfaced as an `error` status with the sources still attached, and
 * unreadable/empty sessions ride back as diagnostics so the absence of a hit is always explained.
 */
export async function runRecall(deps: RecallDeps, request: RecallRequest): Promise<RecallResult> {
  const query = request.query.trim();
  if (!query) {
    return empty(
      request.query,
      "invalid_filters",
      [engineDiagnostic("skipped", "empty query")],
      recallActivity(),
    );
  }

  const badFilter = invalidFilterReason(request.filters);
  if (badFilter) {
    return empty(
      query,
      "invalid_filters",
      [engineDiagnostic("skipped", badFilter)],
      recallActivity(),
    );
  }

  const current = deps.current();
  const siblingRead = await deps.siblings();

  const inputs: SessionInput[] = [
    {
      session: {
        sessionId: current.sessionId,
        label: current.label,
        project: current.project,
        origin: "current-compacted",
      },
      events: current.events,
      currentFoldThroughSeq: current.foldThroughSeq,
    },
    ...siblingRead.sessions.map((sibling) => ({
      session: sibling.session,
      events: sibling.events,
    })),
  ];

  const corpus = assembleCorpus(inputs);
  const searchedSessions = new Set(corpus.map((record) => record.session.sessionId)).size;
  const searchedFolds =
    countFolds(current.events) + siblingRead.sessions.reduce((n, s) => n + countFolds(s.events), 0);
  const diagnostics = [...siblingRead.diagnostics];

  if (corpus.length === 0) {
    // Nothing recallable at all: no fold has happened yet AND no sibling sessions were readable.
    return empty(
      query,
      resolveStatus("unavailable", diagnostics),
      diagnostics,
      recallActivity({ searchedSessions, searchedFolds }),
    );
  }

  const { anchors, searchedRecords } = searchCorpus(
    corpus,
    query,
    request.filters,
    request.searchCaps,
  );

  if (anchors.length === 0) {
    return empty(
      query,
      resolveStatus("no_hits", diagnostics),
      diagnostics,
      recallActivity({ searchedSessions, searchedFolds, searchedRecords }),
    );
  }

  const { neighborhoods, droppedAnchors } = expandNeighborhoods(
    corpus,
    anchors,
    request.neighborhoodCaps,
  );
  if (droppedAnchors > 0) {
    diagnostics.push(
      engineDiagnostic(
        "skipped",
        `${droppedAnchors} lower-ranked anchor(s) dropped at the recall context budget`,
      ),
    );
  }

  const sources = neighborhoods.map(sourceOf);
  const provider = deps.provider();

  const baseActivity = recallActivity({
    searchedSessions,
    searchedFolds,
    searchedRecords,
    anchors: anchors.length,
    neighborhoods: neighborhoods.length,
  });

  if (!provider) {
    diagnostics.push(
      engineDiagnostic("unreadable", "no provider available for the recall reasoning pass"),
    );
    return { status: "error", query, findings: [], sources, diagnostics, activity: baseActivity };
  }

  const distilled = await Effect.runPromise(
    distillRecall(provider, { query, neighborhoods }).pipe(
      Effect.map((output) => ({ ok: true as const, output })),
      Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
    ),
  );

  if (!distilled.ok) {
    warn("recall", "reasoning pass failed", { error: distilled.error.message });
    diagnostics.push(
      engineDiagnostic("unreadable", `reasoning pass failed: ${distilled.error.message}`),
    );
    return { status: "error", query, findings: [], sources, diagnostics, activity: baseActivity };
  }

  const citations = distilled.output.citedSources
    .map((index) => neighborhoods[index - 1]?.anchor.record.id)
    .filter((id): id is string => Boolean(id));

  const findings = distilled.output.text ? [{ summary: distilled.output.text, citations }] : [];
  const status = findings.length === 0 ? "no_hits" : resolveStatus("ok", diagnostics);

  return { status, query, findings, sources, diagnostics, activity: baseActivity };
}

/**
 * The host-configured recall engine singleton. The host wires its live deps (current session view,
 * sibling reader over the transport, provider) at startup; the `session_recall` tool calls
 * `recall`. Mirrors the contextRegistry/taskRegistry module-singleton pattern, so a tool that
 * needs host state reaches it without threading it through the generic tool executor. Unconfigured
 * (e.g. a unit test that never wired it) returns a clean `unavailable` rather than throwing.
 */
class RecallEngine {
  private deps: RecallDeps | null = null;

  configure(deps: RecallDeps): void {
    this.deps = deps;
  }

  recall(request: RecallRequest): Promise<RecallResult> {
    if (!this.deps) {
      return Promise.resolve(
        empty(
          request.query,
          "unavailable",
          [engineDiagnostic("unreadable", "recall engine not configured on this host")],
          recallActivity(),
        ),
      );
    }
    return runRecall(this.deps, request);
  }
}

export const recallEngine = new RecallEngine();

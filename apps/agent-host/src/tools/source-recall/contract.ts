/**
 * Responsible for: the host-internal `SourceRecallProvider` contract every indexed-source adapter
 * implements - capability discovery, index status, conceptual query, and refresh - plus the
 * normalized host-domain input/output shapes those methods speak. This is the provider BOUNDARY
 * (D-002): Belay's tools depend on this contract and the {@link SourceRecallResult} wire model,
 * never on a backend's raw endpoints or response schema. `source-recall` (the local FastAPI daemon)
 * is the first concrete adapter; Aleutian Trace is the second, behind the same interface.
 *
 * Not for: the serializable wire result the web renders (that is `@belay/session/source-recall`) or
 * any one backend's HTTP shapes (those stay inside each adapter).
 */

import type {
  SourceRecallCapability,
  SourceRecallProviderKind,
  SourceRecallReadiness,
  SourceRecallRepoStatus,
  SourceRecallResultItem,
} from "@belay/session";
import type { Effect } from "effect";
import type { SourceRecallProviderError } from "./errors";

/** Per-item snippet cap: retrieval candidates are CITED, not dumped whole (D-003 / risk register). Owned
 *  here at the provider boundary so every adapter shares one authority - a new backend can't silently pick
 *  a different cap. */
export const MAX_SNIPPET_CHARS = 1200;

/** What a provider reports after discovery: whether it is reachable/ready and which capabilities it offers. */
export interface SourceRecallDiscovery {
  readonly reachable: boolean;
  readonly readiness: SourceRecallReadiness;
  readonly capabilities: readonly SourceRecallCapability[];
  /** A short, redacted health note for diagnostics (version/status), never a raw body or URL. */
  readonly note: string;
}

/** A normalized index-status snapshot: the repos a provider serves and each repo's readiness/freshness. */
export interface SourceRecallStatusSnapshot {
  readonly capabilities: readonly SourceRecallCapability[];
  readonly repos: readonly SourceRecallRepoStatus[];
}

/** The normalized query input a provider answers (bounded top_k, optional repo scope). */
export interface SourceRecallQueryInput {
  readonly query: string;
  readonly repo?: string;
  readonly topK: number;
  /** The active project root, used by adapters that must initialize a graph/index for the project. */
  readonly projectRoot?: string;
}

/** A normalized query answer: cited candidates plus the queried index's freshness and latency. */
export interface SourceRecallQueryAnswer {
  readonly items: readonly SourceRecallResultItem[];
  readonly repo: string | null;
  readonly freshness: import("@belay/session").SourceRecallFreshness | null;
  readonly latencyMs: number;
  /** True when at least one candidate's snippet was truncated to its per-item bound. */
  readonly truncated: boolean;
}

/** A normalized refresh answer. */
export interface SourceRecallRefreshAnswer {
  readonly repo: string | null;
  readonly filesUpdated: number;
  readonly refreshMs: number;
}

/**
 * One indexed-source provider adapter. Every method returns a typed Effect: the success channel is
 * the normalized answer, the failure channel a {@link SourceRecallProviderError} the tool maps to a
 * visible diagnostic. Adapters never throw and never mutate the workspace - source recall is
 * retrieval only.
 */
export interface SourceRecallProvider {
  /** Stable provider id, e.g. `source-recall:local` or `aleutian:trace`. */
  readonly id: string;
  readonly kind: SourceRecallProviderKind;
  /** Health + capability discovery; the tool degrades cleanly when this reports unreachable. */
  discover(): Effect.Effect<SourceRecallDiscovery, SourceRecallProviderError>;
  /** Index status/readiness for the provider's repos. */
  status(repo?: string): Effect.Effect<SourceRecallStatusSnapshot, SourceRecallProviderError>;
  /** Conceptual indexed-code query; returns bounded, cited candidates. */
  query(
    input: SourceRecallQueryInput,
  ): Effect.Effect<SourceRecallQueryAnswer, SourceRecallProviderError>;
  /** Explicit, user-directed incremental re-index. */
  refresh(
    repo?: string,
    projectRoot?: string,
  ): Effect.Effect<SourceRecallRefreshAnswer, SourceRecallProviderError>;
}

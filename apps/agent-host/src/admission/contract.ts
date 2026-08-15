import { shortHash } from "@belay/session";

/**
 * Local admission control - the machine-level vocabulary (plan 11).
 *
 * Admission protects a local model runtime (LM Studio first) from accidental overload, model
 * reload races, and hidden cross-project contention when multiple Belay projects, sessions, or
 * subagents try to stream through the same local endpoint at once. V1 proved the in-process shape
 * (key by concrete provider/baseUrl/model, reserve before dispatch, queue when full, refuse the
 * impossible, release after); V2 keeps those lessons but moves coordination from a process-local
 * `Map` to a cross-process lease+queue store, because the user runs multiple projects and parallel
 * subagents against the same runtime (D-001, D-002).
 *
 * This module owns ONLY the contract: the resource keys, priority classes, owner metadata, release
 * reasons, refusal classes, and the acquire outcome shape. The shared store ({@link ./store}) owns the
 * durable leases/queue; the provider integration owns where admission is acquired. Cloud providers are
 * never admitted here - admission is scoped to `kind: "local"` targets (D-003).
 *
 * Responsible for: the admission vocabulary - resource keys, priority classes, owner/estimate
 * shapes, release reasons, refusal classes, and acquire/poll outcome types.
 * Not for: durable leases/queues (./store) or the wait/hold loop (./runtime).
 */

/**
 * The concrete GENERATION resource an active local stream holds: `local-provider:{providerId}:
 * {normalizedBaseUrl}:{modelId}`. Two streams that resolve to the same key contend for the same model
 * slot (default capacity 1); different models on the same runtime are independent resources.
 */
export function generationResourceKey(
  providerId: string,
  baseUrl: string,
  modelId: string,
): string {
  return `local-provider:${providerId}:${normalizeBaseUrl(baseUrl)}:${modelId}`;
}

/**
 * The LIFECYCLE resource a load/reload operation holds: `local-provider-lifecycle:{providerId}:
 * {normalizedBaseUrl}`. It serializes `lms unload`/`lms load` (and any future load/unload) for an
 * ENDPOINT regardless of model, so two processes never run competing reloads against one runtime.
 */
export function lifecycleResourceKey(providerId: string, baseUrl: string): string {
  return `local-provider-lifecycle:${providerId}:${normalizeBaseUrl(baseUrl)}`;
}

/**
 * The RESIDENCY resource an instance's active-model claim holds: `local-residency:{providerId}:
 * {normalizedBaseUrl}:{modelId}`. Distinct from the generation and lifecycle keys because a claim
 * persists across the instance's active-model lifetime (not one turn); its live COUNT across instances
 * is the reference count the eviction sweep reads (plan 11.1 M3).
 */
export function residencyResourceKey(providerId: string, baseUrl: string, modelId: string): string {
  return `local-residency:${providerId}:${normalizeBaseUrl(baseUrl)}:${modelId}`;
}

/** Whether a resource key is a residency claim rather than a generation/lifecycle admission lease. Both
 *  live in the one shared store, so the admission /doctor summary excludes residency claims (they have
 *  their own projection) to avoid double-counting a resident model as an admission holder (plan 11.1). */
export function isResidencyResourceKey(key: string): boolean {
  return key.startsWith("local-residency:");
}

/** A concrete local model target: its provider id, endpoint base URL, and model id. The generation key
 *  is per model, lifecycle per endpoint, residency per model. */
export interface LocalModelTarget {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** Trims trailing slashes + whitespace so `http://x:1234/v1` and `http://x:1234/v1/` key identically. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** A short, filesystem-safe, collision-resistant hash of a resource key - the lease file's basename
 *  stem (the full key is stored INSIDE the file, so the hash only has to be unique, not readable). */
export function resourceKeyHash(key: string): string {
  return shortHash(key);
}

/**
 * Priority classes for queued local-model work, HIGHEST first (D-004): a foreground user turn beats
 * recovery/continuation, which beats interactive command-backed work, which beats background/subagent
 * work, which beats maintenance/warm work. FIFO applies inside one class. Parallel subagents stay
 * useful without starving or slowing the foreground turn that shares the runtime.
 */
export const ADMISSION_PRIORITIES = [
  "foreground",
  "recovery",
  "command",
  "background",
  "maintenance",
] as const;
export type AdmissionPriority = (typeof ADMISSION_PRIORITIES)[number];

/** The numeric rank of a priority (0 = highest). Unknown values sort last, after maintenance. */
export function priorityRank(priority: AdmissionPriority): number {
  const rank = ADMISSION_PRIORITIES.indexOf(priority);
  return rank === -1 ? ADMISSION_PRIORITIES.length : rank;
}

/**
 * The owner of an admission request: who is waiting/holding, for cross-process attribution, stale
 * reaping (pid), and /doctor. `ownerId` is unique per acquire attempt; `pid`+`hostId` identify the
 * physical process (only it may refresh/release its own records); the rest is best-effort context.
 */
export interface AdmissionOwner {
  /** Unique per acquire attempt (a fresh id even for a retry of the same turn). */
  readonly ownerId: string;
  readonly hostId: string;
  readonly pid: number;
  readonly provider: string;
  readonly model: string;
  readonly sessionId?: string;
  readonly runId?: string;
  /** Subagent/child id when the request is a background delegate. */
  readonly agentId?: string;
  readonly projectRoot?: string;
}

/** The token estimate carried by an admission request, for the V1-provenance context-budget refusals
 *  (refuse a request that cannot fit the model's context window before it ever dispatches). */
export interface AdmissionEstimate {
  readonly estimatedTokens: number;
  readonly maxOutputTokens: number;
  /** The target model's context window in tokens; 0 / unknown disables the budget refusals. */
  readonly contextWindowTokens: number;
}

/** The empty estimate (no budget known) - admission then never refuses on token budget, only queues. */
export const NO_ESTIMATE: AdmissionEstimate = {
  estimatedTokens: 0,
  maxOutputTokens: 0,
  contextWindowTokens: 0,
};

/** Why an active or queued reservation ended. Terminal reasons drive the released event + queue drain. */
export type AdmissionReleaseReason =
  /** The generation/lifecycle work finished normally. */
  | "success"
  /** The provider stream failed (dispatch error / overflow / model error). */
  | "provider_failure"
  /** The turn or subagent was cancelled (fiber interrupt) while holding or waiting. */
  | "cancelled"
  /** The owner was reaped by another client because its pid died or its heartbeat aged out. */
  | "stale_reaped"
  /** The wait exceeded the caller's bound before a slot opened. */
  | "timeout";

/** Why a request was refused BEFORE it could queue or acquire (impossible or store-unavailable). */
export type AdmissionRefusalClass =
  /** The request's own estimate exceeds the model's context window - it can never fit. */
  | "estimated_tokens_exceed_context_window"
  /** Active reservations plus this estimate exceed the context window (V1 active-budget refusal). */
  | "active_reservations_exceed_context_window"
  /** The shared store could not be reached/locked, so admission could not be decided. */
  | "store_unavailable";

/** The immediate outcome of an acquire attempt: granted now, parked in the queue, or refused. A queued
 *  outcome carries the 0-based queue position so a caller can surface "3rd in line". */
export type AdmissionAcquireOutcome =
  | { readonly status: "acquired" }
  | { readonly status: "queued"; readonly position: number }
  | { readonly status: "refused"; readonly refusal: AdmissionRefusalClass };

/** The outcome of polling a queued request: it was promoted, it is still waiting (with its position),
 *  or it is gone (released/reaped/never-queued). */
export type AdmissionPollOutcome =
  | { readonly status: "acquired" }
  | { readonly status: "queued"; readonly position: number }
  | { readonly status: "gone" };

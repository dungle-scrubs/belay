/**
 * Responsible for: the typed failure vocabulary for a source-recall provider adapter - the classes
 * that classify every way a backend HTTP call can degrade (unreachable, timeout, malformed body,
 * missing/unready repo, rate-limited, not-initialized graph). Each carries a bounded `detail` that
 * never leaks a raw daemon body, endpoint URL, or key, so a failure becomes one visible diagnostic
 * line - never a turn crash. The tool layer maps each to a structured `unavailable`/`error` result
 * (like the video-inspect + provider-failure degrade patterns), never a thrown turn failure.
 *
 * Not for: the tool orchestration (tools.ts) or the HTTP transport (http.ts).
 */

import type { SourceRecallDiagnostic } from "@belay/session";
import { Data } from "effect";

/** The configured backend did not answer (connection refused, DNS, socket error). */
export class SourceRecallUnreachableError extends Data.TaggedError("SourceRecallUnreachableError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `source-recall backend unreachable: ${this.detail}`;
  }
}

/** A backend request exceeded its per-provider timeout budget. */
export class SourceRecallTimeoutError extends Data.TaggedError("SourceRecallTimeoutError")<{
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `source-recall backend timed out after ${this.timeoutMs}ms`;
  }
}

/** The backend answered, but the body was not the documented JSON shape (bounded detail, no raw body). */
export class SourceRecallProtocolError extends Data.TaggedError("SourceRecallProtocolError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `source-recall backend returned a malformed response: ${this.detail}`;
  }
}

/** The requested repo is not one the backend serves. */
export class SourceRecallRepoNotFoundError extends Data.TaggedError(
  "SourceRecallRepoNotFoundError",
)<{
  readonly repo: string;
}> {
  override get message(): string {
    return `repo "${this.repo}" is not served by this provider`;
  }
}

/** A multi-repo backend needs an explicit repo but none was supplied. */
export class SourceRecallRepoAmbiguousError extends Data.TaggedError(
  "SourceRecallRepoAmbiguousError",
)<{
  readonly available: readonly string[];
}> {
  override get message(): string {
    return `multiple repos are served; specify one of: ${this.available.join(", ")}`;
  }
}

/** The repo exists but its index is not ready to answer (still indexing / no vectors yet). */
export class SourceRecallRepoNotReadyError extends Data.TaggedError(
  "SourceRecallRepoNotReadyError",
)<{
  readonly repo: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `repo "${this.repo}" index is not ready: ${this.detail}`;
  }
}

/** The backend rate-limited a refresh (source-recall enforces one refresh per repo per 10s). */
export class SourceRecallRateLimitedError extends Data.TaggedError("SourceRecallRateLimitedError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `source-recall refresh rate limited: ${this.detail}`;
  }
}

/** A graph/project must be initialized before this operation (Aleutian GRAPH_NOT_INITIALIZED). */
export class SourceRecallNotInitializedError extends Data.TaggedError(
  "SourceRecallNotInitializedError",
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return `source-recall backend not initialized: ${this.detail}`;
  }
}

/** A capability the caller asked for is not offered by the discovered provider. */
export class SourceRecallCapabilityMissingError extends Data.TaggedError(
  "SourceRecallCapabilityMissingError",
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return `source-recall provider lacks capability: ${this.detail}`;
  }
}

export type SourceRecallProviderError =
  | SourceRecallUnreachableError
  | SourceRecallTimeoutError
  | SourceRecallProtocolError
  | SourceRecallRepoNotFoundError
  | SourceRecallRepoAmbiguousError
  | SourceRecallRepoNotReadyError
  | SourceRecallRateLimitedError
  | SourceRecallNotInitializedError
  | SourceRecallCapabilityMissingError;

/**
 * Maps a typed provider error to the visible wire diagnostic the tool surfaces. The mapping is the
 * one place a failure class becomes user-facing text, so the transcript never shows a raw daemon
 * internal and the diagnostic `kind` stays a stable, testable enum.
 */
export function diagnosticOf(error: SourceRecallProviderError): SourceRecallDiagnostic {
  switch (error._tag) {
    case "SourceRecallUnreachableError":
      return { kind: "unreachable", detail: error.detail };
    case "SourceRecallTimeoutError":
      return { kind: "timeout", detail: `timed out after ${error.timeoutMs}ms` };
    case "SourceRecallProtocolError":
      return { kind: "malformed_response", detail: error.detail };
    case "SourceRecallRepoNotFoundError":
      return { kind: "repo_not_found", detail: `repo "${error.repo}" is not served` };
    case "SourceRecallRepoAmbiguousError":
      return {
        kind: "repo_not_found",
        detail: `specify a repo: ${error.available.join(", ")}`,
      };
    case "SourceRecallRepoNotReadyError":
      return { kind: "repo_not_ready", detail: error.detail };
    case "SourceRecallRateLimitedError":
      return { kind: "rate_limited", detail: error.detail };
    case "SourceRecallNotInitializedError":
      return { kind: "not_initialized", detail: error.detail };
    case "SourceRecallCapabilityMissingError":
      return { kind: "internal", detail: error.detail };
  }
}

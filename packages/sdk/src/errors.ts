import { errorMessage } from "@belay/session";

/**
 * The structured error every `@belay/sdk` workflow throws when a backend operation fails. It carries
 * enough context for a CLI, eval harness, or automation script to map a failure to a concise message
 * and a nonzero exit without re-deriving what went wrong: which `operation` failed, which `backend`
 * class it was (the session log vs. the blob store), the `sessionId` in play, the redacted backend URL
 * class (scheme + host + port only - never a path, query, or credentials), and a redacted `detail`.
 *
 * It is deliberately a plain thrown error, not an Effect failure: the SDK is the browser-safe ergonomic
 * layer above `@belay/session`, consumed by plain-TypeScript callers (CLI, evals, scripts), so it does
 * not impose Effect on its consumers. The host keeps its Effect-typed errors internally.
 */

/** The distinct backend a workflow talks to: the durable session log, or the content-addressed blobs. */
export type SdkBackend = "session" | "blob";

/** The named workflow operation a failure occurred in - the stable machine-readable failure code. */
export type SdkOperation =
  | "ensureSession"
  | "publishEvent"
  | "readLog"
  | "fetchInventory"
  | "streamTurn"
  | "prompt"
  | "cancel"
  | "switchModel"
  | "runCommand"
  | "exportCapabilities"
  | "doctor"
  | "archive"
  | "unarchive"
  | "permanentlyDeleteSession"
  | "uploadArtifact"
  | "downloadArtifact"
  | "headArtifact";

export interface SdkErrorContext {
  readonly operation: SdkOperation;
  readonly backend: SdkBackend;
  readonly sessionId?: string;
  /** The backend URL class: scheme + host + port only. Never carries a path, query, or credentials. */
  readonly backendUrlClass: string;
  /** A redacted, human-readable detail (already stripped of secrets/paths by the caller). */
  readonly detail?: string;
}

/**
 * Reduces any URL to its origin class - `scheme://host:port` - dropping the path, query, hash, and any
 * embedded credentials, so an SDK error can name WHERE it failed without leaking a session id in a path
 * or a token in a query. A non-URL string is returned as `"<invalid-url>"` rather than echoed verbatim.
 */
export function urlClass(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<invalid-url>";
  }
}

export class SdkError extends Error implements SdkErrorContext {
  readonly operation: SdkOperation;
  readonly backend: SdkBackend;
  readonly sessionId?: string;
  readonly backendUrlClass: string;
  readonly detail?: string;

  constructor(context: SdkErrorContext, options?: { readonly cause?: unknown }) {
    const where = context.sessionId ? ` (session ${context.sessionId})` : "";
    const detail = context.detail ? `: ${context.detail}` : "";
    super(
      `sdk ${context.operation} failed against ${context.backendUrlClass}${where}${detail}`,
      options,
    );
    this.name = "SdkError";
    this.operation = context.operation;
    this.backend = context.backend;
    this.sessionId = context.sessionId;
    this.backendUrlClass = context.backendUrlClass;
    this.detail = context.detail;
  }
}

/** Type guard for a caught {@link SdkError} (a CLI maps it to an exit code; other callers to a message). */
export function isSdkError(value: unknown): value is SdkError {
  return value instanceof SdkError;
}

/**
 * Runs a backend operation, rewrapping any thrown value as a typed {@link SdkError} that names the
 * operation, backend, session, and redacted URL class. An already-typed `SdkError` passes through so a
 * nested workflow's context is not overwritten. The single funnel every workflow routes its failures
 * through, so no callsite hand-rolls the operation/URL-class/redaction triple.
 */
export async function withSdkError<A>(context: SdkErrorContext, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (isSdkError(error)) {
      throw error;
    }
    throw new SdkError(
      { ...context, detail: context.detail ?? errorMessage(error) },
      { cause: error },
    );
  }
}

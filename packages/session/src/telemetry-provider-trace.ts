import { join } from "node:path";
import { storagePathByName } from "./node-paths";
import { redactAttributeValue } from "./telemetry-contract";
import { createCappedJsonlWriter } from "./telemetry-jsonl";

/**
 * Opt-in LOCAL provider-attempt tracing (plan 13 M6). When `TREVOR_PROVIDER_TRACE=1`, each provider
 * attempt (one model step) is appended as a bounded, redacted JSON line to
 * `BELAY_STATE_HOME/otel/provider-attempts.jsonl` - the deep-telemetry evidence for debugging a flaky
 * provider (failure class, attempt/retry state, token counts, timing) WITHOUT the raw prompt, transcript,
 * tool output, or provider body. It is DISABLED by default; a disabled writer is a no-op that touches no
 * disk. Node-only (fs), reached through the `@belay/session/telemetry-provider-trace` subpath so it never
 * bundles into the browser. Best-effort + byte-capped, exactly like the file sink.
 *
 * These records are diagnostic evidence only (D-008): they are never read back as a tool-output cache or
 * to skip/replay a call - this module has no read path at all.
 */

export interface ProviderAttemptRecord {
  readonly provider: string;
  readonly model: string;
  /** An id correlating this attempt to its turn. The trace is LOCAL-ONLY (under BELAY_STATE_HOME), so a
   *  run id is acceptable here - unlike a metric label, this file never leaves the machine. */
  readonly attemptId: string;
  readonly outcome: "ok" | "error";
  /** The failure taxonomy class when `outcome === "error"` (e.g. auth, quota, transport_loss). */
  readonly failureClass?: string;
  /** Whether the failure was retryable (informs the retry state). */
  readonly retryable?: boolean;
  /** 1-based attempt number within the turn's retry budget. */
  readonly attempt: number;
  /** Attempt wall-clock ms; 0 at the terminal-failure boundary until a finer per-attempt hook lands. */
  readonly durationMs: number;
  /** Prompt/completion token counts when the finer per-attempt hook provides them (else omitted). */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** An already-boundary-redacted one-line summary; re-redacted here defensively. */
  readonly detail?: string;
}

export interface ProviderTraceWriter {
  /** Appends one provider-attempt record (a no-op when tracing is disabled). */
  record(attempt: ProviderAttemptRecord): void;
  stats(): { readonly written: number; readonly dropped: number };
}

export interface ProviderTraceOptions {
  /** Whether tracing is enabled (from {@link resolveTelemetryConfig}'s `providerTrace`). */
  readonly enabled: boolean;
  /** Override the otel dir (tests); defaults to the state-home `otel` inventory path. */
  readonly dir?: string;
  /** Byte cap for the trace file; writes past it are dropped + counted. Default 8 MiB. */
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const NOOP_WRITER: ProviderTraceWriter = {
  record: () => {},
  stats: () => ({ written: 0, dropped: 0 }),
};
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function createProviderTraceWriter(opts: ProviderTraceOptions): ProviderTraceWriter {
  if (!opts.enabled) {
    return NOOP_WRITER;
  }
  const dir = opts.dir ?? storagePathByName("otel");
  const writer = createCappedJsonlWriter({
    path: join(dir, "provider-attempts.jsonl"),
    dir,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    now: opts.now ?? Date.now,
  });
  return {
    record: (attempt: ProviderAttemptRecord) =>
      writer.append({
        ...attempt,
        // Re-redact the free-text detail defensively (the caller already redacts at the boundary).
        ...(attempt.detail !== undefined ? { detail: redactAttributeValue(attempt.detail) } : {}),
      }),
    stats: () => writer.stats(),
  };
}

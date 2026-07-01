import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { storagePathByName } from "./node-paths";
import { redactAttributeValue } from "./telemetry-contract";

/**
 * Opt-in LOCAL provider-attempt tracing (plan 13 M6). When `TREVOR_PROVIDER_TRACE=1`, each provider
 * attempt (one model step) is appended as a bounded, redacted JSON line to
 * `TREVOR_STATE_HOME/otel/provider-attempts.jsonl` - the deep-telemetry evidence for debugging a flaky
 * provider (failure class, attempt/retry state, token counts, timing) WITHOUT the raw prompt, transcript,
 * tool output, or provider body. It is DISABLED by default; a disabled writer is a no-op that touches no
 * disk. Node-only (fs), reached through the `@trevor/session/telemetry-provider-trace` subpath so it never
 * bundles into the browser. Best-effort + byte-capped, exactly like the file sink.
 *
 * These records are diagnostic evidence only (D-008): they are never read back as a tool-output cache or
 * to skip/replay a call - this module has no read path at all.
 */

export interface ProviderAttemptRecord {
  readonly provider: string;
  readonly model: string;
  /** A short id correlating this attempt (never a run/session id). */
  readonly attemptId: string;
  readonly outcome: "ok" | "error";
  /** The failure taxonomy class when `outcome === "error"` (e.g. auth, quota, transport_loss). */
  readonly failureClass?: string;
  /** Whether the failure was retryable (informs the retry state). */
  readonly retryable?: boolean;
  /** 1-based attempt number within the turn's retry budget. */
  readonly attempt: number;
  readonly durationMs: number;
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
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? Date.now;
  const path = join(dir, "provider-attempts.jsonl");
  let written = 0;
  let dropped = 0;
  let dirReady = false;
  let bytes = currentSize(path);

  return {
    record(attempt: ProviderAttemptRecord): void {
      let line = "";
      try {
        line = `${JSON.stringify({
          ...attempt,
          ...(attempt.detail !== undefined ? { detail: redactAttributeValue(attempt.detail) } : {}),
          at: new Date(now()).toISOString(),
        })}\n`;
      } catch {
        dropped += 1;
        return;
      }
      if (bytes + line.length > maxBytes) {
        dropped += 1;
        return;
      }
      try {
        if (!dirReady) {
          mkdirSync(dir, { recursive: true });
          dirReady = true;
        }
        appendFileSync(path, line);
        bytes += line.length;
        written += 1;
      } catch {
        dropped += 1;
      }
    },
    stats: () => ({ written, dropped }),
  };
}

/** The current size of `path` in bytes, or 0 when it does not exist yet. */
function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

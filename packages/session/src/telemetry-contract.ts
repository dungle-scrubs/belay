/**
 * The shared observability CONTRACT (plan 13, M2): redaction + safe-envelope helpers, the span/metric
 * name vocabulary, resource attributes, and the cardinality/sensitivity guards for attribute keys. This
 * is a pure, side-effect-free library (D-003): it defines what telemetry may carry and how values are
 * sanitized, but initializes no SDK and emits nothing. Runtime apps build spans/metrics from these names
 * and pass attributes through {@link safeAttributes} before anything is exported.
 *
 * Privacy posture (D-002): prompt text, transcript bodies, tool/command output, env values, auth headers,
 * API keys, raw provider request/response bodies, and raw filesystem paths NEVER become telemetry. They
 * are blocked by KEY (an attribute named `prompt`/`path`/… is dropped wholesale) and any surviving value
 * is still secret-stripped + length-capped, so a stray token in an allowed field can't leak either.
 */

/** The placeholder a redacted span/metric value collapses to. */
export const REDACTED = "«redacted»";

/** Max characters any single telemetry attribute value may carry (longer is truncated). */
export const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * Strips secrets from a free-text string: bearer tokens, `sk-`/`pi-`/`ghp-`… API keys,
 * `Authorization`/`x-api-key`/`token`/`secret` header+field values, and `?key=`/`?token=` query params.
 * Deterministic and idempotent. (Mirrors the host's provider `redactSecrets`; kept here as the shared
 * telemetry-layer redactor so package code has no app dependency.)
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk|pi|rk|key|tok|ghp|gho)-[A-Za-z0-9._-]{8,}/gi, REDACTED)
    .replace(
      /("?(?:authorization|x-api-key|api[_-]?key|token|secret|password|dsn)"?\s*[:=]\s*"?)[^\s",}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/([?&](?:key|token|access_token|api_key)=)[^&\s]+/gi, `$1${REDACTED}`);
}

/** Collapses absolute filesystem paths to a bounded `<path>` placeholder so raw paths never leak, while
 *  keeping the tail segment for a hint. Matches 2+ segments, so even a short path like `/etc/passwd` or
 *  `/tmp/secret` collapses (e.g. `/Users/x/dev/repo/file.ts` -> `<path>/file.ts`). */
function collapsePaths(text: string): string {
  return text.replace(/(?:\/[^\s/:"]+)+(\/[^\s/:"]+)/g, `<path>$1`);
}

/**
 * Sanitizes a single telemetry attribute VALUE: secret-stripped, path-collapsed, and length-capped.
 * Non-string values are coerced first. Use for any value that survives the key allowlist.
 */
export function redactAttributeValue(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  const cleaned = collapsePaths(redactSecrets(text));
  return cleaned.length > MAX_ATTRIBUTE_LENGTH
    ? `${cleaned.slice(0, MAX_ATTRIBUTE_LENGTH)}…`
    : cleaned;
}

/**
 * Attribute/label keys that must NEVER appear in telemetry - either high-cardinality (run/session id,
 * raw url/path) or sensitive (prompt, tool/command output, auth, env, raw provider bodies). Compared
 * after normalizing away case and `_`/`-`/`.` separators, so `run_id`, `runId`, and `run.id` all match.
 */
const DISALLOWED_KEYS: ReadonlySet<string> = new Set(
  [
    "prompt",
    "prompttext",
    "messages",
    "transcript",
    "tooloutput",
    "toolresult",
    "command",
    "commandoutput",
    "output",
    "content",
    "authorization",
    "apikey",
    "xapikey",
    "token",
    "secret",
    "password",
    "dsn",
    "env",
    "envvalue",
    "providerbody",
    "requestbody",
    "responsebody",
    "rawbody",
    "runid",
    "sessionid",
    "agentid",
    "url",
    "path",
    "filepath",
    "cwd",
    "projectroot",
    // Host / network / user identity - deanonymizing, so dropped wholesale (defense in depth).
    "hostname",
    "host",
    "ip",
    "email",
    "user",
    "username",
  ].map(normalizeKey),
);

/** Normalizes an attribute key to a comparison form: lowercased, separators removed. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[._-]/g, "");
}

/** Whether an attribute/metric-label key is disallowed (high-cardinality or sensitive) and must be dropped. */
export function isDisallowedTelemetryKey(key: string): boolean {
  return DISALLOWED_KEYS.has(normalizeKey(key));
}

/** A telemetry attribute set: bounded, low-cardinality string/number/boolean values keyed by name. */
export type TelemetryAttributes = Record<string, string | number | boolean>;

/**
 * Filters + sanitizes an attribute record into a safe telemetry envelope: drops every disallowed key
 * (prompt/path/auth/run-id/…), leaves numbers + booleans as-is (low cardinality, no secrets), and
 * secret-strips + caps every string value. The single choke point every span/metric attribute set passes
 * through before export.
 */
export function safeAttributes(attributes: Readonly<Record<string, unknown>>): TelemetryAttributes {
  const safe: TelemetryAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isDisallowedTelemetryKey(key) || value === undefined || value === null) {
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    } else {
      safe[key] = redactAttributeValue(value);
    }
  }
  return safe;
}

/** The span names Trevor emits at public module boundaries (contract-owned, not ad-hoc per module). Kept
 *  to the set instrumentation actually produces; a new boundary adds its name here when it is wired. */
export const SPAN_NAMES = {
  turn: "trevor.turn",
  providerAttempt: "trevor.provider.attempt",
  tool: "trevor.tool",
  storeAppend: "trevor.store.append",
  blobIo: "trevor.blob.io",
  cliLaunch: "trevor.cli.launch",
  webRender: "trevor.web.render",
} as const;

/** The low-cardinality metric names Trevor records (contract-owned; only the emitted set). */
export const METRIC_NAMES = {
  turnDuration: "trevor.turn.duration",
  turnStop: "trevor.turn.stop",
  modelSwitch: "trevor.turn.model_switch",
  retryCount: "trevor.provider.retries",
  blobOutcome: "trevor.blob.outcome",
} as const;

/** A telemetry span name (one of the contract's {@link SPAN_NAMES}). */
export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES];
/** A telemetry metric name (one of the contract's {@link METRIC_NAMES}). */
export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

/** A completed span's terminal status. */
export type SpanStatus = "ok" | "error";

/** One finished span, ready for export: a contract name, sanitized attributes, timing, and status. */
export interface SpanRecord {
  readonly name: SpanName;
  readonly attributes: TelemetryAttributes;
  readonly status: SpanStatus;
  readonly durationMs: number;
  /** A redacted one-line failure summary when `status === "error"`. */
  readonly error?: string;
}

/** A metric's shape: a monotonic `counter` (events) or a `histogram` (a duration/size distribution). */
export type MetricKind = "counter" | "histogram";

/** One recorded metric point: a contract name, a numeric value, and bounded low-cardinality labels. */
export interface MetricRecord {
  readonly name: MetricName;
  readonly value: number;
  readonly kind: MetricKind;
  readonly labels: TelemetryAttributes;
}

/**
 * The sink runtime apps push finished spans + metric points into. This is the seam the OTel SDK, the
 * local file exporter, or a test's in-memory recorder plug into (escape hatch: local JSONL first, SDK
 * later) - the instrumentation only ever sees this interface, never an exporter. Both methods must be
 * best-effort and never throw (a telemetry failure must not fail user work).
 */
export interface TelemetrySink {
  span(record: SpanRecord): void;
  metric(record: MetricRecord): void;
}

/** The no-op sink: telemetry is disabled by default, so instrumentation runs against this and emits nothing. */
export const NOOP_SINK: TelemetrySink = { span: () => {}, metric: () => {} };

/**
 * Records one metric point through `sink`, best-effort: the labels are run through {@link safeAttributes}
 * so a high-cardinality or sensitive label (run id, session id, prompt, path, command) can never become a
 * metric dimension, and a sink failure is swallowed. `kind` defaults to a counter.
 */
export function recordMetric(
  sink: TelemetrySink,
  name: MetricName,
  value: number,
  labels: Readonly<Record<string, unknown>> = {},
  kind: MetricKind = "counter",
): void {
  try {
    sink.metric({ name, value, kind, labels: safeAttributes(labels) });
  } catch {
    // A telemetry sink failure must never propagate into user work.
  }
}

/**
 * Times `fn`, then pushes a finished span for it into `sink` with the sanitized attributes and an
 * ok/error status. A throw is recorded as an `error` span (with a redacted message) and RE-THROWN - the
 * span is observability, never flow control. The sink call is guarded so a telemetry failure can't fail
 * the wrapped work. `now` is injectable for deterministic tests.
 */
export async function withSpan<T>(
  sink: TelemetrySink,
  name: SpanName,
  attributes: Readonly<Record<string, unknown>>,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const startedAt = now();
  try {
    const result = await fn();
    emitSpan(sink, name, safeAttributes(attributes), "ok", now() - startedAt);
    return result;
  } catch (error) {
    emitSpan(
      sink,
      name,
      safeAttributes(attributes),
      "error",
      now() - startedAt,
      redactAttributeValue(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

/**
 * The synchronous sibling of {@link withSpan} for sync boundaries (e.g. a SQLite write): times `fn`,
 * records an ok/error span, and re-throws on failure. Same best-effort sink guarantee.
 */
export function withSpanSync<T>(
  sink: TelemetrySink,
  name: SpanName,
  attributes: Readonly<Record<string, unknown>>,
  fn: () => T,
  now: () => number = Date.now,
): T {
  const startedAt = now();
  try {
    const result = fn();
    emitSpan(sink, name, safeAttributes(attributes), "ok", now() - startedAt);
    return result;
  } catch (error) {
    emitSpan(
      sink,
      name,
      safeAttributes(attributes),
      "error",
      now() - startedAt,
      redactAttributeValue(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

/**
 * Pushes one finished span into the sink, clamping the duration and swallowing any sink error so
 * telemetry never fails the caller. The one guarded emit both this module's timing helpers and the app
 * boundaries (the host Effect combinator, the CLI launch span, the web error boundary) push through.
 */
export function safeEmitSpan(sink: TelemetrySink, record: SpanRecord): void {
  try {
    sink.span({ ...record, durationMs: Math.max(0, record.durationMs) });
  } catch {
    // A telemetry sink failure must never propagate into user work.
  }
}

/** Builds a {@link SpanRecord} from timing parts and pushes it via {@link safeEmitSpan}. */
function emitSpan(
  sink: TelemetrySink,
  name: SpanName,
  attributes: TelemetryAttributes,
  status: SpanStatus,
  durationMs: number,
  error?: string,
): void {
  safeEmitSpan(sink, { name, attributes, status, durationMs, ...(error ? { error } : {}) });
}

/** One of Trevor's telemetry-emitting services (the OTel `service.name` + Sentry project scope). */
export type TelemetryService = "agent-host" | "session-store" | "blob-store" | "trevor-cli" | "web";

/**
 * The OTel resource attributes for a service: bounded, low-cardinality identity only (service name +
 * version + runtime). No host name, path, or user identity - identity that could deanonymize or explode
 * cardinality is excluded by construction.
 */
export function resourceAttributes(
  service: TelemetryService,
  version: string | null,
): TelemetryAttributes {
  return {
    "service.name": `trevor-${service}`,
    "service.version": version ?? "dev",
    "telemetry.sdk.name": "trevor",
  };
}

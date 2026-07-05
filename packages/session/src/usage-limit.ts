/**
 * The usage-limit signal (plan 44.4): a provider's "how close is this session to a rate/usage window
 * limit" reading, normalized across providers into ONE Trevor-native vocabulary. Owned here so the
 * pi-ai boundary (Claude's `anthropic-ratelimit-unified-*` success headers, a Codex 429), the
 * `assistant.limit` protocol event, and both consumers (sdk projection, web transcript marker) all read
 * the SAME status/scope set instead of re-deriving it. Mirrors `connectivity.ts` - a pure, isomorphic
 * wire-contract leaf with a tolerant parser and no I/O.
 *
 * Responsible for: the LimitStatus/LimitScope vocabulary, the `UsageLimit` shape, and the pure Anthropic
 * unified-header parser + reset parser.
 * Not for: emitting the event (protocol.ts), the Codex error-path classification (agent-host
 * failure-taxonomy/usage-limit-capture), or rendering (web transcript).
 */

/** The Trevor-native, provider-agnostic limit status, ordered least -> most constrained. Normalized
 *  from Claude's `allowed|allowed_warning|rejected` and Codex's 429 (`reached`). */
export const LIMIT_STATUSES = ["ok", "approaching", "reached"] as const;
export type LimitStatus = (typeof LIMIT_STATUSES)[number];

/** The window a limit applies to: a provider window id. Free-form (providers name their own windows);
 *  the known Anthropic windows normalize to `five_hour` / `seven_day` / `seven_day_opus`, and a signal
 *  with no window resolves to `unified`. */
export type LimitScope = string;

/** One normalized usage-limit reading. `resetsAt` (unix epoch SECONDS) and `utilization` (0..1 fraction
 *  used) ride only when the provider exposed them. */
export interface UsageLimit {
  readonly status: LimitStatus;
  readonly scope: LimitScope;
  readonly resetsAt?: number;
  readonly utilization?: number;
}

const UNIFIED_PREFIX = "anthropic-ratelimit-unified";

/** The Anthropic unified windows, in scope-priority order (tie-break), mapped to Trevor scope ids. */
const WINDOWS: readonly { readonly key: string; readonly scope: LimitScope }[] = [
  { key: "5h", scope: "five_hour" },
  { key: "7d-opus", scope: "seven_day_opus" },
  { key: "7d", scope: "seven_day" },
];

/** Claude's `anthropic-ratelimit-unified-status` tokens -> the Trevor-native status. */
const STATUS_MAP: Record<string, LimitStatus> = {
  allowed: "ok",
  allowed_warning: "approaching",
  rejected: "reached",
};

const SEVERITY: Record<LimitStatus, number> = { ok: 0, approaching: 1, reached: 2 };

function unifiedStatus(raw: string): LimitStatus {
  return STATUS_MAP[raw.trim().toLowerCase()] ?? "ok";
}

/** Lowercases every header key so the parse is case-insensitive (HTTP header names are). */
function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function numHeader(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Reads a reset value into a unix epoch in SECONDS, accepting all three forms a provider might send:
 * an integer-seconds string, an RFC3339 timestamp, or an HTTP-date. (The HTTP-date form is the
 * deliberate gap in `failure-evidence`'s retry-after read; it is parseable here.) Undefined for an
 * absent or unparseable value.
 */
export function parseResetToEpochSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** The window whose per-window status is the most constrained (tie-break by WINDOWS order), or null
 *  when no per-window status header is present (only the top-level unified status). */
function pickWindow(h: Record<string, string>): { key: string; scope: LimitScope } | null {
  let best: { key: string; scope: LimitScope; severity: number } | null = null;
  for (const window of WINDOWS) {
    const raw = h[`${UNIFIED_PREFIX}-${window.key}-status`];
    if (raw === undefined) {
      continue;
    }
    const severity = SEVERITY[unifiedStatus(raw)];
    if (!best || severity > best.severity) {
      best = { key: window.key, scope: window.scope, severity };
    }
  }
  return best ? { key: best.key, scope: best.scope } : null;
}

/** 0..1 fraction of a window used, from its `remaining`/`limit` pair; undefined when either is absent
 *  or the limit is non-positive. */
function windowUtilization(h: Record<string, string>, key: string): number | undefined {
  const remaining = numHeader(h[`${UNIFIED_PREFIX}-${key}-remaining`]);
  const limit = numHeader(h[`${UNIFIED_PREFIX}-${key}-limit`]);
  if (remaining === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  const used = 1 - remaining / limit;
  return Math.min(1, Math.max(0, used));
}

/**
 * Parses Anthropic's unified rate-limit response headers into a normalized {@link UsageLimit}, or null
 * when the top-level `anthropic-ratelimit-unified-status` is absent (i.e. not the Claude path / no
 * unified headers). The constraining window owns `scope` + `utilization` + the preferred reset; a
 * signal with only the top-level status normalizes to the `unified` scope. Pure - no clock, no network.
 */
export function parseAnthropicUnifiedHeaders(headers: Record<string, string>): UsageLimit | null {
  const h = lowerKeys(headers);
  const topStatus = h[`${UNIFIED_PREFIX}-status`];
  if (topStatus === undefined) {
    return null;
  }
  const status = unifiedStatus(topStatus);
  const window = pickWindow(h);
  const scope: LimitScope = window?.scope ?? "unified";
  const resetsAt = parseResetToEpochSeconds(
    (window ? h[`${UNIFIED_PREFIX}-${window.key}-reset`] : undefined) ??
      h[`${UNIFIED_PREFIX}-reset`],
  );
  const utilization = window ? windowUtilization(h, window.key) : undefined;
  return {
    status,
    scope,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
  };
}

/** The unified rate-limit header keys actually present (lowercased, sorted), for the detect-only gap
 *  log when the parser returns null or a header is missing - so the gap is explained, not silent. */
export function unifiedHeaderKeys(headers: Record<string, string>): string[] {
  return Object.keys(headers)
    .map((key) => key.toLowerCase())
    .filter((key) => key.startsWith(UNIFIED_PREFIX))
    .sort();
}

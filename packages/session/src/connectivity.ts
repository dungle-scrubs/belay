/**
 * The internet-connectivity snapshot (D-060): the host's advisory view of whether IT can reach the
 * public internet. This is the wire contract shared by the host (which owns the probe) and the web
 * (which renders the advisory near model/source selection and in /doctor). It is NOT provider
 * health, NOT browser `navigator.onLine`, NOT session-store/WebSocket presence, and drives NO
 * routing - purely advisory.
 *
 * `status` is the last settled probe result; `checking` is a transient flag while a probe is in
 * flight (the status holds its prior value meanwhile). `unknown` means no probe yet, a
 * disabled/misconfigured probe, or an inconclusive result - never "offline by assumption".
 */

export type InternetStatus = "online" | "offline" | "unknown";

export interface InternetSnapshot {
  readonly status: InternetStatus;
  /** A probe is running right now (the status still holds its last settled value). */
  readonly checking: boolean;
  /** ISO time the last probe completed, or null if none has. */
  readonly checkedAt: string | null;
  /** Sanitized last-probe error (no endpoints, no secrets), or null. */
  readonly error: string | null;
  /** The probe target class actually exercised, for /doctor (never a concrete endpoint). */
  readonly targetClass: "dns+https" | "none";
}

/** The initial snapshot before any probe has run. */
export const UNKNOWN_INTERNET: InternetSnapshot = {
  status: "unknown",
  checking: false,
  checkedAt: null,
  error: null,
  targetClass: "none",
};

/** Whether a snapshot is older than `maxAgeMs` (so the UI can mark it stale / trigger a refresh). */
export function isSnapshotStale(
  snapshot: InternetSnapshot,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (snapshot.checkedAt === null) {
    return true;
  }
  const checked = Date.parse(snapshot.checkedAt);
  return Number.isNaN(checked) || nowMs - checked > maxAgeMs;
}

/** Coerces an unknown payload (e.g. off `host.online`) into a valid snapshot, defaulting to unknown. */
export function coerceInternetSnapshot(value: unknown): InternetSnapshot {
  if (typeof value !== "object" || value === null) {
    return UNKNOWN_INTERNET;
  }
  const v = value as Record<string, unknown>;
  const status: InternetStatus =
    v.status === "online" || v.status === "offline" || v.status === "unknown"
      ? v.status
      : "unknown";
  return {
    status,
    checking: v.checking === true,
    checkedAt: typeof v.checkedAt === "string" ? v.checkedAt : null,
    error: typeof v.error === "string" ? v.error : null,
    targetClass: v.targetClass === "dns+https" ? "dns+https" : "none",
  };
}

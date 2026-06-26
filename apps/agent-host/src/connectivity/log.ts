import type { InternetSnapshot } from "@trevor/session";
import type { Fields } from "../log";

/**
 * Structured, redacted host logging for internet-probe transitions (D-060 M4).
 *
 * The host logs a probe transition on a status CHANGE (e.g. online→offline, unknown→online) or a
 * settled probe FAILURE, and stays quiet for an unchanged-reachable settle and for the intermediate
 * `checking` start (nothing notable yet). Pure over the previous + next snapshot so the decision is
 * unit-tested; `main.ts` feeds the result to the shared {@link log}/{@link warn} sink.
 *
 * Redaction is structural: the fields are the probe's OWN already-sanitized values - the target CLASS
 * (`"dns+https"` / `"none"`), never the configured DNS host or HTTPS endpoint, plus the snapshot's
 * sanitized `error` (which `probeInternet` builds from fixed phrases, never the endpoint). There is no
 * field on this line through which an endpoint, credential, or raw payload could reach the log.
 */

/** A structured probe log line: a level + message + flat redacted fields for the host log sink. */
export interface ProbeLogLine {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly fields: Fields;
}

/**
 * The log line for a probe transition, or null when there is nothing notable to log. Emits on a
 * status change or a settled offline failure; suppresses the `checking` start and an unchanged
 * still-reachable settle so steady-state probing is silent.
 */
export function probeLogLine(prev: InternetSnapshot, next: InternetSnapshot): ProbeLogLine | null {
  if (next.checking) {
    return null; // a probe START is neither a status change nor a failure - nothing to log yet
  }
  const changed = prev.status !== next.status;
  const failed = next.status === "offline" && next.error != null;
  if (!changed && !failed) {
    return null; // a settled probe that confirmed the same reachable status: not notable
  }

  const fields: Fields = {
    status: next.status,
    targetClass: next.targetClass,
    checkedAt: next.checkedAt,
  };
  if (changed) {
    fields.previous = prev.status;
  }
  if (next.error != null) {
    fields.error = next.error;
  }
  return {
    level: next.status === "offline" ? "warn" : "info",
    message: changed ? "internet status changed" : "internet probe failed",
    fields,
  };
}

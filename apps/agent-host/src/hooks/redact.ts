import { REDACTED, redactSecrets } from "@belay/session/telemetry";

/**
 * Hook output redaction (plan 25 M3, D-009). Hook stdout/stderr is arbitrary command output
 * headed for stored log fields, events, and Doctor details, so anything secret-shaped is
 * scrubbed before storage: the shared telemetry redactor covers bearer/authorization headers,
 * token-like strings, and known secret-named fields, and two hook-local passes cover what it
 * deliberately leaves alone - env-style `KEY=value` assignments (a hook that dumps its
 * environment must not persist the values) and home-directory paths (they carry usernames).
 * Deterministic and idempotent, so layered passes are safe: ./decision redacts reason/context
 * AT PARSE (every downstream surface is covered by construction) and the event fold re-redacts
 * as belt and braces. The runner still hands decision parsing the raw capped stdout.
 *
 * Responsible for: scrubbing secret-shaped values from hook output bound for logs/events/Doctor.
 * Not for: output capping (./runner) or decision parsing (./decision).
 */

/** An env-style assignment: an UPPER_SNAKE key with any non-space value. Conservative on
 *  purpose - a false positive hides a harmless value, a false negative stores a secret. */
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]+)=[^\s"']+/g;

/** A macOS/linux home directory prefix; the username segment is what must not persist. */
const HOME_PATH = /\/(?:Users|home)\/[^/\s"']+/g;

/** Scrubs hook output text for storage: shared secret patterns, env assignments, home paths. */
export function redactHookText(text: string): string {
  return redactSecrets(text).replace(ENV_ASSIGNMENT, `$1=${REDACTED}`).replace(HOME_PATH, "~");
}

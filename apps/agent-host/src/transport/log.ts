/**
 * Structured logging for the host's module boundaries. One format - `scope: message
 * key=value ...` - so every module's logs read the same and stay greppable: the scope
 * tag stands in for a correlation prefix, and flat fields carry ids, durations, and
 * outcomes. Boundary logs only: log where an abstraction's promise is made (an
 * exported method's entry/exit), not inside every helper - that's what `debug` is for.
 *
 * `debug` is the verbose toggle, off by default and switched on per scope via
 * TREVOR_DEBUG (`1`/`true`/`all`/`*` for everything, or a comma list like
 * `lmstudio,lease`). Use it for internal tracing - pi-ai stream events, lease tick
 * decisions - that would be noise in normal operation but is what you want when a
 * specific module is misbehaving.
 *
 * Responsible for: the structured boundary logger (log/warn/debug) and InvariantError/invariant.
 * Not for: error->message normalization (messages.ts) or event publishing (services.ts).
 */

import { Data } from "effect";

export type Fields = Record<string, unknown>;

/** Renders one field value: bare for simple tokens, quoted/JSON when it has spaces. */
function render(value: unknown): string {
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Renders a flat record as `key=value key=value`, dropping undefined fields. */
export function fmtFields(fields: Fields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${render(value)}`)
    .join(" ");
}

function format(scope: string, message: string, fields?: Fields): string {
  const tail = fields ? fmtFields(fields) : "";
  return tail ? `${scope}: ${message} ${tail}` : `${scope}: ${message}`;
}

/** A normal boundary log line (stdout). */
export function log(scope: string, message: string, fields?: Fields): void {
  console.log(format(scope, message, fields));
}

/** A problem worth surfacing even when verbose tracing is off (stderr). */
export function warn(scope: string, message: string, fields?: Fields): void {
  console.error(format(scope, message, fields));
}

const DEBUG_SCOPES = (process.env.TREVOR_DEBUG ?? "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const DEBUG_ALL = DEBUG_SCOPES.some((scope) => ["1", "true", "all", "*"].includes(scope));

/** Whether verbose tracing is on for this scope (set via TREVOR_DEBUG). */
export function isDebug(scope: string): boolean {
  return DEBUG_ALL || DEBUG_SCOPES.includes(scope);
}

/** Internal tracing, emitted only when this scope's verbose toggle is on. */
export function debug(scope: string, message: string, fields?: Fields): void {
  if (isDebug(scope)) {
    console.log(format(`${scope}*`, message, fields));
  }
}

/** A broken self-imposed rule (distinct from input validation, which checks the caller). */
export class InvariantError extends Data.TaggedError("InvariantError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** Throws InvariantError when a self-imposed rule breaks, at the point it breaks. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InvariantError({ detail: message });
  }
}

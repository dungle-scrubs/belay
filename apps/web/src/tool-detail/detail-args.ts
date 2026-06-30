import { parseToolArgs } from "@/derive";

/**
 * Pure per-tool argument extractors for the filesystem + shell detail adapters (plan 08 M3). Each reads
 * the raw `args` JSON a tool row carries and returns the normalized fields its detail body renders -
 * defensively (a missing / malformed / still-streaming arg yields empty strings, never a throw), so the
 * detail surface degrades to "(none)" instead of breaking on a partial tool call.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export interface BashDetailArgs {
  readonly command: string;
  readonly cwd?: string;
}

export function bashDetailArgs(args: string): BashDetailArgs {
  const a = parseToolArgs(args);
  const cwd = str(a.cwd);
  return { command: str(a.command), ...(cwd ? { cwd } : {}) };
}

export interface ReadDetailArgs {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export function readDetailArgs(args: string): ReadDetailArgs {
  const a = parseToolArgs(args);
  return { path: str(a.path), offset: num(a.offset), limit: num(a.limit) };
}

export interface WriteDetailArgs {
  readonly path: string;
  readonly content: string;
}

export function writeDetailArgs(args: string): WriteDetailArgs {
  const a = parseToolArgs(args);
  return { path: str(a.path), content: str(a.content) };
}

export interface EditDetailArgs {
  readonly path: string;
  readonly old: string;
  readonly new: string;
}

export function editDetailArgs(args: string): EditDetailArgs {
  const a = parseToolArgs(args);
  return { path: str(a.path), old: str(a.old), new: str(a.new) };
}

export interface MultiEditDetailArgs {
  readonly path: string;
  readonly edits: readonly { readonly old: string; readonly new: string }[];
}

export function multiEditDetailArgs(args: string): MultiEditDetailArgs {
  const a = parseToolArgs(args);
  const raw = Array.isArray(a.edits) ? a.edits : [];
  const edits = raw.map((item) => {
    const e = (item ?? {}) as Record<string, unknown>;
    return { old: str(e.old), new: str(e.new) };
  });
  return { path: str(a.path), edits };
}

export interface SearchDetailArgs {
  /** The grep regex / glob pattern. */
  readonly pattern: string;
  /** The search scope (a path), when given. */
  readonly path?: string;
}

export function searchDetailArgs(args: string): SearchDetailArgs {
  const a = parseToolArgs(args);
  const path = str(a.path);
  // grep uses `pattern`; glob uses `pattern` too (its glob expression).
  return { pattern: str(a.pattern), ...(path ? { path } : {}) };
}

export interface RequestDetailArgs {
  /** A human label for the request: the search query, fetched URL, or docs subject/corpus. */
  readonly request: string;
  /** The request kind, when the tool carries an explicit action (docs). */
  readonly action?: string;
}

export function requestDetailArgs(args: string): RequestDetailArgs {
  const a = parseToolArgs(args);
  const request = [a.query, a.url, a.subject, a.corpusId].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const action = str(a.action);
  return { request: str(request), ...(action ? { action } : {}) };
}

/** The match count for a line-oriented search result (grep/glob): non-blank output lines. Undefined
 *  while still running or on an error result. */
export function matchCount(
  output: string | undefined,
  status: "running" | "done" | "error",
): number | undefined {
  if (!output || status !== "done") {
    return undefined;
  }
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

/** A human range label for a read offset/limit (`L20-39`), or empty when the whole file was read. */
export function readRangeLabel(offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) {
    return "";
  }
  const start = offset ?? 0;
  if (limit === undefined) {
    return `from L${start}`;
  }
  return `L${start}-${start + limit - 1}`;
}

/** A short human label for a render-time output cap: when the output exceeds `cap` lines, how many were
 *  hidden. Empty when nothing is truncated. The detail view shows the full output, so this is advisory. */
export function truncationLabel(output: string | undefined, cap: number): string {
  if (!output) {
    return "";
  }
  const lines = output.split("\n").length;
  return lines > cap ? `${lines - cap} more lines below the fold` : "";
}

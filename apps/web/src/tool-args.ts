/**
 * Single owner for tool-call argument parsing and salient-field extraction. Transcript rows, compact
 * rows, and detail takeovers all read this module so a tool's argument shape is declared once.
 */

/** Tool-call arguments arrive as a JSON string; parse defensively (streaming/malformed yields `{}`). */
export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The distinct file paths a `multi_edit` touches, in first-seen order. Unlike `edit`/`write`,
 * `multi_edit` has no top-level `path`; each edit carries its own `edits[].path`. This is the ONE
 * place that derivation lives (deepen C-18): the salient label, the compact summary, and the detail
 * FILE chip all read it, so a multi_edit's file(s) can't read one way in one surface and another in
 * the next. Tolerates a partial / still-streaming `edits` value (a non-array, a null item, an edit
 * whose `path` hasn't arrived) by skipping it - it never throws and never yields a non-path.
 */
export function multiEditPaths(edits: unknown): string[] {
  if (!Array.isArray(edits)) {
    return [];
  }
  const seen: string[] = [];
  for (const item of edits) {
    const path = str((item as Record<string, unknown> | null)?.path);
    if (path && !seen.includes(path)) {
      seen.push(path);
    }
  }
  return seen;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** The TOTAL-width "cap + ellipsis": the result is at most `max` glyphs (the ellipsis counts toward the
 *  cap), so a label capped with it is guaranteed to FIT in `max`. Shared with `action-label.ts`'s label
 *  redaction. Distinct from `derive`'s `truncate`, which caps content only (up to `max+1` glyphs); use
 *  this when the width is a hard bound, that one when the cap is on the content. */
export function truncateText(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function salientToolArg(name: string, args: Record<string, unknown>): unknown {
  if (name === "bash") {
    return args.command;
  }
  if (name === "grep" || name === "glob") {
    return args.pattern;
  }
  if (name === "web_search" || name === "session_recall" || name === "source_recall") {
    return args.query;
  }
  if (name === "source_index_status" || name === "source_index_refresh") {
    return args.repo;
  }
  if (name === "web_fetch") {
    return args.url;
  }
  if (name === "docs") {
    return [args.subject, args.query, args.url, args.corpusId].find(
      (value) => typeof value === "string" && value.length > 0,
    );
  }
  if (name === "ast_grep") {
    return args.pattern;
  }
  if (name === "archive_read") {
    return args.path ?? args.url;
  }
  if (name === "multi_edit") {
    // multi_edit has no top-level `path`; the single-string surfaces (action label, compact row)
    // lead with the first file it touches plus a bounded "(N files)" indicator when it spans more
    // than one (D-005). action-label.ts stays generic - it composes from this via toolSummary - so
    // the multi-file indicator has to ride along in the salient value itself, never a raw-args leak.
    const paths = multiEditPaths(args.edits);
    if (paths.length === 0) {
      return undefined;
    }
    return paths.length === 1 ? paths[0] : `${paths[0]} (${paths.length} files)`;
  }
  return args.path;
}

export function toolSummary(name: string, argsJson: string): string {
  const args = parseToolArgs(argsJson || "{}");
  const primary = salientToolArg(name, args);
  // A non-string (missing/malformed) salient field collapses to "" - NEVER the raw argsJson. A
  // write/edit/multi_edit call missing `path` mid-stream still carries `old`/`new`/`content`; falling
  // back to the whole args blob would leak up to a truncation-width fragment of that raw content into
  // whatever renders this summary (a tool row header, a compact-row line, an action-shimmer label).
  return truncateText(typeof primary === "string" ? primary : "", 60);
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
  /** The distinct files this multi_edit touches, first-seen order - one FILE chip each (D-002). */
  readonly paths: readonly string[];
  /** Every edit carrying its own file path, so the detail can feed MultiEditDiff edits that group
   *  by their real `path` (D-004) instead of collapsing onto one. Empty `path` while streaming. */
  readonly edits: readonly { readonly path: string; readonly old: string; readonly new: string }[];
}

export function multiEditDetailArgs(args: string): MultiEditDetailArgs {
  const a = parseToolArgs(args);
  const raw = Array.isArray(a.edits) ? a.edits : [];
  const edits = raw.map((item) => {
    const e = (item ?? {}) as Record<string, unknown>;
    return { path: str(e.path), old: str(e.old), new: str(e.new) };
  });
  return { paths: multiEditPaths(a.edits), edits };
}

export interface SearchDetailArgs {
  readonly pattern: string;
  readonly path?: string;
}

export function searchDetailArgs(args: string): SearchDetailArgs {
  const a = parseToolArgs(args);
  const path = str(a.path);
  return { pattern: str(a.pattern), ...(path ? { path } : {}) };
}

export interface RequestDetailArgs {
  readonly request: string;
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

export interface ToolScriptDetailArgs {
  readonly script: string;
  readonly toolsets: readonly string[];
}

export function toolScriptDetailArgs(args: string): ToolScriptDetailArgs {
  const a = parseToolArgs(args);
  const toolsets = Array.isArray(a.toolsets)
    ? a.toolsets.filter((t): t is string => typeof t === "string")
    : [];
  return { script: str(a.script), toolsets };
}

export function matchCount(
  output: string | undefined,
  status: "running" | "done" | "error",
): number | undefined {
  if (!output || status !== "done") {
    return undefined;
  }
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

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

export function truncationLabel(output: string | undefined, cap: number): string {
  if (!output) {
    return "";
  }
  const lines = output.split("\n").length;
  return lines > cap ? `${lines - cap} more lines below the fold` : "";
}

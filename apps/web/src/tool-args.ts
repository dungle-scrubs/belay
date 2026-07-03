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

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function truncateText(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function salientToolArg(name: string, args: Record<string, unknown>): unknown {
  if (name === "bash") {
    return args.command;
  }
  if (name === "grep" || name === "glob") {
    return args.pattern;
  }
  if (name === "web_search" || name === "session_recall") {
    return args.query;
  }
  if (name === "web_fetch") {
    return args.url;
  }
  if (name === "docs") {
    return [args.subject, args.query, args.url, args.corpusId].find(
      (value) => typeof value === "string" && value.length > 0,
    );
  }
  return args.path;
}

export function toolSummary(name: string, argsJson: string): string {
  const args = parseToolArgs(argsJson || "{}");
  const primary = salientToolArg(name, args);
  const text =
    typeof primary === "string" ? primary : Object.keys(args).length === 0 ? "" : argsJson;
  return truncateText(text, 60);
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
  readonly edits: readonly { readonly old: string; readonly new: string; readonly path?: string }[];
}

export function multiEditDetailArgs(args: string): MultiEditDetailArgs {
  const a = parseToolArgs(args);
  const raw = Array.isArray(a.edits) ? a.edits : [];
  const edits = raw.map((item) => {
    const e = (item ?? {}) as Record<string, unknown>;
    const path = str(e.path);
    return { old: str(e.old), new: str(e.new), ...(path ? { path } : {}) };
  });
  return { path: str(a.path), edits };
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

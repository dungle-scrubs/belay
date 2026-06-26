import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { USER_AGENTS_MD } from "../paths";

/**
 * Nested AGENTS.md context loading (D-080), using Claude Code's loading model: eager up-tree from the
 * project root down to cwd (collected here), plus the user-global file, plus lazy below-cwd files
 * loaded on file access (M3). This module is the PURE core - filesystem reads in, a structured report
 * out - so it is fully testable and `buildSystemPrompt` just renders the `text` it returns.
 *
 * Precedence is positional: sources are concatenated user-global -> project-root -> … -> cwd, so the
 * MORE SPECIFIC scope (closer to the working directory) appears later and wins on conflict. Nothing is
 * field-merged; the model is told later/closer takes precedence. Every read is reported (files,
 * scopes, bytes used vs dropped, truncated) - a budget overflow truncates the LEAST specific sources
 * first and is surfaced, never silently dropped.
 */

/** The cross-tool context filename (agents.md standard), not CLAUDE.md. */
export const AGENTS_FILE = "AGENTS.md";

/** Combined byte budget across all ingested context. A backstop: AGENTS.md files are normally small;
 *  an overflow truncates the lowest-precedence sources first and is reported. */
export const CONTEXT_BYTE_BUDGET = 32 * 1024;

/** `@path` imports may nest at most this deep (matches Claude Code); deeper imports are left literal. */
export const MAX_IMPORT_HOPS = 4;

/** One ingested AGENTS.md: where it sits in the precedence order + its expanded body. */
export interface ContextScope {
  readonly path: string;
  /** Precedence band, low to high: user-global < project (up-tree) < below-cwd (lazy). */
  readonly scope: "user-global" | "project" | "below-cwd";
  /** Expanded (imports inlined) + trimmed body. */
  readonly content: string;
  /** UTF-8 byte length of `content`. */
  readonly bytes: number;
}

/** The result of rendering ingested context: the prompt block plus a full accounting (never silent). */
export interface ContextReport {
  /** The labeled block to drop into the prompt, or "" when nothing was ingested. */
  readonly text: string;
  /** Absolute paths actually ingested, in precedence order. */
  readonly files: readonly string[];
  /** Distinct scopes present, in precedence order. */
  readonly scopes: readonly string[];
  readonly bytesUsed: number;
  readonly bytesDropped: number;
  readonly truncated: boolean;
}

export const EMPTY_REPORT: ContextReport = {
  text: "",
  files: [],
  scopes: [],
  bytesUsed: 0,
  bytesDropped: 0,
  truncated: false,
};

/** True when `child` is `root` or sits inside it. */
function within(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/** Largest character-prefix of `s` whose UTF-8 encoding fits `maxBytes` (never splits a code point). */
function sliceToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) {
    return s;
  }
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return s.slice(0, lo);
}

/** Expands `@path` imports in one non-code text segment, resolving relative to `fromDir`. */
function expandSegment(
  segment: string,
  fromDir: string,
  seen: ReadonlySet<string>,
  hops: number,
): string {
  // A path token after start-of-segment or whitespace: `@some/path`. Resolve relative to the importing
  // file (absolute allowed). Missing target -> leave the literal token; cycle -> a visible note.
  return segment.replace(/(^|\s)@(\S+)/g, (match, pre: string, rel: string) => {
    const target = resolve(fromDir, rel);
    if (seen.has(target)) {
      return `${pre}[skipped circular import @${rel}]`;
    }
    let body: string;
    try {
      body = readFileSync(target, "utf8");
    } catch {
      return match; // not a readable file - leave the literal text untouched
    }
    const next = new Set(seen).add(target);
    const expanded = hops > 1 ? expandImports(body, dirname(target), next, hops - 1) : body;
    return `${pre}${expanded.trim()}`;
  });
}

/**
 * Inlines `@path` imports throughout `text`. `@paths` inside fenced (```) or inline (`) code spans are
 * left literal; relative paths resolve against `fromDir`; nesting is capped at `hops`; cycles (tracked
 * in `seen`) are broken with a visible note.
 */
function expandImports(
  text: string,
  fromDir: string,
  seen: ReadonlySet<string>,
  hops: number,
): string {
  if (hops <= 0) {
    return text;
  }
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }
      // Split on backticks: even segments are outside inline code, odd are inside (left untouched).
      return line
        .split("`")
        .map((part, i) => (i % 2 === 0 ? expandSegment(part, fromDir, seen, hops) : part))
        .join("`");
    })
    .join("\n");
}

/**
 * Reads one AGENTS.md, expands its `@path` imports, and trims it. Returns null when the file is absent,
 * unreadable, or empty/whitespace-only (so callers skip it without branching).
 */
export function readAgentsFile(absPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const expanded = expandImports(raw, dirname(absPath), new Set([absPath]), MAX_IMPORT_HOPS).trim();
  return expanded.length > 0 ? expanded : null;
}

/** Builds a ContextScope from a path + scope, or null when the file yields no content. */
function loadScope(absPath: string, scope: ContextScope["scope"]): ContextScope | null {
  const content = readAgentsFile(absPath);
  if (content === null) {
    return null;
  }
  return { path: absPath, scope, content, bytes: Buffer.byteLength(content) };
}

/**
 * The project directories whose AGENTS.md form the eager up-tree scope: from `workspaceRoot` (or the
 * nearest `.git` repo root at/under it) down to `cwd`, one entry per directory, ordered ROOT -> cwd
 * (so cwd is last and wins). The walk never goes above `workspaceRoot`.
 */
export function projectDirs(cwd: string, workspaceRoot: string): string[] {
  const root = resolve(workspaceRoot);
  const dirs: string[] = [];
  let dir = resolve(cwd);
  while (within(dir, root)) {
    dirs.push(dir);
    if (dir === root) {
      break; // workspace-root boundary (inclusive)
    }
    if (existsSync(join(dir, ".git"))) {
      break; // repo-root boundary (inclusive) - never climb past the repo
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break; // filesystem root
    }
    dir = parent;
  }
  return dirs.reverse(); // root first, cwd last
}

/**
 * Concatenates ingested sources into one labeled prompt block under a combined byte budget. To keep the
 * MOST SPECIFIC instructions, the budget is reserved from the highest-precedence end (cwd) backward, so
 * an overflow truncates the lowest-precedence sources first; the drop is always reported.
 */
export function renderContext(
  sources: readonly ContextScope[],
  budget = CONTEXT_BYTE_BUDGET,
): ContextReport {
  if (sources.length === 0) {
    return EMPTY_REPORT;
  }
  const kept: { source: ContextScope; content: string }[] = [];
  let used = 0;
  let dropped = 0;
  let truncated = false;
  // Walk highest precedence (last) to lowest (first), reserving budget for the closer scopes.
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i];
    if (source === undefined) {
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      dropped += source.bytes;
      truncated = true;
      continue;
    }
    if (source.bytes <= remaining) {
      kept.push({ source, content: source.content });
      used += source.bytes;
    } else {
      const slice = sliceToBytes(source.content, remaining);
      kept.push({ source, content: `${slice}\n…[truncated]` });
      used += Buffer.byteLength(slice);
      dropped += source.bytes - Buffer.byteLength(slice);
      truncated = true;
    }
  }
  kept.reverse(); // restore precedence order: user-global -> project -> below-cwd
  const intro =
    "Project context (AGENTS.md). These are standing instructions for this repository; follow them. " +
    "More specific scopes (closer to the working directory, listed later) take precedence over broader " +
    "ones on any conflict.";
  const sections = kept.map(
    ({ source, content }) => `### ${source.scope}: ${source.path}\n${content}`,
  );
  return {
    text: [intro, ...sections].join("\n\n"),
    files: kept.map((k) => k.source.path),
    scopes: [...new Set(kept.map((k) => k.source.scope))],
    bytesUsed: used,
    bytesDropped: dropped,
    truncated,
  };
}

/** Where the eager context is read from (defaults mirror buildSystemPrompt's). */
export interface EagerContextOptions {
  readonly cwd: string;
  readonly workspaceRoot: string;
  /** The user-global AGENTS.md path; overridable for tests. Defaults to `<TREVOR_HOME>/AGENTS.md`. */
  readonly userGlobal?: string;
  readonly budget?: number;
}

/**
 * The EAGER context SOURCES (unrendered): the user-global AGENTS.md (first, lowest precedence) plus one
 * AGENTS.md per directory from the project root down to cwd. Separated from rendering so the registry
 * can merge these with the lazy below-cwd set (M3) and budget the whole set in one pass.
 */
export function collectEagerSources(opts: EagerContextOptions): ContextScope[] {
  const sources: ContextScope[] = [];
  const userGlobal = loadScope(opts.userGlobal ?? USER_AGENTS_MD, "user-global");
  if (userGlobal) {
    sources.push(userGlobal);
  }
  for (const dir of projectDirs(opts.cwd, opts.workspaceRoot)) {
    const scope = loadScope(join(dir, AGENTS_FILE), "project");
    if (scope) {
      sources.push(scope);
    }
  }
  return sources;
}

/**
 * The EAGER context report: collected sources rendered + budgeted. Re-read every turn by
 * buildSystemPrompt so it survives compaction the same way the live checklist does (D-040).
 */
export function collectEagerContext(opts: EagerContextOptions): ContextReport {
  return renderContext(collectEagerSources(opts), opts.budget);
}

import { decodeRecallResult, type ToolName } from "@trevor/session";
import type { ReactElement } from "react";
import { parseToolArgs, toolSummary } from "@/derive";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { DocsResult, parseDocsResult } from "./docs";
import { ToolCall } from "./message";
import { MultiEditDiff } from "./multi-edit-diff";
import { SessionRecallResults } from "./session-recall";
import { ToolDiff } from "./tool-diff";
import { ToolOutput } from "./tool-output";
import { type ToolStatus, toolMessageStatus } from "./tool-status";
import { parseWebFetchResult, WebFetchResult } from "./web-fetch";
import { type WebSearchResultItem, WebSearchResults } from "./web-search";

// `parseToolArgs` now lives in `@/derive` (its single owner, beside `toolSummary`); re-exported here so
// the existing tool-renderer importers keep their import path.
export { parseToolArgs } from "@/derive";

const FRESHNESS_WINDOWS = ["day", "week", "month", "year"] as const;
type FreshnessWindow = (typeof FRESHNESS_WINDOWS)[number];

interface ParsedWebSearch {
  provider?: "brave" | "serper";
  freshness?: FreshnessWindow;
  results?: WebSearchResultItem[];
  error?: string;
}

// The web_search tool emits JSON ({provider, query, freshness?, results:[...]}) on
// success, or an "error: ..." line on failure. Parse defensively: null while the call
// is still running (no result yet), an error string surfaced as-is, otherwise the
// structured form. A truncated/non-JSON body falls back to a plain error display.
function parseWebSearchResult(raw: string | undefined): ParsedWebSearch | null {
  if (!raw) {
    return null;
  }
  if (raw.startsWith("error:")) {
    return { error: raw.replace(/^error:\s*/u, "") };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed.results)) {
      const freshness = FRESHNESS_WINDOWS.find((window) => window === parsed.freshness);
      return {
        provider: parsed.provider === "serper" ? "serper" : "brave",
        freshness,
        results: parsed.results as WebSearchResultItem[],
      };
    }
  } catch {
    // Truncated or non-JSON; fall through to a generic display below.
  }
  return { error: raw };
}

/**
 * The shared inputs every renderer arm reads: the tool message, the once-derived lifecycle
 * status, the editor-open callback, and the wrapper className. Arms take this single context so
 * the status is computed once for the whole dispatch, never per arm.
 */
interface RenderContext {
  message: ToolMessageData;
  status: ToolStatus;
  onOpenPath: (path: string) => void;
  className?: string;
}

/** Each arm renders its tool, or returns null to defer to the generic fallback row (e.g. a
 *  multi_edit/write/edit whose args don't yet carry what its specialized view needs). */
type RenderArm = (ctx: RenderContext) => ReactElement | null;

// multi_edit: one atomic operation, grouped by file as collapsible diffs (deferring to the
// generic row until at least one edit with a path has streamed in).
const renderMultiEdit: RenderArm = ({ message, status, onOpenPath, className }) => {
  const a = parseToolArgs(message.args);
  const raw = Array.isArray(a.edits) ? a.edits : [];
  const edits = raw
    .map((item) => {
      const e = (item ?? {}) as Record<string, unknown>;
      return {
        path: typeof e.path === "string" ? e.path : "",
        old: typeof e.old === "string" ? e.old : "",
        new: typeof e.new === "string" ? e.new : "",
      };
    })
    .filter((e) => e.path);

  if (edits.length === 0) {
    return null;
  }

  return (
    <MultiEditDiff
      className={className}
      edits={edits}
      status={status}
      border={false}
      onOpenPath={onOpenPath}
    />
  );
};

// write/edit render as a code diff (up to 3 lines of subdued context), deferring to the generic
// row until a path has streamed in.
const renderDiff: RenderArm = ({ message, status, onOpenPath, className }) => {
  const a = parseToolArgs(message.args);
  const path = typeof a.path === "string" ? a.path : "";

  if (!path) {
    return null;
  }

  return message.name === "write" ? (
    <ToolDiff
      className={className}
      tool="write"
      path={path}
      newText={typeof a.content === "string" ? a.content : ""}
      status={status}
      onOpenPath={() => onOpenPath(path)}
    />
  ) : (
    <ToolDiff
      className={className}
      tool="edit"
      path={path}
      oldText={typeof a.old === "string" ? a.old : ""}
      newText={typeof a.new === "string" ? a.new : ""}
      status={status}
      onOpenPath={() => onOpenPath(path)}
    />
  );
};

// web_search renders its JSON output as a result list (or the working indicator while running,
// or its error message).
const renderWebSearch: RenderArm = ({ message, status, className }) => {
  const a = parseToolArgs(message.args);
  const parsed = parseWebSearchResult(message.result);

  return (
    <WebSearchResults
      className={className}
      query={typeof a.query === "string" ? a.query : ""}
      provider={parsed?.provider}
      freshness={parsed?.freshness}
      results={parsed?.results}
      error={parsed?.error}
      status={status}
    />
  );
};

// web_fetch renders its envelope as flat source content (title, final URL, the markdown/text body,
// and a backend/attempts footer), or the working indicator while running, or its error message.
const renderWebFetch: RenderArm = ({ message, status, className }) => {
  const a = parseToolArgs(message.args);

  return (
    <WebFetchResult
      className={className}
      url={typeof a.url === "string" ? a.url : ""}
      parsed={parseWebFetchResult(message.result)}
      status={status}
    />
  );
};

// docs renders its result envelope as structured source-backed documentation: a corpus summary,
// ranked cited excerpts (resolve/refresh preview or search matches), a bounded page read, or the
// corpus inventory, with visible stale/partial/error states (or the looking-up indicator while
// running, or its error message).
const renderDocs: RenderArm = ({ message, status, className }) => {
  const a = parseToolArgs(message.args);
  const action = typeof a.action === "string" ? a.action : "docs";
  const target = [a.subject, a.query, a.url, a.corpusId].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return (
    <DocsResult
      className={className}
      args={target ? `${action} ${target}` : action}
      parsed={parseDocsResult(message.result)}
      status={status}
    />
  );
};

// session_recall renders its distilled findings + cited source rows (or the recalling indicator
// while running, or its error/empty note) from the JSON recall result.
const renderRecall: RenderArm = ({ message, status, className }) => {
  const a = parseToolArgs(message.args);
  return (
    <SessionRecallResults
      className={className}
      query={typeof a.query === "string" ? a.query : ""}
      result={decodeRecallResult(message.result)}
      status={status}
    />
  );
};

interface ParsedClipboard {
  copied?: boolean;
  charCount?: number;
  error?: string;
}

// clipboard_write emits JSON ({copied:true, charCount}) on success, or an "error: ..." line on
// failure. Parse defensively: null while running, an error string surfaced as-is, else the count.
function parseClipboardResult(raw: string | undefined): ParsedClipboard | null {
  if (!raw) {
    return null;
  }
  if (raw.startsWith("error:")) {
    return { error: raw.replace(/^error:\s*/u, "") };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.copied === true) {
      return {
        copied: true,
        charCount: typeof parsed.charCount === "number" ? parsed.charCount : undefined,
      };
    }
  } catch {
    // Truncated or non-JSON; fall through to a generic error display below.
  }
  return { error: raw };
}

// A single-line bounded preview of the copied text for the tool row (collapses whitespace).
function clipboardPreview(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

// clipboard_write shows the bounded preview of what was copied plus a "Copied N chars" line (or its
// error), keeping the external clipboard mutation visible as a normal tool result.
const renderClipboard: RenderArm = ({ message, status, className }) => {
  const a = parseToolArgs(message.args);
  const text = typeof a.text === "string" ? a.text : "";
  const parsed = parseClipboardResult(message.result);
  const output = parsed?.error
    ? parsed.error
    : parsed?.copied
      ? `Copied ${parsed.charCount ?? text.length} chars to the clipboard.`
      : undefined;

  return (
    <ToolOutput
      className={className}
      name="clipboard_write"
      args={clipboardPreview(text)}
      output={output}
      status={status}
    />
  );
};

// bash/grep render their text output (command output, matches) flat.
const renderOutput: RenderArm = ({ message, status, className }) => (
  <ToolOutput
    className={className}
    name={message.name}
    args={toolSummary(message.name, message.args)}
    output={message.result}
    status={status}
  />
);

// The default for every other (and every unknown/dynamic) tool: the generic ToolCall row. Tools
// whose primary arg is a file path get a clickable path that opens it in the editor (read/ls/...);
// pattern/command tools don't.
const renderGeneric: RenderArm = ({ message, status, onOpenPath, className }) => {
  const toolPath = parseToolArgs(message.args).path;

  return (
    <ToolCall
      className={className}
      name={message.name}
      args={toolSummary(message.name, message.args)}
      status={status}
      onOpenPath={typeof toolPath === "string" && toolPath ? () => onOpenPath(toolPath) : undefined}
    />
  );
};

/**
 * The exhaustive name -> renderer table keyed by `ToolName` (the @trevor/session contract, M24),
 * so adding or renaming a host tool surfaces here at compile time. Every known tool maps to its
 * arm (most to the generic row); unknown/dynamic tool names (custom skill/agent tools outside the
 * union) are NOT in this table and fall through to the generic default in `ToolRenderer`.
 */
const TOOL_RENDERERS: Record<ToolName, RenderArm> = {
  // Placeholder row for now: Phase 3 (live wiring) projects the pending question from the session log
  // and renders the QuestionSurface inline, hiding this raw tool row. Until then it shows a plain row.
  ask_user: renderGeneric,
  read: renderGeneric,
  glob: renderGeneric,
  grep: renderOutput,
  web_search: renderWebSearch,
  web_fetch: renderWebFetch,
  docs: renderDocs,
  session_recall: renderRecall,
  ast_grep: renderGeneric,
  // The `doctor` self-diagnostic tool returns its sanitized health report as flat text, so it
  // renders like other text-output tools (the dashboard surface is the /doctor command, not this).
  doctor: renderOutput,
  // `trevor_expert` answers capability questions from the manifest as flat, already-redacted text.
  trevor_expert: renderOutput,
  clipboard_write: renderClipboard,
  bash: renderOutput,
  write: renderDiff,
  edit: renderDiff,
  multi_edit: renderMultiEdit,
  process: renderGeneric,
  task_create: renderGeneric,
  task_update: renderGeneric,
  // task_list returns the checklist as flat text on demand, so it renders like other text-output tools.
  task_list: renderOutput,
  skill: renderGeneric,
  skills_list: renderOutput,
  skill_view: renderGeneric,
};

/**
 * The single tool-message renderer: it owns the tool NAME -> renderer dispatch and the
 * `done -> status` derivation in one place, so callers render one component instead of a name
 * ladder (M29). Status is derived once here and threaded to whichever arm runs. The dispatch is
 * keyed by `ToolName` (the @trevor/session contract) for compile-time exhaustiveness; an unknown
 * or dynamic tool name (custom skill/agent tools) falls back to the generic ToolCall row, as does
 * any arm that defers (a multi_edit/write/edit whose args haven't streamed a path yet).
 *
 * This component owns ONLY dispatch + status derivation; the per-tool visuals live in the
 * individual renderers (MultiEditDiff, ToolDiff, WebSearchResults, ToolOutput, ToolCall).
 */
export function ToolRenderer({
  message,
  className,
  onOpenPath,
}: {
  message: ToolMessageData;
  className?: string;
  /** Opens a local file in the editor (path-bearing tools wire the path to this). */
  onOpenPath: (path: string) => void;
}) {
  // The shared lifecycle rule: aborted -> error, unfinished -> running, finished -> error when the
  // result is the `error:` convention else done (so an error-result read-only tool matches the batch).
  const status: ToolStatus = toolMessageStatus(message);
  const ctx: RenderContext = { message, status, onOpenPath, className };

  const arm = Object.hasOwn(TOOL_RENDERERS, message.name)
    ? TOOL_RENDERERS[message.name as ToolName]
    : renderGeneric;

  return arm(ctx) ?? renderGeneric(ctx);
}

import { toolSummary } from "@/derive";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { ToolCall } from "./message";
import { MultiEditDiff } from "./multi-edit-diff";
import { ToolDiff } from "./tool-diff";
import { ToolOutput } from "./tool-output";
import { type WebSearchResultItem, WebSearchResults } from "./web-search";

// Tool-call arguments arrive as a JSON string; parse defensively (a streaming or
// malformed call yields {}).
export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

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
 * Dispatches one tool message to its renderer by name, owning the `done -> status`
 * derivation and the per-tool arg/result parsing in one place (so App.tsx no longer
 * carries the ~110-line name ladder, and the status is computed once here, not per arm):
 *   - multi_edit -> grouped collapsible diffs (when it parses to >0 edits);
 *   - write/edit -> a code diff (when a path is present);
 *   - web_search -> a normalized result list (or working/error);
 *   - bash/grep  -> flat text output;
 *   - everything else -> the generic ToolCall row (path-arg tools get a clickable path).
 */
export function ToolMessage({
  message,
  className,
  onOpenPath,
}: {
  message: ToolMessageData;
  className?: string;
  /** Opens a local file in the editor (path-bearing tools wire the path to this). */
  onOpenPath: (path: string) => void;
}) {
  const status = message.done ? "done" : "running";

  // multi_edit: one atomic operation, grouped by file as collapsible diffs.
  if (message.name === "multi_edit") {
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
    if (edits.length > 0) {
      return (
        <MultiEditDiff
          className={className}
          edits={edits}
          status={status}
          border={false}
          onOpenPath={onOpenPath}
        />
      );
    }
  }

  // write/edit render as a code diff (up to 3 lines of subdued context).
  if (message.name === "write" || message.name === "edit") {
    const a = parseToolArgs(message.args);
    const path = typeof a.path === "string" ? a.path : "";
    if (path) {
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
    }
  }

  // web_search renders its JSON output as a result list (or the working indicator while
  // running, or its error message).
  if (message.name === "web_search") {
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
  }

  // bash/grep render their text output (command output, matches) flat.
  if (message.name === "bash" || message.name === "grep") {
    return (
      <ToolOutput
        className={className}
        name={message.name}
        args={toolSummary(message.name, message.args)}
        output={message.result}
        status={status}
      />
    );
  }

  // Tools whose primary arg is a file path get a clickable path that opens it in the
  // editor (read/ls/...); pattern/command tools don't.
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
}

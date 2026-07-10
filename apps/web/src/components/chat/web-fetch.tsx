import { ArrowUpRight } from "lucide-react";
import { toolActionLabelForTarget } from "@/action-label";
import { MarkdownBody } from "./markdown-body";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import type { ToolStatus } from "./tool-status";

/** One backend attempt's sanitized outcome, mirroring the host envelope's `FetchAttempt`. */
export interface WebFetchAttempt {
  backend: "static" | "jina" | "firecrawl";
  status: "usable" | "thin" | "blocked" | "failed";
  detail?: string;
}

/**
 * The parsed web_fetch envelope the renderer reads: the attributable source fields plus the
 * extracted content and the ladder record. Mirrors the host's `WebFetchResult` wire form; every
 * field is optional here because a streaming or malformed result is parsed defensively.
 */
export interface ParsedWebFetch {
  url?: string;
  finalUrl?: string;
  title?: string;
  backend?: WebFetchAttempt["backend"];
  attempts?: WebFetchAttempt[];
  truncated?: boolean;
  textLength?: number;
  content?: string;
  /** A rendered error (an unsafe-URL input failure, or an unparseable body). */
  error?: string;
}

/**
 * Parses the web_fetch tool output: the structured envelope on success, an "error: ..." line on a
 * typed input failure, null while the call is still running (no result yet). A truncated/non-JSON
 * body falls back to a plain error display, matching web_search's defensive parse.
 */
export function parseWebFetchResult(raw: string | undefined): ParsedWebFetch | null {
  if (!raw) {
    return null;
  }

  if (raw.startsWith("error:")) {
    return { error: raw.replace(/^error:\s*/u, "") };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.url === "string" || typeof parsed.finalUrl === "string") {
      return {
        url: typeof parsed.url === "string" ? parsed.url : undefined,
        finalUrl: typeof parsed.finalUrl === "string" ? parsed.finalUrl : undefined,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
        backend: parsed.backend as ParsedWebFetch["backend"],
        attempts: Array.isArray(parsed.attempts)
          ? (parsed.attempts as WebFetchAttempt[])
          : undefined,
        truncated: parsed.truncated === true,
        textLength: typeof parsed.textLength === "number" ? parsed.textLength : undefined,
        content: typeof parsed.content === "string" ? parsed.content : undefined,
      };
    }
  } catch {
    // Truncated or non-JSON; fall through to a generic error display below.
  }

  return { error: raw };
}

/** Hostname + path, www-stripped, for the subdued link line - matches web_search's `prettyUrl`. */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname.replace(/^www\./u, "")}${path}${u.search}`;
  } catch {
    return url;
  }
}

/** The compact `backend · N attempts · truncated` footer summarizing the ladder for this fetch. */
function footer(parsed: ParsedWebFetch): string {
  const attempts = parsed.attempts ?? [];
  const ladder =
    attempts.length > 0 ? attempts.map((a) => `${a.backend} ${a.status}`).join(" → ") : undefined;
  return [
    parsed.backend ? `via ${parsed.backend}` : undefined,
    ladder,
    parsed.truncated ? "truncated" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface WebFetchResultProps {
  /** The URL the model fetched (the tool's `url` argument). */
  url: string;
  parsed?: ParsedWebFetch | null;
  status?: ToolStatus;
  /** Whether the body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  className?: string;
  /** Ms epoch of the tool's start; feeds the running row's live elapsed clock (58.6.1 M2). */
  startedAt?: number;
}

/**
 * Renders a `web_fetch` tool call as FLAT source content: the ToolCall row (name + url) over the
 * source title, its final URL as a link, the extracted markdown/text body, and a compact
 * backend/attempts + truncation footer. Reuses web_search's link styling and the shared
 * StatusAwareToolRenderer (a working indicator while running, a red message on error), so the
 * model's reader output reads as a source - never opaque JSON.
 */
export function WebFetchResult({
  url,
  parsed,
  status = "done",
  defaultOpen = true,
  className,
  startedAt,
}: WebFetchResultProps) {
  const linkUrl = parsed?.finalUrl ?? parsed?.url ?? url;
  const meta = parsed ? footer(parsed) : "";
  const content = parsed?.content ?? "";

  const body = (
    <div className="flex flex-col gap-2.5">
      {parsed?.title ? (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-smui-frost-3 hover:underline"
        >
          {parsed.title}
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
      ) : null}
      <span className="truncate text-xs text-smui-frost-3/80">{prettyUrl(linkUrl)}</span>
      {content ? (
        <MarkdownBody text={content} muted />
      ) : (
        <span className="text-sm italic text-muted-foreground">No content.</span>
      )}
      {meta ? (
        <span className="text-label tracking-wider text-muted-foreground/70">{meta}</span>
      ) : null}
    </div>
  );

  return (
    <StatusAwareToolRenderer
      name="web_fetch"
      args={url}
      status={status}
      error={parsed?.error}
      running={status === "running" && !parsed}
      runningLabel={toolActionLabelForTarget("web_fetch", url)}
      startedAt={startedAt}
      defaultOpen={defaultOpen}
      className={className}
      renderBody={() => body}
    />
  );
}

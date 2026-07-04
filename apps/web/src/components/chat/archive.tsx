import { FileArchive, ImageIcon, TriangleAlert } from "lucide-react";
import { toolActionLabelForTarget } from "@/action-label";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import type { ToolStatus } from "./tool-status";

/** `renderArchive` (tool-message.tsx) passes this sentinel as `args` when the call carries neither a
 *  path nor a url yet - never a genuine source name, so it must not be shown as a running target
 *  (the verb "reading archive"/"extracting archive" already says "archive"; appending the sentinel
 *  would read "reading archive archive"). */
const NO_SOURCE_SENTINEL = "archive";

export interface ArchiveEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly compressedBytes?: number;
  readonly expandedBytes?: number;
  readonly processor?: "text" | "csv" | "image" | "pdf" | "manifest";
  readonly preview?: string;
  readonly lineCount?: number;
  readonly truncated?: boolean;
  readonly mime?: string;
  readonly width?: number;
  readonly height?: number;
  readonly warnings?: readonly string[];
}

export interface ParsedArchiveResult {
  readonly tool?: "archive_read" | "archive_unpack";
  readonly source?: string;
  readonly path?: string;
  readonly url?: string;
  readonly destination?: string;
  readonly archiveBytes?: number;
  readonly expandedBytes?: number;
  readonly entries?: readonly ArchiveEntry[];
  readonly extractedEntries?: readonly { readonly path: string; readonly bytes?: number }[];
  readonly warnings?: readonly string[];
  readonly error?: string;
}

export function parseArchiveResult(raw: string | undefined): ParsedArchiveResult | null {
  if (!raw) {
    return null;
  }
  if (raw.startsWith("error:")) {
    return { error: raw.replace(/^error:\s*/u, "") };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.tool === "archive_read" || parsed.tool === "archive_unpack") {
      return {
        tool: parsed.tool,
        source: str(parsed.source),
        path: str(parsed.path),
        url: str(parsed.url),
        destination: str(parsed.destination),
        archiveBytes: num(parsed.archiveBytes),
        expandedBytes: num(parsed.expandedBytes),
        entries: Array.isArray(parsed.entries) ? (parsed.entries as ArchiveEntry[]) : undefined,
        extractedEntries: Array.isArray(parsed.extractedEntries)
          ? (parsed.extractedEntries as ParsedArchiveResult["extractedEntries"])
          : undefined,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter(isString) : undefined,
      };
    }
  } catch {
    // Truncated or non-JSON; fall through to a generic error display below.
  }
  return { error: raw };
}

interface ArchiveResultProps {
  readonly name: "archive_read" | "archive_unpack";
  readonly args: string;
  readonly parsed?: ParsedArchiveResult | null;
  readonly status?: ToolStatus;
  readonly className?: string;
}

export function ArchiveResult({
  name,
  args,
  parsed,
  status = "done",
  className,
}: ArchiveResultProps) {
  const body = parsed ? <ArchiveBody parsed={parsed} /> : null;
  const target = args === NO_SOURCE_SENTINEL ? undefined : args;

  return (
    <StatusAwareToolRenderer
      name={name}
      args={args}
      status={status}
      error={parsed?.error}
      running={status === "running" && !parsed}
      runningLabel={toolActionLabelForTarget(name, target)}
      className={className}
      renderBody={() => body}
    />
  );
}

function ArchiveBody({ parsed }: { readonly parsed: ParsedArchiveResult }) {
  const readEntries = parsed.entries ?? [];
  const extracted = parsed.extractedEntries ?? [];
  const warnings = parsed.warnings ?? [];
  const source = parsed.source ?? parsed.path ?? parsed.url ?? "archive";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1">
          <FileArchive className="size-3.5 shrink-0 text-smui-frost-3" />
          <span className="truncate">{source}</span>
        </span>
        <span>{readEntries.length || extracted.length} entries</span>
        {parsed.archiveBytes !== undefined ? (
          <span>{formatBytes(parsed.archiveBytes)} zip</span>
        ) : null}
        {parsed.expandedBytes !== undefined ? (
          <span>{formatBytes(parsed.expandedBytes)} expanded</span>
        ) : null}
      </div>
      {parsed.destination ? (
        <span className="truncate text-xs text-muted-foreground">to {parsed.destination}</span>
      ) : null}
      {warnings.length ? (
        <div className="flex flex-col gap-1 text-xs text-smui-yellow">
          {warnings.map((warning) => (
            <span key={warning} className="inline-flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {warning}
            </span>
          ))}
        </div>
      ) : null}
      {readEntries.length ? <ArchiveEntryList entries={readEntries} /> : null}
      {extracted.length ? <ExtractedEntryList entries={extracted} /> : null}
    </div>
  );
}

function ArchiveEntryList({ entries }: { readonly entries: readonly ArchiveEntry[] }) {
  return (
    <div className="flex flex-col divide-y divide-border/70 border-border border-t">
      {entries.slice(0, 8).map((entry) => (
        <div key={entry.path} className="flex flex-col gap-1 py-1.5">
          <div className="flex items-center gap-2 text-xs">
            {entry.processor === "image" ? (
              <ImageIcon className="size-3 shrink-0 text-smui-frost-3" />
            ) : (
              <FileArchive className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {entry.path}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {entry.processor ?? "manifest"}
              {entry.expandedBytes !== undefined ? ` · ${formatBytes(entry.expandedBytes)}` : ""}
            </span>
          </div>
          {entry.preview ? (
            <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-words text-xs text-muted-foreground/80">
              {entry.preview}
            </pre>
          ) : entry.processor === "image" ? (
            <span className="text-xs text-muted-foreground">
              {entry.mime} {entry.width}x{entry.height}
            </span>
          ) : null}
          {entry.warnings?.length ? (
            <span className="text-xs text-smui-yellow">{entry.warnings.join(" · ")}</span>
          ) : null}
        </div>
      ))}
      {entries.length > 8 ? (
        <span className="py-1.5 text-label tracking-wider text-muted-foreground/70">
          +{entries.length - 8} more entries
        </span>
      ) : null}
    </div>
  );
}

function ExtractedEntryList({
  entries,
}: {
  readonly entries: readonly { readonly path: string; readonly bytes?: number }[];
}) {
  return (
    <div className="flex flex-col divide-y divide-border/70 border-border border-t">
      {entries.slice(0, 8).map((entry) => (
        <div key={entry.path} className="flex items-center gap-2 py-1.5 text-xs">
          <FileArchive className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">{entry.path}</span>
          {entry.bytes !== undefined ? (
            <span className="shrink-0 text-muted-foreground">{formatBytes(entry.bytes)}</span>
          ) : null}
        </div>
      ))}
      {entries.length > 8 ? (
        <span className="py-1.5 text-label tracking-wider text-muted-foreground/70">
          +{entries.length - 8} more entries
        </span>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

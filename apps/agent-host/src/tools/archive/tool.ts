import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { contextRegistry } from "@host/project-context/registry";
import { Schema } from "effect";
import { simpleTool, toolInput } from "../shared";
import { ArchiveToolError } from "./errors";
import type { ArchiveProcessorName, ArchiveProcessorResult } from "./processors";
import { processArchiveEntry } from "./processors";
import { type ArchiveSourceDeps, liveArchiveSourceDeps, readArchiveSource } from "./source";
import { assertContained } from "./validators";
import { parseZipEntries, type ZipEntry } from "./zip";

const DEFAULT_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const DEFAULT_ENTRY_LIMIT = 10_000;
const DEFAULT_TEXT_PREVIEW_BUDGET = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const TEXT_PREVIEW_BUDGET_WARNING =
  "Archive text preview budget exhausted; use include patterns to inspect specific files.";

const ProcessorName = Schema.Literal("text", "csv", "image", "pdf", "manifest");

const ArchiveReadParams = Schema.Struct({
  path: Schema.optional(Schema.String).annotations({
    description: "Local zip archive path to inspect. Use either path or url.",
  }),
  url: Schema.optional(Schema.String).annotations({
    description: "Public http(s) zip archive URL to inspect. Use either url or path.",
  }),
  include: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Optional glob patterns selecting archive entries to inspect.",
  }),
  processors: Schema.optional(Schema.Array(ProcessorName)).annotations({
    description: "Optional processors to run: text, csv, image, pdf, manifest.",
  }),
  maxArchiveBytes: Schema.optional(Schema.Number).annotations({
    description: "Maximum local or downloaded archive bytes.",
  }),
  maxExpandedBytes: Schema.optional(Schema.Number).annotations({
    description: "Maximum selected uncompressed bytes.",
  }),
  entryLimit: Schema.optional(Schema.Number).annotations({
    description: "Maximum selected file entries.",
  }),
});

const ArchiveUnpackParams = Schema.Struct({
  path: Schema.String.annotations({ description: "Local zip archive path to extract." }),
  destination: Schema.String.annotations({
    description: "Destination directory. Relative paths resolve from the host working directory.",
  }),
  include: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Optional glob patterns selecting archive entries to extract.",
  }),
  maxArchiveBytes: Schema.optional(Schema.Number).annotations({
    description: "Maximum local archive bytes.",
  }),
  maxExpandedBytes: Schema.optional(Schema.Number).annotations({
    description: "Maximum selected uncompressed bytes.",
  }),
  entryLimit: Schema.optional(Schema.Number).annotations({
    description: "Maximum selected file entries.",
  }),
});

type ArchiveReadArgs = typeof ArchiveReadParams.Type;
type ArchiveUnpackArgs = typeof ArchiveUnpackParams.Type;

interface ArchiveReadEntry {
  readonly path: string;
  readonly originalPath: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly processor: ArchiveProcessorResult["processor"];
  readonly preview?: string;
  readonly lineCount?: number;
  readonly truncated?: boolean;
  readonly headers?: readonly string[];
  readonly sampleRows?: readonly (readonly string[])[];
  readonly rowCount?: number;
  readonly mime?: string;
  readonly width?: number;
  readonly height?: number;
  readonly byteSize?: number;
  readonly contentHash?: Extract<
    ArchiveProcessorResult,
    { readonly processor: "image" }
  >["contentHash"];
  readonly pageCount?: number;
  readonly warnings?: readonly string[];
}

export interface ArchiveReadResult {
  readonly tool: "archive_read";
  readonly source: string;
  readonly path?: string;
  readonly url?: string;
  readonly archiveBytes: number;
  readonly expandedBytes: number;
  readonly entries: readonly ArchiveReadEntry[];
  readonly warnings: readonly string[];
}

export interface ArchiveUnpackResult {
  readonly tool: "archive_unpack";
  readonly source: string;
  readonly path: string;
  readonly destination: string;
  readonly archiveBytes: number;
  readonly expandedBytes: number;
  readonly extractedEntries: readonly {
    readonly path: string;
    readonly destination: string;
    readonly bytes: number;
  }[];
  readonly warnings: readonly string[];
}

export const archiveReadTool = buildArchiveReadTool();
export const archiveUnpackTool = buildArchiveUnpackTool();

export function buildArchiveReadTool(deps: ArchiveSourceDeps = liveArchiveSourceDeps) {
  return simpleTool({
    name: "archive_read",
    description:
      "Inspect a zip archive from a local path or public URL. Returns a bounded manifest, safe previews, image/pdf metadata, and warnings without writing into the workspace.",
    params: ArchiveReadParams,
    readOnly: true,
    capped: true,
    execute: async (args) => JSON.stringify(await runArchiveRead(args, deps), null, 2),
  });
}

export function buildArchiveUnpackTool(deps: ArchiveSourceDeps = liveArchiveSourceDeps) {
  return simpleTool({
    name: "archive_unpack",
    description:
      "Extract selected entries from a local zip archive into an explicit destination after zip-slip validation. Requires path and destination.",
    params: ArchiveUnpackParams,
    execute: async (args) => JSON.stringify(await runArchiveUnpack(args, deps), null, 2),
  });
}

export async function runArchiveRead(
  args: ArchiveReadArgs,
  deps: ArchiveSourceDeps = liveArchiveSourceDeps,
): Promise<ArchiveReadResult> {
  try {
    validateReadSource(args);
    const source = await readArchiveSource(
      { path: args.path, url: args.url },
      sourceOptions(args),
      deps,
    );
    const entries = parseZipEntries(source.bytes, zipLimits(args), args.include);
    const processed = boundArchiveTextPreviews(
      entries.map((entry) => ({
        path: entry.normalizedPath,
        originalPath: entry.name,
        compressedBytes: entry.compressedSize,
        expandedBytes: entry.uncompressedSize,
        ...processArchiveEntry({
          path: entry.normalizedPath,
          bytes: entry.content,
          processors: args.processors as readonly ArchiveProcessorName[] | undefined,
        }),
      })),
    );

    if (source.kind === "path") {
      contextRegistry.noteFileAccess(resolve(process.cwd(), source.label));
    }

    return {
      tool: "archive_read",
      source: source.label,
      ...(source.kind === "path" ? { path: source.label } : { url: source.label }),
      archiveBytes: source.bytes.byteLength,
      expandedBytes: expandedBytes(entries),
      entries: processed.entries,
      warnings: processed.warnings,
    };
  } catch (error) {
    handleArchiveError(error);
  }
}

export async function runArchiveUnpack(
  args: ArchiveUnpackArgs,
  deps: ArchiveSourceDeps = liveArchiveSourceDeps,
): Promise<ArchiveUnpackResult> {
  try {
    const source = await readArchiveSource({ path: args.path }, sourceOptions(args), deps);
    const entries = parseZipEntries(source.bytes, zipLimits(args), args.include);
    const destination = resolveArchiveDestination(args.destination);

    await mkdir(destination, { recursive: true });

    const extractedEntries = [];
    for (const entry of entries) {
      const targetPath = resolve(destination, entry.normalizedPath);
      assertContained(destination, targetPath, entry.normalizedPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, entry.content);
      contextRegistry.noteFileAccess(targetPath);
      extractedEntries.push({
        path: entry.normalizedPath,
        destination: targetPath,
        bytes: entry.uncompressedSize,
      });
    }

    return {
      tool: "archive_unpack",
      source: source.label,
      path: source.label,
      destination,
      archiveBytes: source.bytes.byteLength,
      expandedBytes: expandedBytes(entries),
      extractedEntries,
      warnings: [],
    };
  } catch (error) {
    handleArchiveError(error);
  }
}

function validateReadSource(args: ArchiveReadArgs): void {
  if (Boolean(args.path) === Boolean(args.url)) {
    toolInput("archive_read requires exactly one of path or url");
  }
}

function sourceOptions(args: { readonly maxArchiveBytes?: number }): {
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
} {
  return {
    maxBytes: boundedPositive(args.maxArchiveBytes, DEFAULT_MAX_ARCHIVE_BYTES),
    maxRedirects: MAX_REDIRECTS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function zipLimits(args: { readonly entryLimit?: number; readonly maxExpandedBytes?: number }): {
  readonly entryLimit: number;
  readonly maxExpandedBytes: number;
} {
  return {
    entryLimit: boundedPositive(args.entryLimit, DEFAULT_ENTRY_LIMIT),
    maxExpandedBytes: boundedPositive(args.maxExpandedBytes, DEFAULT_MAX_EXPANDED_BYTES),
  };
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function expandedBytes(entries: readonly ZipEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
}

function boundArchiveTextPreviews(entries: readonly ArchiveReadEntry[]): {
  readonly entries: readonly ArchiveReadEntry[];
  readonly warnings: readonly string[];
} {
  let remainingPreviewBytes = DEFAULT_TEXT_PREVIEW_BUDGET;
  let exhausted = false;

  const boundedEntries = entries.map((entry) => {
    if (entry.processor !== "text" || typeof entry.preview !== "string") {
      return entry;
    }
    if (entry.preview.length <= remainingPreviewBytes) {
      remainingPreviewBytes -= entry.preview.length;
      return entry;
    }
    exhausted = true;
    const {
      lineCount: _lineCount,
      preview: _preview,
      truncated: _truncated,
      ...manifestEntry
    } = entry;
    return { ...manifestEntry, processor: "manifest" as const };
  });

  return {
    entries: boundedEntries,
    warnings: exhausted ? [TEXT_PREVIEW_BUDGET_WARNING] : [],
  };
}

function resolveArchiveDestination(destination: string): string {
  if (destination === "~") {
    return homedir();
  }
  const expanded = destination.startsWith("~/")
    ? `${homedir()}${destination.slice(1)}`
    : destination;
  return resolve(process.cwd(), expanded);
}

function handleArchiveError(error: unknown): never {
  if (error instanceof ArchiveToolError) {
    toolInput(error.message);
  }
  throw error;
}

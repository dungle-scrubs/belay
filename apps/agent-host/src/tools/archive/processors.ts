/**
 * Responsible for: per-entry archive content processing - text/csv/pdf previews, image
 * metadata sniffing (png/jpeg), and the manifest-only fallback.
 * Not for: selecting or decompressing entries - zip.ts owns parsing.
 */
import { createHash } from "node:crypto";

export type ArchiveProcessorName = "text" | "csv" | "image" | "pdf" | "manifest";

export type ArchiveProcessorResult =
  | {
      readonly processor: "text";
      readonly preview: string;
      readonly lineCount: number;
      readonly truncated: boolean;
    }
  | {
      readonly processor: "csv";
      readonly headers: readonly string[];
      readonly sampleRows: readonly (readonly string[])[];
      readonly rowCount: number;
      readonly truncated: boolean;
    }
  | {
      readonly processor: "image";
      readonly mime: string;
      readonly width: number;
      readonly height: number;
      readonly byteSize: number;
      readonly contentHash: string;
    }
  | {
      readonly processor: "pdf";
      readonly pageCount: number;
      readonly preview: string;
      readonly warnings: readonly string[];
    }
  | { readonly processor: "manifest" };

export function processArchiveEntry(input: {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly processors?: readonly ArchiveProcessorName[];
}): ArchiveProcessorResult {
  if (isCsvPath(input.path) && processorEnabled(input.processors, "csv")) {
    return processCsv(input.bytes);
  }
  if (isTextPath(input.path) && processorEnabled(input.processors, "text")) {
    return processText(input.bytes);
  }
  const image = imageMetadata(input.bytes);
  if (image && processorEnabled(input.processors, "image")) {
    return {
      processor: "image",
      ...image,
      byteSize: input.bytes.byteLength,
      contentHash: createHash("sha256").update(input.bytes).digest("hex"),
    };
  }
  if (
    (/\.pdf$/iu.test(input.path) || startsWith(input.bytes, "%PDF-")) &&
    processorEnabled(input.processors, "pdf")
  ) {
    return processPdf(input.bytes);
  }
  return { processor: "manifest" };
}

function processorEnabled(
  processors: readonly ArchiveProcessorName[] | undefined,
  processor: ArchiveProcessorName,
): boolean {
  return processors === undefined || processors.includes(processor);
}

function processText(bytes: Uint8Array): ArchiveProcessorResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const previewLimit = 4_096;
  return {
    processor: "text",
    preview: text.slice(0, previewLimit),
    lineCount: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
    truncated: text.length > previewLimit,
  };
}

function processCsv(bytes: Uint8Array): ArchiveProcessorResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const rows = text
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.length > 0)
    .map((line) => parseCsvRow(line));
  const [headers = [], ...dataRows] = rows;
  return {
    processor: "csv",
    headers,
    sampleRows: dataRows.slice(0, 10),
    rowCount: dataRows.length,
    truncated: dataRows.length > 10,
  };
}

function processPdf(bytes: Uint8Array): ArchiveProcessorResult {
  const text = new TextDecoder("latin1").decode(bytes);
  const pageCount = Math.max(0, (text.match(/\/Type\s*\/Page\b/gu) ?? []).length);
  const preview = text
    .replace(/[^\x20-\x7e\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
  return {
    processor: "pdf",
    pageCount,
    preview,
    warnings: pageCount === 0 ? ["PDF page count unavailable from lightweight parser."] : [],
  };
}

function isTextPath(path: string): boolean {
  return /\.(txt|md|log|json|xml|html|css|js|ts|tsx|jsx|rs|py|java|go|rb|sh)$/iu.test(path);
}

function isCsvPath(path: string): boolean {
  return /\.(csv|tsv)$/iu.test(path);
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function imageMetadata(
  bytes: Uint8Array,
): { readonly mime: string; readonly width: number; readonly height: number } | undefined {
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      mime: "image/png",
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegSize(bytes);
  }
  return undefined;
}

function readJpegSize(
  bytes: Uint8Array,
): { readonly mime: string; readonly width: number; readonly height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        mime: "image/jpeg",
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  const encoded = new TextEncoder().encode(prefix);
  return encoded.every((byte, index) => bytes[index] === byte);
}

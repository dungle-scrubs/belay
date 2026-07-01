import { matchesGlob } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ArchiveToolError } from "./errors";
import { normalizeArchiveEntryName } from "./validators";

export interface ZipEntry {
  readonly name: string;
  readonly normalizedPath: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly content: Uint8Array;
}

export interface ZipLimits {
  readonly entryLimit: number;
  readonly maxExpandedBytes: number;
}

function archiveEntryIncluded(
  normalizedPath: string,
  include: readonly string[] | undefined,
): boolean {
  if (!include || include.length === 0) {
    return true;
  }
  return include.some(
    (pattern) => normalizedPath === pattern || matchesGlob(normalizedPath, pattern),
  );
}

export function parseZipEntries(
  bytes: Uint8Array,
  limits: ZipLimits,
  include?: readonly string[],
): ZipEntry[] {
  const central = parseCentralDirectoryZip(bytes, limits, include);
  if (central) {
    return central;
  }
  return parseLocalHeaderZip(bytes, limits, include);
}

function parseLocalHeaderZip(
  bytes: Uint8Array,
  limits: ZipLimits,
  include: readonly string[] | undefined,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let expandedBytes = 0;
  let sawFileEntry = false;

  while (offset + 4 <= bytes.byteLength) {
    const signature = readU32(bytes, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50) {
      throw invalidZip("Archive is not a readable zip file.");
    }

    const flags = readU16(bytes, offset + 6);
    const compressionMethod = readU16(bytes, offset + 8);
    const compressedSize = readU32(bytes, offset + 18);
    const uncompressedSize = readU32(bytes, offset + 22);
    const fileNameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + fileNameLength + extraLength;
    const contentEnd = contentStart + compressedSize;

    if (contentEnd > bytes.byteLength) {
      throw invalidZip("Zip entry is truncated.");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidZip("Only stored and deflated zip entries are supported by the archive reader.");
    }
    if ((flags & 0x01) !== 0) {
      throw invalidZip("Encrypted zip entries are not supported by the archive reader.");
    }
    if ((flags & 0x08) !== 0) {
      throw invalidZip("Zip data descriptors require a central directory.");
    }

    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength));
    offset = contentEnd;

    if (name.endsWith("/")) {
      continue;
    }
    sawFileEntry = true;

    const normalizedPath = normalizeArchiveEntryName(name);
    if (!archiveEntryIncluded(normalizedPath, include)) {
      continue;
    }

    assertEntryAllowed(entries, seen, normalizedPath, limits);
    expandedBytes = assertExpandedLimit(expandedBytes + uncompressedSize, limits);

    const compressedContent = bytes.slice(contentStart, contentEnd);
    entries.push({
      name,
      normalizedPath,
      compressedSize,
      uncompressedSize,
      content:
        compressionMethod === 8
          ? inflateZipEntry(compressedContent, uncompressedSize)
          : compressedContent,
    });
  }

  if (entries.length === 0 && !sawFileEntry) {
    throw invalidZip("Archive contains no readable entries.");
  }
  return entries;
}

function parseCentralDirectoryZip(
  bytes: Uint8Array,
  limits: ZipLimits,
  include: readonly string[] | undefined,
): ZipEntry[] | undefined {
  const endOfCentralDirectoryOffset = findEndOfCentralDirectory(bytes);
  if (endOfCentralDirectoryOffset === undefined) {
    return undefined;
  }

  const centralDirectorySize = readU32(bytes, endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = readU32(bytes, endOfCentralDirectoryOffset + 16);
  if (centralDirectorySize === 0) {
    return undefined;
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > bytes.byteLength) {
    throw invalidZip("Zip central directory is truncated.");
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = centralDirectoryOffset;
  let expandedBytes = 0;
  let sawFileEntry = false;

  while (offset < centralDirectoryEnd) {
    if (readU32(bytes, offset) !== 0x02014b50) {
      throw invalidZip("Zip central directory is invalid.");
    }

    const flags = readU16(bytes, offset + 8);
    const compressionMethod = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const fileNameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const externalAttributes = readU32(bytes, offset + 38);
    const localHeaderOffset = readU32(bytes, offset + 42);
    const nameStart = offset + 46;
    const nextOffset = nameStart + fileNameLength + extraLength + commentLength;

    if (nextOffset > centralDirectoryEnd) {
      throw invalidZip("Zip central directory entry is truncated.");
    }

    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength));
    offset = nextOffset;

    if (name.endsWith("/")) {
      continue;
    }
    sawFileEntry = true;

    const normalizedPath = normalizeArchiveEntryName(name);
    if (!archiveEntryIncluded(normalizedPath, include)) {
      continue;
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidZip("Only stored and deflated zip entries are supported by the archive reader.");
    }
    if ((flags & 0x01) !== 0) {
      throw invalidZip("Encrypted zip entries are not supported by the archive reader.");
    }
    if (isUnixSymlink(externalAttributes)) {
      throw new ArchiveToolError({
        code: "ARCHIVE_ENTRY_UNSAFE",
        detail: `Archive entry is a symlink and will not be extracted: ${name}`,
      });
    }

    assertEntryAllowed(entries, seen, normalizedPath, limits);
    expandedBytes = assertExpandedLimit(expandedBytes + uncompressedSize, limits);

    if (readU32(bytes, localHeaderOffset) !== 0x04034b50) {
      throw invalidZip("Zip local file header is invalid.");
    }
    const localFileNameLength = readU16(bytes, localHeaderOffset + 26);
    const localExtraLength = readU16(bytes, localHeaderOffset + 28);
    const contentStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > bytes.byteLength) {
      throw invalidZip("Zip entry is truncated.");
    }

    const compressedContent = bytes.slice(contentStart, contentEnd);
    entries.push({
      name,
      normalizedPath,
      compressedSize,
      uncompressedSize,
      content:
        compressionMethod === 8
          ? inflateZipEntry(compressedContent, uncompressedSize)
          : compressedContent,
    });
  }

  if (entries.length === 0 && !sawFileEntry) {
    throw invalidZip("Archive contains no readable entries.");
  }
  return entries;
}

function assertEntryAllowed(
  entries: readonly ZipEntry[],
  seen: Set<string>,
  normalizedPath: string,
  limits: ZipLimits,
): void {
  if (entries.length >= limits.entryLimit) {
    throw new ArchiveToolError({
      code: "ARCHIVE_EXPANSION_TOO_LARGE",
      detail: "Archive entry limit exceeded.",
    });
  }
  if (seen.has(normalizedPath)) {
    throw new ArchiveToolError({
      code: "ARCHIVE_ENTRY_UNSAFE",
      detail: `Archive contains duplicate entry path: ${normalizedPath}`,
    });
  }
  seen.add(normalizedPath);
}

function assertExpandedLimit(nextExpandedBytes: number, limits: ZipLimits): number {
  if (nextExpandedBytes > limits.maxExpandedBytes) {
    throw new ArchiveToolError({
      code: "ARCHIVE_EXPANSION_TOO_LARGE",
      detail: "Archive expanded bytes exceed the configured limit.",
    });
  }
  return nextExpandedBytes;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number | undefined {
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  return undefined;
}

function inflateZipEntry(bytes: Uint8Array, expectedSize: number): Uint8Array {
  try {
    const inflated = inflateRawSync(bytes);
    if (inflated.byteLength !== expectedSize) {
      throw invalidZip("Deflated zip entry size does not match its manifest.");
    }
    return new Uint8Array(inflated);
  } catch (error) {
    if (error instanceof ArchiveToolError) {
      throw error;
    }
    throw invalidZip("Deflated zip entry could not be decoded.");
  }
}

function invalidZip(detail: string): ArchiveToolError {
  return new ArchiveToolError({ code: "ARCHIVE_INVALID_ZIP", detail });
}

function isUnixSymlink(externalAttributes: number): boolean {
  const mode = externalAttributes >>> 16;
  return (mode & 0xf000) === 0xa000;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

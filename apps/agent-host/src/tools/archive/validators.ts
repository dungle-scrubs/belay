import { normalize, sep } from "node:path";
import { ArchiveToolError } from "./errors";

/**
 * Archive trust-boundary validators: entry names and extraction destinations are normalized before
 * bytes are processed or written, so zip parsing and extraction share one safety contract.
 */

export function normalizeArchiveEntryName(rawName: string): string {
  const slashName = rawName.replaceAll("\\", "/");

  if (
    slashName.trim().length === 0 ||
    slashName.startsWith("/") ||
    /^[A-Za-z]:\//u.test(slashName) ||
    slashName.endsWith("/")
  ) {
    throw new ArchiveToolError({
      code: "ARCHIVE_ENTRY_UNSAFE",
      detail: `Archive entry has an unsafe path: ${rawName}`,
    });
  }

  const normalized = normalize(slashName).split(sep).join("/");

  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw new ArchiveToolError({
      code: "ARCHIVE_ENTRY_UNSAFE",
      detail: `Archive entry escapes the archive root: ${rawName}`,
    });
  }

  if (/\.(zip|tar|tgz|gz|bz2|xz)$/iu.test(normalized)) {
    throw new ArchiveToolError({
      code: "ARCHIVE_ENTRY_UNSAFE",
      detail: `Nested archive entries are not supported: ${rawName}`,
    });
  }

  return normalized;
}

export function assertContained(destination: string, target: string, entryPath: string): void {
  if (target !== destination && !target.startsWith(`${destination}${sep}`)) {
    throw new ArchiveToolError({
      code: "ARCHIVE_ENTRY_UNSAFE",
      detail: `Archive entry would write outside destination: ${entryPath}`,
    });
  }
}

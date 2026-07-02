/**
 * Responsible for: the typed ArchiveToolError and its failure-code vocabulary
 * (URL rejected, too large, invalid zip, unsafe entry, over-expansion).
 */
import { Data } from "effect";

export type ArchiveFailureCode =
  | "ARCHIVE_URL_REJECTED"
  | "ARCHIVE_DOWNLOAD_TOO_LARGE"
  | "ARCHIVE_INVALID_ZIP"
  | "ARCHIVE_ENTRY_UNSAFE"
  | "ARCHIVE_EXPANSION_TOO_LARGE";

export class ArchiveToolError extends Data.TaggedError("ArchiveToolError")<{
  readonly code: ArchiveFailureCode;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.code}: ${this.detail}`;
  }
}

/**
 * Responsible for: the typed failure vocabulary for video inspection - the classes that
 * classify every way probing, frame extraction, artifact writing, and provider continuation
 * can degrade or fail. Each carries a bounded `message` (never raw ffmpeg stderr spam), so a
 * failure surfaces as one readable warning line, never leaked binary/command output.
 *
 * Not for: the tool orchestration (tool.ts) or the extraction pipeline (processor.ts).
 */
import { Data } from "effect";

/** ffprobe and/or ffmpeg could not be found - the tool degrades to an unavailable result. */
export class VideoBinaryMissingError extends Data.TaggedError("VideoBinaryMissingError")<{
  readonly missing: readonly string[];
}> {
  override get message(): string {
    return `Video processor unavailable: missing ${this.missing.join(" and ")}.`;
  }
}

/** ffprobe failed or returned unparseable JSON; metadata degrades to what could be read. */
export class VideoProbeError extends Data.TaggedError("VideoProbeError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `Video metadata probe failed: ${this.detail}`;
  }
}

/** A single frame extraction exceeded its timeout budget. */
export class VideoFrameTimeoutError extends Data.TaggedError("VideoFrameTimeoutError")<{
  readonly frameIndex: number;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `Frame ${this.frameIndex} extraction timed out after ${this.timeoutMs}ms.`;
  }
}

/** The media had no decodable video stream (extraction produced nothing usable). */
export class VideoUnsupportedMediaError extends Data.TaggedError("VideoUnsupportedMediaError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `Unsupported or non-video media: ${this.detail}`;
  }
}

/** The inspection was cancelled (the turn was interrupted). Propagates - it never degrades. */
export class VideoCancelledError extends Data.TaggedError("VideoCancelledError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `Video inspection cancelled: ${this.detail}`;
  }
}

/** Persisting an extracted frame to the blob store failed; that frame is dropped. */
export class VideoArtifactWriteError extends Data.TaggedError("VideoArtifactWriteError")<{
  readonly frameIndex: number;
  readonly detail: string;
}> {
  override get message(): string {
    return `Frame ${this.frameIndex} could not be stored: ${this.detail}`;
  }
}

/** Encoding frame artifacts into provider continuation content failed; degrades to text-only. */
export class VideoContinuationError extends Data.TaggedError("VideoContinuationError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `Video frame continuation failed: ${this.detail}`;
  }
}

export type VideoInspectError =
  | VideoBinaryMissingError
  | VideoProbeError
  | VideoFrameTimeoutError
  | VideoUnsupportedMediaError
  | VideoCancelledError
  | VideoArtifactWriteError
  | VideoContinuationError;

/**
 * Responsible for: the typed failure vocabulary for video inspection - the TWO outcomes the pipeline
 * actually acts on: a cancellation that PROPAGATES (aborts the whole inspection) and a recoverable
 * DEGRADATION that is folded into a warning line so inspection keeps going. Each carries a bounded
 * message (never raw ffmpeg stderr spam), so a failure surfaces as one readable warning, never leaked
 * binary/command output.
 *
 * Not for: the tool orchestration (tool.ts) or the extraction pipeline (processor.ts).
 */
import { Data } from "effect";

/** The inspection was cancelled (the turn was interrupted). The ONE video failure that PROPAGATES - it
 *  aborts the whole inspection rather than degrading a single piece of it. */
export class VideoCancelledError extends Data.TaggedError("VideoCancelledError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `Video inspection cancelled: ${this.detail}`;
  }
}

/**
 * A RECOVERABLE degradation during inspection (probe unreadable, a frame timed out, media unsupported,
 * an artifact write failed): carries a bounded, pre-formatted `reason` the processor pushes onto its
 * warnings and keeps going. ONE type, not one class per cause: the pipeline only ever branches on
 * cancelled-vs-degraded - the specific cause never changed handling, only the warning string - so a
 * `_tag` per cause modelled a distinction no caller made.
 */
export class VideoDegradedError extends Data.TaggedError("VideoDegradedError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

/** The degradation messages, kept in one home so a probe/frame/artifact failure reads consistently and
 *  never carries raw ffmpeg output - callers pass only a bounded detail. Each returns a {@link
 *  VideoDegradedError} ready to throw or `.message` into a warning. */
export const videoDegraded = {
  probe: (detail: string): VideoDegradedError =>
    new VideoDegradedError({ reason: `Video metadata probe failed: ${detail}` }),
  frameTimeout: (frameIndex: number, timeoutMs: number): VideoDegradedError =>
    new VideoDegradedError({
      reason: `Frame ${frameIndex} extraction timed out after ${timeoutMs}ms.`,
    }),
  unsupported: (detail: string): VideoDegradedError =>
    new VideoDegradedError({ reason: `Unsupported or non-video media: ${detail}` }),
  artifactWrite: (frameIndex: number, detail: string): VideoDegradedError =>
    new VideoDegradedError({ reason: `Frame ${frameIndex} could not be stored: ${detail}` }),
};

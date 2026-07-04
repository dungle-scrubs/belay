/**
 * Responsible for: the model-facing and internal shapes of a video inspection - the request,
 * one extracted frame (a blob-backed ArtifactRef plus its sampling coordinates), and the
 * structured result (metadata + frames + warnings + unavailable/truncated flags).
 *
 * Not for: extraction (processor.ts), provider continuation (continuation.ts), or the tool
 * envelope (tool.ts).
 */
import type { ArtifactRef } from "@trevor/session";

/** The single tool name, shared by the host loop, the descriptor table, and the web renderer. */
export const VIDEO_INSPECT_TOOL_NAME = "video_inspect" as const;

/** Default number of frames sampled when the caller does not specify. */
export const DEFAULT_MAX_FRAMES = 5;
/** Hard ceiling on frames regardless of the requested `maxFrames` (bounds artifacts + cost). */
export const MAX_FRAMES_CAP = 16;
/** Default gap between sampled frames when the caller does not specify. */
export const DEFAULT_SAMPLE_EVERY_MS = 1_000;

export interface VideoInspectRequest {
  readonly path: string;
  readonly maxFrames?: number;
  readonly sampleEveryMs?: number;
}

/** One sampled frame: where in the timeline it came from, its pixel size, and its stored bytes. */
export interface VideoFrame {
  readonly frameIndex: number;
  readonly timestampMs: number;
  readonly width?: number;
  readonly height?: number;
  /** The content-addressed blob the frame PNG was stored under (durable, deduped, shareable). */
  readonly artifact: ArtifactRef;
}

/** Missing ffprobe/ffmpeg: a structured degraded result, never a turn failure. */
export interface VideoUnavailableResult {
  readonly processor: "video";
  readonly path: string;
  readonly unavailable: true;
  readonly missingBinaries: readonly string[];
  readonly warnings: readonly string[];
  readonly frames: readonly never[];
}

/** A completed inspection: probed metadata (best-effort) plus the sampled frame artifacts. */
export interface VideoInspectedResult {
  readonly processor: "video";
  readonly path: string;
  readonly unavailable: false;
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly sampledFrameCount: number;
  readonly frames: readonly VideoFrame[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export type VideoInspectResult = VideoUnavailableResult | VideoInspectedResult;

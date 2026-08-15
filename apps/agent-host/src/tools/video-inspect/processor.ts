/**
 * Responsible for: ffprobe/ffmpeg discovery, best-effort metadata probing, and bounded frame
 * extraction into content-addressed blob artifacts. ffmpeg writes each frame PNG into a throwaway
 * tmpdir (an ephemeral transcode); the bytes are then stored in the blob store via the injected
 * `putFrame` and the tmp file is removed. The durable output is the ArtifactRef, never a disk path.
 *
 * Missing binaries return a structured unavailable result (never a throw); a probe failure or a
 * per-frame extraction/write failure degrades to a warning; only cancellation propagates.
 *
 * Not for: the tool envelope (tool.ts), provider continuation (continuation.ts), or blob transport
 * (@belay/session/blob). Binary paths are configurable via TREVOR_FFPROBE_PATH / TREVOR_FFMPEG_PATH.
 */
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactRef } from "@belay/session";
import { VideoCancelledError, VideoDegradedError, videoDegraded } from "./errors";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_SAMPLE_EVERY_MS,
  MAX_FRAMES_CAP,
  type VideoFrame,
  type VideoInspectRequest,
  type VideoInspectResult,
} from "./types";

const execFile = promisify(execFileCallback);

const PROBE_TIMEOUT_MS = 5_000;
const FRAME_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 2_000;

/** How a frame's PNG bytes become a durable artifact - injected so tests stay hermetic (no store). */
export type PutFrame = (bytes: Uint8Array, mimeType: string) => Promise<ArtifactRef>;

export interface VideoInspectOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly putFrame: PutFrame;
  /** Overrides for the timeouts, so a test can force a fast timeout without a real slow file. */
  readonly probeTimeoutMs?: number;
  readonly frameTimeoutMs?: number;
}

interface ProbedMetadata {
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly hasVideoStream: boolean;
}

/**
 * Inspects a local video path: discover the binaries, probe metadata, then sample a bounded set of
 * frames into blob artifacts. Returns a structured result; the only throw is VideoCancelledError.
 */
export async function inspectVideoFile(
  request: VideoInspectRequest,
  options: VideoInspectOptions,
): Promise<VideoInspectResult> {
  const env = options.env ?? process.env;
  const ffprobe = env.TREVOR_FFPROBE_PATH || "ffprobe";
  const ffmpeg = env.TREVOR_FFMPEG_PATH || "ffmpeg";

  throwIfAborted(options.signal);

  const missing: string[] = [];
  if (!(await commandAvailable(ffprobe, options.signal))) {
    missing.push("ffprobe");
  }
  if (!(await commandAvailable(ffmpeg, options.signal))) {
    missing.push("ffmpeg");
  }
  if (missing.length > 0) {
    return {
      processor: "video",
      path: request.path,
      unavailable: true,
      missingBinaries: missing,
      warnings: [`Video processor unavailable: missing ${missing.join(" and ")}.`],
      frames: [],
    };
  }

  const warnings: string[] = [];
  const metadata = await probeVideo(ffprobe, request.path, {
    signal: options.signal,
    timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
  }).catch((error: unknown): ProbedMetadata => {
    if (error instanceof VideoCancelledError) {
      throw error;
    }
    warnings.push(degradedMessage(error, videoDegraded.probe(firstLine(messageOf(error)))));
    return { hasVideoStream: false };
  });
  if (!metadata.hasVideoStream) {
    warnings.push(videoDegraded.unsupported("no video stream reported").message);
  }

  const maxFrames = boundedPositive(request.maxFrames, DEFAULT_MAX_FRAMES, MAX_FRAMES_CAP);
  const sampleEveryMs = boundedPositive(request.sampleEveryMs, DEFAULT_SAMPLE_EVERY_MS);
  const durationMs = metadata.durationMs ?? sampleEveryMs * maxFrames;
  const idealFrameCount = Math.max(1, Math.ceil(durationMs / sampleEveryMs));
  const frameCount = Math.min(maxFrames, idealFrameCount);

  const frames: VideoFrame[] = [];
  const transcodeDir = await mkdtemp(join(tmpdir(), "belay-video-"));
  try {
    for (let index = 0; index < frameCount; index += 1) {
      throwIfAborted(options.signal);
      const timestampMs = Math.min(index * sampleEveryMs, Math.max(0, durationMs - 1));
      const frame = await extractOneFrame({
        ffmpeg,
        videoPath: request.path,
        transcodeDir,
        index,
        timestampMs,
        metadata,
        putFrame: options.putFrame,
        signal: options.signal,
        frameTimeoutMs: options.frameTimeoutMs ?? FRAME_TIMEOUT_MS,
      }).catch((error: unknown) => {
        if (error instanceof VideoCancelledError) {
          throw error;
        }
        warnings.push(
          degradedMessage(
            error,
            videoDegraded.unsupported(`frame ${index}: ${firstLine(messageOf(error))}`),
          ),
        );
        return null;
      });
      if (frame) {
        frames.push(frame);
      }
    }
  } finally {
    await rm(transcodeDir, { recursive: true, force: true }).catch(() => {});
  }

  if (frames.length === 0 && frameCount > 0) {
    warnings.push(videoDegraded.unsupported("no frames could be extracted").message);
  }

  return {
    processor: "video",
    path: request.path,
    unavailable: false,
    ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
    ...(metadata.width !== undefined ? { width: metadata.width } : {}),
    ...(metadata.height !== undefined ? { height: metadata.height } : {}),
    sampledFrameCount: frames.length,
    frames,
    truncated: idealFrameCount > maxFrames,
    warnings,
  };
}

async function extractOneFrame(input: {
  readonly ffmpeg: string;
  readonly videoPath: string;
  readonly transcodeDir: string;
  readonly index: number;
  readonly timestampMs: number;
  readonly metadata: ProbedMetadata;
  readonly putFrame: PutFrame;
  readonly signal: AbortSignal | undefined;
  readonly frameTimeoutMs: number;
}): Promise<VideoFrame> {
  const transcodePath = join(input.transcodeDir, `frame-${input.index}.png`);
  try {
    await execFile(
      input.ffmpeg,
      [
        "-y",
        "-ss",
        (input.timestampMs / 1000).toFixed(3),
        "-i",
        input.videoPath,
        "-frames:v",
        "1",
        transcodePath,
      ],
      { encoding: "buffer", timeout: input.frameTimeoutMs, signal: input.signal },
    );
  } catch (error) {
    throw classifyExecError(error, input.index, input.frameTimeoutMs);
  }

  const bytes = await readFile(transcodePath).catch(() => {
    throw videoDegraded.unsupported(`frame ${input.index} produced no output`);
  });
  let artifact: ArtifactRef;
  try {
    artifact = await input.putFrame(bytes, "image/png");
  } catch (error) {
    throw videoDegraded.artifactWrite(input.index, messageOf(error));
  }
  return {
    frameIndex: input.index,
    timestampMs: input.timestampMs,
    ...(input.metadata.width !== undefined ? { width: input.metadata.width } : {}),
    ...(input.metadata.height !== undefined ? { height: input.metadata.height } : {}),
    artifact,
  };
}

async function probeVideo(
  ffprobe: string,
  path: string,
  opts: { readonly signal: AbortSignal | undefined; readonly timeoutMs: number },
): Promise<ProbedMetadata> {
  let stdout: string;
  try {
    const result = await execFile(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { encoding: "utf8", timeout: opts.timeoutMs, signal: opts.signal },
    );
    stdout = result.stdout;
  } catch (error) {
    if (isAbort(error)) {
      throw new VideoCancelledError({ detail: "probe interrupted" });
    }
    throw videoDegraded.probe(firstLine(messageOf(error)));
  }

  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw videoDegraded.probe("ffprobe returned unparseable JSON");
  }

  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "");
  return {
    ...(Number.isFinite(durationSeconds)
      ? { durationMs: Math.max(0, Math.round(durationSeconds * 1000)) }
      : {}),
    ...(typeof videoStream?.width === "number" ? { width: videoStream.width } : {}),
    ...(typeof videoStream?.height === "number" ? { height: videoStream.height } : {}),
    hasVideoStream: videoStream !== undefined,
  };
}

/** True when the command exists: an explicit path is `access`-checked, a bare name `-version`-probed. */
async function commandAvailable(
  command: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (command.includes("/")) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await execFile(command, ["-version"], {
      encoding: "utf8",
      timeout: DISCOVERY_TIMEOUT_MS,
      signal,
    });
    return true;
  } catch {
    return false;
  }
}

/** Maps a raw execFile rejection into a frame failure: a cancellation (propagates) or a degradation
 *  (timeout vs unsupported), the two outcomes the extraction loop distinguishes. */
function classifyExecError(error: unknown, index: number, timeoutMs: number): Error {
  if (isAbort(error)) {
    return new VideoCancelledError({ detail: `frame ${index} interrupted` });
  }
  if (isTimeout(error)) {
    return videoDegraded.frameTimeout(index, timeoutMs);
  }
  return videoDegraded.unsupported(firstLine(messageOf(error)));
}

/** The warning line for a caught NON-cancel failure: our own bounded degradation as-is, or an
 *  unexpected raw error folded into the `fallback` degradation (so raw stderr can never reach a warning). */
function degradedMessage(error: unknown, fallback: VideoDegradedError): string {
  return (error instanceof VideoDegradedError ? error : fallback).message;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new VideoCancelledError({ detail: "aborted before completion" });
  }
}

function isAbort(error: unknown): boolean {
  return (
    signalError(error) === "ABORT_ERR" || (error instanceof Error && error.name === "AbortError")
  );
}

function isTimeout(error: unknown): boolean {
  return signalError(error) === "ETIMEDOUT" || killedBySignal(error) === "SIGTERM";
}

function signalError(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

function killedBySignal(error: unknown): string | undefined {
  const signal = error && typeof error === "object" ? Reflect.get(error, "signal") : undefined;
  return typeof signal === "string" ? signal : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

/** First line only - keeps a multiline ffmpeg/ffprobe stderr dump out of the model-facing warning. */
function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  cap = Number.MAX_SAFE_INTEGER,
): number {
  const resolved =
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return Math.min(resolved, cap);
}

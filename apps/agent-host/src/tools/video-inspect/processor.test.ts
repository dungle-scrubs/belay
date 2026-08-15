/**
 * Video processor tests: binary discovery, metadata probing, and bounded frame extraction into
 * content-addressed blob artifacts. The blob store is injected (an in-memory fake), so the
 * synthetic-video extraction stays hermetic - it needs only ffmpeg/ffprobe on PATH (guarded so a
 * host without them skips rather than fails).
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createArtifactRuntime } from "@belay/session";
import type { PutBlobResult } from "@belay/session/blob-contract";
import { describe, expect, it } from "vitest";
import { VideoCancelledError } from "./errors";
import { inspectVideoFile, type PutFrame } from "./processor";

const execFile = promisify(execFileCallback);

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFile("ffmpeg", ["-version"], { timeout: 2_000 });
    await execFile("ffprobe", ["-version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** A hermetic, content-addressed blob store: frames are stored under their sha256, none escape. */
function memoryStore(): { readonly blobs: Map<string, Uint8Array>; readonly putFrame: PutFrame } {
  const blobs = new Map<string, Uint8Array>();
  const artifacts = createArtifactRuntime({
    blobStoreUrl: "mem://video-frames",
    put: async (_baseUrl, body, mimeType): Promise<PutBlobResult> => {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return { hash, size: bytes.byteLength, mimeType, deduped: false };
    },
  });
  const putFrame: PutFrame = (bytes, mimeType) => artifacts.createFrameArtifact(bytes, mimeType);
  return { blobs, putFrame };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

async function makeSyntheticVideo(dir: string, durationSeconds: number): Promise<string> {
  const videoPath = join(dir, "synthetic.mp4");
  await execFile(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=16x12:rate=1:duration=${durationSeconds}`,
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { timeout: 10_000 },
  );
  return videoPath;
}

describe("inspectVideoFile", () => {
  it("returns a structured unavailable result when ffmpeg or ffprobe are missing", async () => {
    const { putFrame } = memoryStore();
    const result = await inspectVideoFile(
      { path: "/tmp/missing.mov" },
      {
        putFrame,
        env: {
          TREVOR_FFMPEG_PATH: "/tmp/belay-missing-ffmpeg",
          TREVOR_FFPROBE_PATH: "/tmp/belay-missing-ffprobe",
        },
      },
    );
    expect(result).toEqual({
      processor: "video",
      path: "/tmp/missing.mov",
      unavailable: true,
      missingBinaries: ["ffprobe", "ffmpeg"],
      warnings: ["Video processor unavailable: missing ffprobe and ffmpeg."],
      frames: [],
    });
  });

  it("extracts deterministic frames into durable blob artifacts from a synthetic video", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "belay-video-test-"));
    try {
      const videoPath = await makeSyntheticVideo(dir, 3);
      const { blobs, putFrame } = memoryStore();
      const result = await inspectVideoFile(
        { path: videoPath, maxFrames: 2, sampleEveryMs: 1_000 },
        { putFrame },
      );

      expect(result).toMatchObject({
        processor: "video",
        unavailable: false,
        width: 16,
        height: 12,
        sampledFrameCount: 2,
        truncated: true,
      });
      if (result.unavailable) {
        throw new Error("expected an available result");
      }
      expect(result.frames.map((frame) => frame.frameIndex)).toEqual([0, 1]);
      expect(result.frames.map((frame) => frame.timestampMs)).toEqual([0, 1_000]);
      // Every frame is a durable, content-addressed blob whose bytes are real PNG data.
      for (const frame of result.frames) {
        expect(frame.artifact.kind).toBe("image");
        expect(frame.artifact.mimeType).toBe("image/png");
        const bytes = blobs.get(frame.artifact.hash);
        expect(bytes).toBeDefined();
        expect([...(bytes ?? []).slice(0, 4)]).toEqual(PNG_MAGIC);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps frames at maxFrames and does not flag truncation when the whole clip fits", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "belay-video-cap-"));
    try {
      const videoPath = await makeSyntheticVideo(dir, 2);
      const { putFrame } = memoryStore();
      const result = await inspectVideoFile(
        { path: videoPath, maxFrames: 10, sampleEveryMs: 1_000 },
        { putFrame },
      );
      if (result.unavailable) {
        throw new Error("expected an available result");
      }
      // A 2s clip at 1000ms sampling yields 2 frames, under the cap - no truncation.
      expect(result.sampledFrameCount).toBe(2);
      expect(result.truncated).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades to warnings without throwing when the media is not a video", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "belay-video-bad-"));
    try {
      const notVideo = join(dir, "notes.txt");
      await writeFile(notVideo, "this is definitely not a video file");
      const { putFrame } = memoryStore();
      const result = await inspectVideoFile({ path: notVideo, maxFrames: 2 }, { putFrame });
      if (result.unavailable) {
        throw new Error("a present-but-unusable file is not an unavailable-binaries result");
      }
      expect(result.sampledFrameCount).toBe(0);
      expect(result.frames).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws a typed cancellation error when the signal is already aborted", async () => {
    const { putFrame } = memoryStore();
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectVideoFile({ path: "/tmp/whatever.mp4" }, { putFrame, signal: controller.signal }),
    ).rejects.toBeInstanceOf(VideoCancelledError);
  });
});

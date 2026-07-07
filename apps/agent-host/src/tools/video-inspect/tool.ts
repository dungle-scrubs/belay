/**
 * Responsible for: the model-facing `video_inspect` tool - its parameter schema, the live
 * blob-store wiring for frame artifacts, structured observability, and serializing the structured
 * result to the JSON the model reads and the web transcript renders. A serial barrier (never
 * readOnly): it is heavyweight, on-request, and forces the post-video finalization pass.
 *
 * Not for: extraction (processor.ts) or provider continuation (continuation.ts).
 */
import { createHash } from "node:crypto";
import { debug } from "@host/transport/log";
import { type ArtifactRef, createArtifactRuntime } from "@trevor/session";
import { serviceUrl } from "@trevor/session/ports";
import { Schema } from "effect";
import { simpleTool } from "../shared";
import type { Tool } from "../types";
import { inspectVideoFile, type PutFrame } from "./processor";
import { VIDEO_INSPECT_TOOL_NAME } from "./types";

const BLOB_STORE_URL = process.env.BLOB_STORE_URL ?? serviceUrl("blob");

const Params = Schema.Struct({
  path: Schema.String.annotations({
    description: "Absolute or workspace-relative path to a LOCAL video file to inspect.",
  }),
  maxFrames: Schema.optional(
    Schema.Number.annotations({ jsonSchema: { type: "integer", minimum: 1, maximum: 16 } }),
  ).annotations({ description: "Max frames to sample (default 5, hard cap 16)." }),
  sampleEveryMs: Schema.optional(
    Schema.Number.annotations({ jsonSchema: { type: "integer", minimum: 1 } }),
  ).annotations({ description: "Milliseconds between sampled frames (default 1000)." }),
});

/** Stores one frame PNG in the content-addressed blob store and returns its ArtifactRef. */
function livePutFrame(blobStoreUrl: string): PutFrame {
  const artifacts = createArtifactRuntime({ blobStoreUrl });
  return async (bytes, mimeType) => {
    return artifacts.createFrameArtifact(bytes, mimeType);
  };
}

/** A short, non-reversible label for a path - keeps the raw path out of observability spans. */
function pathLabel(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export interface VideoInspectToolDeps {
  readonly putFrame?: PutFrame;
  readonly blobStoreUrl?: string;
}

export function buildVideoInspectTool(deps: VideoInspectToolDeps = {}): Tool<typeof Params.Type> {
  const blobStoreUrl = deps.blobStoreUrl ?? BLOB_STORE_URL;
  const putFrame = deps.putFrame ?? livePutFrame(blobStoreUrl);
  return simpleTool({
    name: VIDEO_INSPECT_TOOL_NAME,
    description:
      "Inspect a LOCAL video file by sampling a bounded set of frames (default 5, every 1000ms) " +
      "and feeding those frames back to the model as vision input. Use this to SEE what a video " +
      "contains - never shell out to ffmpeg or try to read a video file as text. Options: " +
      "'maxFrames' (1-16), 'sampleEveryMs'. Returns metadata (duration, dimensions), the sampled " +
      "frame count, per-frame timestamps + artifact references, truncation, and warnings. When " +
      "ffprobe/ffmpeg are missing it returns a structured unavailable result instead of failing.",
    params: Params,
    execute: async (args) => {
      const result = await inspectVideoFile(
        {
          path: args.path,
          ...(args.maxFrames !== undefined ? { maxFrames: args.maxFrames } : {}),
          ...(args.sampleEveryMs !== undefined ? { sampleEveryMs: args.sampleEveryMs } : {}),
        },
        { putFrame },
      );
      logInspection(args.path, result);
      return JSON.stringify(result);
    },
  });
}

function logInspection(path: string, result: Awaited<ReturnType<typeof inspectVideoFile>>): void {
  if (result.unavailable) {
    debug("video", "unavailable", {
      path: pathLabel(path),
      missing: result.missingBinaries.join(","),
    });
    return;
  }
  debug("video", "inspected", {
    path: pathLabel(path),
    durationMs: result.durationMs,
    width: result.width,
    height: result.height,
    sampled: result.sampledFrameCount,
    truncated: result.truncated,
    warnings: result.warnings.length,
  });
}

export const videoInspectTool = buildVideoInspectTool();

// Re-exported so the loop can inline frames + finalize on the same tool name the descriptor uses.
export { VIDEO_INSPECT_TOOL_NAME } from "./types";
export type { ArtifactRef };

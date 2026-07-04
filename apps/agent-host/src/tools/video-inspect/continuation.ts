/**
 * Responsible for: turning a committed video_inspect tool result into provider continuation
 * content - parsing the frame ArtifactRefs out of the result JSON, and (for a vision-capable
 * provider) resolving up to MAX_CONTINUATION_FRAMES of them to inline base64 images attached to
 * the tool message. A non-vision provider, an absent resolver, or any fetch failure degrades to
 * the text-only result (VideoContinuationError), never a turn failure.
 *
 * Not for: frame extraction (processor.ts) or the tool envelope (tool.ts). The JSON result shape
 * this parses is the same shape the web transcript renderer parses - it is the cross-surface
 * contract, so keep it stable.
 */
import type { ChatImage, ChatMessage } from "@host/providers/index";
import { type ArtifactRef, fetchBlobBytes } from "@trevor/session";
import { VideoContinuationError } from "./errors";
import type { VideoFrame } from "./types";

/** Up to this many frames ride back to the model as images (V1 parity); the rest stay as text. */
export const MAX_CONTINUATION_FRAMES = 8;

/** Frame image formats a vision provider reliably accepts (the tool only ever emits PNG today). */
const CONTINUATION_MIMES = new Set(["image/png", "image/jpeg"]);

/** Resolves frame artifact hashes to their inline base64 bytes for a vision provider. */
export type VideoFrameResolver = (refs: readonly ArtifactRef[]) => Promise<readonly ChatImage[]>;

/** Pulls the frame ArtifactRefs out of a video_inspect result JSON string (defensive - never throws). */
export function parseVideoFrameRefs(resultJson: string): readonly ArtifactRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const frames = Reflect.get(parsed, "frames");
  if (!Array.isArray(frames)) {
    return [];
  }
  const refs: ArtifactRef[] = [];
  for (const frame of frames as readonly Partial<VideoFrame>[]) {
    const artifact = frame?.artifact;
    if (isImageArtifact(artifact)) {
      refs.push(artifact);
    }
  }
  return refs;
}

function isImageArtifact(value: unknown): value is ArtifactRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "hash") === "string" &&
    typeof Reflect.get(value, "mimeType") === "string"
  );
}

/**
 * Builds a resolver that fetches each frame's bytes from the blob store and inlines them as base64.
 * Caps at MAX_CONTINUATION_FRAMES, skips unsupported MIME types, and skips any frame whose bytes are
 * unavailable - so a missing blob degrades one frame, never the whole continuation.
 */
export function createVideoFrameResolver(
  blobStoreUrl: string,
  fetchBytes: typeof fetchBlobBytes = fetchBlobBytes,
): VideoFrameResolver {
  return async (refs) => {
    const images: ChatImage[] = [];
    for (const ref of refs.slice(0, MAX_CONTINUATION_FRAMES)) {
      if (!CONTINUATION_MIMES.has(ref.mimeType.toLowerCase())) {
        continue;
      }
      try {
        const bytes = await fetchBytes(blobStoreUrl, ref.hash);
        images.push({
          hash: ref.hash,
          mimeType: ref.mimeType,
          data: Buffer.from(bytes).toString("base64"),
        });
      } catch {
        // Blob unreachable or gone: skip this frame; the model still gets the text + other frames.
      }
    }
    return images;
  };
}

/**
 * Attaches the frame artifacts to a committed video_inspect tool message: always the ArtifactRefs
 * (so the transcript/detail can reference them), plus inline base64 `images` when a vision resolver
 * is wired. Returns the message unchanged when it carries no frames; degrades to refs-only (text)
 * when resolution fails.
 */
export async function inlineVideoFrames(
  message: ChatMessage,
  resolveFrames?: VideoFrameResolver,
): Promise<ChatMessage> {
  const refs = parseVideoFrameRefs(message.content);
  if (refs.length === 0) {
    return message;
  }
  const withRefs: ChatMessage = { ...message, artifacts: refs };
  if (!resolveFrames) {
    return withRefs;
  }
  try {
    const images = await resolveFrames(refs);
    return images.length > 0 ? { ...withRefs, images } : withRefs;
  } catch (error) {
    // A catastrophic resolver failure is a typed continuation error we swallow: the model still
    // reads the serialized result text and the transcript still shows the frame thumbnails.
    void new VideoContinuationError({ detail: String(error) });
    return withRefs;
  }
}

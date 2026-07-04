import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { ToolRenderer } from "./tool-message";
import { parseVideoInspectResult, videoFrameArtifacts } from "./video-inspect";

/**
 * video_inspect transcript rendering (plan 39 M9): the arm shows the sampled-frame thumbnails plus
 * metadata (duration, dimensions, count, truncation) and warnings, degrades to an unavailable note
 * when the media tools are missing, and surfaces the `error:` convention.
 */

const toolMsg = (over: Partial<ToolMessageData>): ToolMessageData => ({
  kind: "tool",
  id: "v1",
  name: "video_inspect",
  args: JSON.stringify({ path: "/tmp/clip.mp4" }),
  done: true,
  ...over,
});

const noop = () => {};

function frame(index: number, timestampMs: number) {
  return {
    frameIndex: index,
    timestampMs,
    width: 16,
    height: 12,
    artifact: { kind: "image", mimeType: "image/png", size: 100, hash: `frame-${index}` },
  };
}

function successResult(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    processor: "video",
    path: "/tmp/clip.mp4",
    unavailable: false,
    durationMs: 3_000,
    width: 16,
    height: 12,
    sampledFrameCount: 2,
    truncated: true,
    warnings: [],
    frames: [frame(0, 0), frame(1, 1_000)],
    ...over,
  });
}

test("renders a frame thumbnail per sampled frame with metadata", () => {
  const { container } = render(
    <ToolRenderer message={toolMsg({ result: successResult() })} onOpenPath={noop} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("video_inspect"), "the tool name renders");
  assert.ok(text.includes("2 frames"), "the sampled frame count renders");
  assert.ok(text.includes("16×12"), "the dimensions render");
  assert.ok(text.includes("truncated"), "the truncation flag renders");
  assert.equal(container.querySelectorAll("img").length, 2, "one thumbnail per frame renders");
});

test("renders the unavailable note when ffprobe/ffmpeg are missing", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        result: JSON.stringify({
          processor: "video",
          path: "/tmp/clip.mp4",
          unavailable: true,
          missingBinaries: ["ffprobe", "ffmpeg"],
          warnings: ["Video processor unavailable: missing ffprobe and ffmpeg."],
          frames: [],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("unavailable"), "the unavailable state renders");
  assert.ok(text.includes("ffprobe"), "the missing binaries render");
  assert.equal(
    container.querySelectorAll("img").length,
    0,
    "no thumbnails render when unavailable",
  );
});

test("surfaces extraction warnings", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        result: successResult({
          frames: [],
          sampledFrameCount: 0,
          warnings: ["Unsupported or non-video media: no frames could be extracted"],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("no frames could be extracted"),
    "the extraction warning renders",
  );
});

test("surfaces the error: convention as a failure row", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ result: "error: video_inspect failed - cancelled" })}
      onOpenPath={noop}
    />,
  );
  assert.ok((container.textContent ?? "").includes("cancelled"), "the failure detail renders");
});

test("parseVideoInspectResult returns null while running and structures a completed result", () => {
  assert.equal(parseVideoInspectResult(undefined), null, "no result yet -> null");
  const parsed = parseVideoInspectResult(successResult());
  assert.equal(parsed?.sampledFrameCount, 2);
  assert.equal(parsed?.truncated, true);
  assert.equal(
    videoFrameArtifacts(parsed?.frames ?? []).length,
    2,
    "each frame yields one artifact",
  );
});

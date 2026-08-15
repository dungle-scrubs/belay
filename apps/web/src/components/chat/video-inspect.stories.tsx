import type { ArtifactRef } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { type ParsedVideoInspect, VideoInspectResult } from "./video-inspect";

/**
 * video_inspect transcript row (plan 39 M9): the sampled-frame thumbnails plus metadata (duration,
 * dimensions, count, truncation) and warnings, the unavailable note when the media tools are
 * missing, the running shimmer, and the error row. Frame previews come from an injected `srcOf`, so
 * the stories never hit a blob store.
 */

const meta: Meta<typeof VideoInspectResult> = {
  title: "Chat/VideoInspect",
  component: VideoInspectResult,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof VideoInspectResult>;

const Frame = storyFrame("w-[40rem]");

function frameRef(index: number): ArtifactRef {
  return { kind: "image", mimeType: "image/png", size: 12_000, hash: `frame-${index}` };
}

function frame(index: number, timestampMs: number) {
  return { frameIndex: index, timestampMs, width: 160, height: 120, artifact: frameRef(index) };
}

const FILLS = ["#5e81ac", "#a3be8c", "#b48ead", "#bf616a", "#88c0d0", "#d08770"];

/** Distinct-colored 160x120 SVG previews keyed by frame hash - a stand-in for real frame PNGs. */
function srcOf(hash: string): string {
  const index = Number.parseInt(hash.replace("frame-", ""), 10) || 0;
  const fill = FILLS[index % FILLS.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'><rect width='100%' height='100%' fill='${fill}'/><text x='8' y='24' fill='white' font-family='monospace' font-size='16'>${index}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function parsed(over: Partial<ParsedVideoInspect> = {}): ParsedVideoInspect {
  return {
    unavailable: false,
    path: "/tmp/clip.mp4",
    durationMs: 3_000,
    width: 160,
    height: 120,
    sampledFrameCount: 3,
    truncated: false,
    warnings: [],
    frames: [frame(0, 0), frame(1, 1_000), frame(2, 2_000)],
    ...over,
  };
}

const render = (p: ParsedVideoInspect, args = "/tmp/clip.mp4") => (
  <Frame>
    <VideoInspectResult args={args} parsed={p} srcOf={srcOf} />
  </Frame>
);

export const Success: Story = { render: () => render(parsed()) };

export const SingleFrame: Story = {
  render: () => render(parsed({ sampledFrameCount: 1, frames: [frame(0, 0)], durationMs: 900 })),
};

export const Truncated: Story = {
  render: () =>
    render(
      parsed({
        durationMs: 60_000,
        sampledFrameCount: 5,
        truncated: true,
        frames: [frame(0, 0), frame(1, 1_000), frame(2, 2_000), frame(3, 3_000), frame(4, 4_000)],
      }),
    ),
};

export const WithWarning: Story = {
  render: () =>
    render(
      parsed({
        warnings: ["Frame 2 extraction timed out after 10000ms."],
        sampledFrameCount: 2,
        frames: [frame(0, 0), frame(1, 1_000)],
      }),
    ),
};

export const Unavailable: Story = {
  render: () =>
    render(
      {
        unavailable: true,
        path: "/tmp/clip.mp4",
        missingBinaries: ["ffprobe", "ffmpeg"],
        warnings: ["Video processor unavailable: missing ffprobe and ffmpeg."],
        frames: [],
      },
      "/tmp/clip.mp4",
    ),
};

export const ErrorResult: Story = {
  render: () => render({ error: "video_inspect failed - cancelled" }),
};

export const Running: Story = {
  render: () => (
    <Frame>
      <VideoInspectResult args="/tmp/clip.mp4" parsed={null} status="running" />
    </Frame>
  ),
};

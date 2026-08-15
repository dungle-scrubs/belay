/**
 * Agent-loop video_inspect finalization (plan 39 M7/M8). Drives runAgent with a fake provider that
 * calls video_inspect, then asserts: the post-video pass is offered NO tools and answers directly;
 * a stray follow-up tool call on that pass is suppressed with no visible churn; and the committed
 * tool message carries the frame images when a vision frame resolver is wired.
 *
 * The ffmpeg extraction itself is covered by tools/video-inspect/processor.test.ts - here the tool
 * result is injected through the runTool seam, so the loop behavior is hermetic.
 */
import type { ArtifactRef } from "@belay/session";
import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../providers";
import { type AgentEvent, type RunAgentOptions, runAgent } from "./loop";

const usage = { input: 100, output: 1, contextWindow: 1_000_000, genMs: 1 };

const FRAME_REF: ArtifactRef = {
  kind: "image",
  mimeType: "image/png",
  size: 42,
  hash: "frame-hash-0",
};

const VIDEO_RESULT = JSON.stringify({
  processor: "video",
  path: "/tmp/example.mp4",
  unavailable: false,
  durationMs: 1_000,
  width: 16,
  height: 12,
  sampledFrameCount: 1,
  truncated: false,
  warnings: [],
  frames: [{ frameIndex: 0, timestampMs: 0, width: 16, height: 12, artifact: FRAME_REF }],
});

interface Streamed {
  readonly toolsPerStream: number[];
  readonly messagesPerStream: (readonly ChatMessage[])[];
}

/** A provider that calls video_inspect first, then (once tool results exist) does `follow`. */
function videoProvider(track: Streamed, follow: () => readonly ProviderEvent[]): Provider {
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: ["off"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: true, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (messages, tools) => {
      track.toolsPerStream.push(tools.length);
      track.messagesPerStream.push(messages);
      if (!messages.some((message) => message.role === "tool")) {
        return Stream.fromIterable<ProviderEvent>([
          {
            type: "tool_call",
            call: {
              id: "tool_video_once",
              name: "video_inspect",
              arguments: JSON.stringify({ path: "/tmp/example.mp4", maxFrames: 1 }),
            },
          },
          { type: "usage", usage },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([...follow(), { type: "usage", usage }]);
    },
  };
}

const collect = (provider: Provider, opts: RunAgentOptions): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  return Effect.runPromise(
    Stream.runForEach(
      runAgent(
        provider,
        [{ role: "user", content: "describe this video" }],
        "off",
        "r1",
        true,
        opts,
      ),
      (event) => Effect.sync(() => void events.push(event)),
    ),
  ).then(() => events);
};

const finalText = (events: readonly AgentEvent[]): string =>
  events
    .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("");

/** Records each executed tool name and returns the injected video result for video_inspect. */
function recordingRunTool(executed: string[]): NonNullable<RunAgentOptions["runTool"]> {
  return (name) => {
    executed.push(name);
    return Effect.succeed(name === "video_inspect" ? VIDEO_RESULT : `error: unexpected ${name}`);
  };
}

test("forces a direct answer with no tools offered after video_inspect", async () => {
  const track: Streamed = { toolsPerStream: [], messagesPerStream: [] };
  const executed: string[] = [];
  const events = await collect(
    videoProvider(track, () => [{ type: "text", text: "A cat walks by." }]),
    {
      runTool: recordingRunTool(executed),
      resolveFrames: async (refs) =>
        refs.map((ref) => ({ hash: ref.hash, mimeType: ref.mimeType, data: "ZmFrZQ==" })),
    },
  );

  expect(finalText(events)).toBe("A cat walks by.");
  expect(executed).toEqual(["video_inspect"]);
  // First step is offered the real tool set; the post-video finalization step is offered none.
  expect(track.toolsPerStream[0]).toBeGreaterThan(0);
  expect(track.toolsPerStream[1]).toBe(0);
});

test("attaches frame images to the committed video_inspect tool message for the finalization pass", async () => {
  const track: Streamed = { toolsPerStream: [], messagesPerStream: [] };
  await collect(
    videoProvider(track, () => [{ type: "text", text: "done" }]),
    {
      runTool: recordingRunTool([]),
      resolveFrames: async (refs) =>
        refs.map((ref) => ({ hash: ref.hash, mimeType: ref.mimeType, data: "ZmFrZQ==" })),
    },
  );

  const finalizePass = track.messagesPerStream[1] ?? [];
  const toolMessage = finalizePass.find(
    (message) => message.role === "tool" && message.name === "video_inspect",
  );
  expect(toolMessage?.artifacts?.map((ref) => ref.hash)).toEqual(["frame-hash-0"]);
  expect(toolMessage?.images?.map((image) => image.hash)).toEqual(["frame-hash-0"]);
});

test("suppresses a stray follow-up tool call after video_inspect without visible churn", async () => {
  const track: Streamed = { toolsPerStream: [], messagesPerStream: [] };
  const executed: string[] = [];
  const events = await collect(
    videoProvider(track, () => [
      {
        type: "tool_call",
        call: {
          id: "read_after_video",
          name: "read",
          arguments: JSON.stringify({ path: "/tmp/frame.png" }),
        },
      },
      { type: "text", text: "Final answer from frames." },
    ]),
    { runTool: recordingRunTool(executed) },
  );

  expect(finalText(events)).toBe("Final answer from frames.");
  // The read was suppressed on the finalization pass: never executed, never surfaced as an event.
  expect(executed).toEqual(["video_inspect"]);
  const readEvents = events.filter((event) => "call" in event && event.call.name === "read");
  expect(readEvents).toEqual([]);
});

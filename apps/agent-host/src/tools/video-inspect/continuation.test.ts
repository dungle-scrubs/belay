/**
 * Provider continuation tests: parsing frame refs out of a video_inspect result, resolving them to
 * inline base64 images (capped, MIME-filtered, fetch-failure tolerant), and attaching them to a tool
 * message - degrading to refs-only text when no resolver is wired or resolution fails.
 */
import type { ChatMessage } from "@host/providers/index";
import type { ArtifactRef } from "@trevor/session";
import { describe, expect, it } from "vitest";
import {
  createVideoFrameResolver,
  inlineVideoFrames,
  MAX_CONTINUATION_FRAMES,
  parseVideoFrameRefs,
} from "./continuation";

function frameRef(index: number, mimeType = "image/png"): ArtifactRef {
  return { kind: "image", mimeType, size: 10, hash: `hash-${index}` };
}

function resultJson(frames: readonly { readonly artifact: ArtifactRef }[]): string {
  return JSON.stringify({ processor: "video", unavailable: false, frames });
}

function toolMessage(content: string): ChatMessage {
  return { role: "tool", content, toolCallId: "call_1", name: "video_inspect" };
}

describe("parseVideoFrameRefs", () => {
  it("extracts image artifact refs from a video_inspect result", () => {
    const refs = parseVideoFrameRefs(
      resultJson([{ artifact: frameRef(0) }, { artifact: frameRef(1) }]),
    );
    expect(refs.map((ref) => ref.hash)).toEqual(["hash-0", "hash-1"]);
  });

  it("returns an empty list for malformed JSON or a frameless result", () => {
    expect(parseVideoFrameRefs("not json")).toEqual([]);
    expect(parseVideoFrameRefs(JSON.stringify({ processor: "video", frames: "nope" }))).toEqual([]);
    expect(parseVideoFrameRefs(JSON.stringify({ unavailable: true }))).toEqual([]);
  });
});

describe("createVideoFrameResolver", () => {
  it("resolves frame refs to inline base64 images", async () => {
    const resolve = createVideoFrameResolver("http://blob", async (_base, hash) =>
      new TextEncoder().encode(`bytes:${hash}`),
    );
    const images = await resolve([frameRef(0), frameRef(1)]);
    expect(images).toEqual([
      {
        hash: "hash-0",
        mimeType: "image/png",
        data: Buffer.from("bytes:hash-0").toString("base64"),
      },
      {
        hash: "hash-1",
        mimeType: "image/png",
        data: Buffer.from("bytes:hash-1").toString("base64"),
      },
    ]);
  });

  it("caps the number of attached frames", async () => {
    const many = Array.from({ length: MAX_CONTINUATION_FRAMES + 4 }, (_, i) => frameRef(i));
    const resolve = createVideoFrameResolver("http://blob", async () => new Uint8Array([1]));
    const images = await resolve(many);
    expect(images).toHaveLength(MAX_CONTINUATION_FRAMES);
  });

  it("skips unsupported MIME types and frames whose bytes are unavailable", async () => {
    const resolve = createVideoFrameResolver("http://blob", async (_base, hash) => {
      if (hash === "hash-1") {
        throw new Error("blob gone");
      }
      return new Uint8Array([1, 2, 3]);
    });
    const images = await resolve([frameRef(0), frameRef(1), frameRef(2, "image/tiff")]);
    // hash-1 fetch failed, hash-2 is an unsupported MIME - only hash-0 survives.
    expect(images.map((image) => image.hash)).toEqual(["hash-0"]);
  });
});

describe("inlineVideoFrames", () => {
  it("attaches refs plus inline images when a resolver is wired", async () => {
    const message = toolMessage(resultJson([{ artifact: frameRef(0) }]));
    const resolve = createVideoFrameResolver("http://blob", async () => new Uint8Array([9]));
    const inlined = await inlineVideoFrames(message, resolve);
    expect(inlined.artifacts?.map((ref) => ref.hash)).toEqual(["hash-0"]);
    expect(inlined.images?.map((image) => image.hash)).toEqual(["hash-0"]);
  });

  it("attaches refs only (text-only) when no resolver is wired", async () => {
    const message = toolMessage(resultJson([{ artifact: frameRef(0) }]));
    const inlined = await inlineVideoFrames(message);
    expect(inlined.artifacts?.map((ref) => ref.hash)).toEqual(["hash-0"]);
    expect(inlined.images).toBeUndefined();
  });

  it("degrades to refs-only when the resolver throws", async () => {
    const message = toolMessage(resultJson([{ artifact: frameRef(0) }]));
    const inlined = await inlineVideoFrames(message, async () => {
      throw new Error("resolver blew up");
    });
    expect(inlined.artifacts?.map((ref) => ref.hash)).toEqual(["hash-0"]);
    expect(inlined.images).toBeUndefined();
  });

  it("returns the message unchanged when it carries no frames", async () => {
    const message = toolMessage(JSON.stringify({ processor: "video", unavailable: true }));
    const inlined = await inlineVideoFrames(message, async () => []);
    expect(inlined).toBe(message);
  });
});

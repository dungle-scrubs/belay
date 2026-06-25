import assert from "node:assert/strict";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import { combineSteer, foldSteer, type QueuedPrompt, sendQueueReducer } from "./send-queue";

/**
 * Characterization tests for the web send-queue / steering machine (M7 / D-007).
 *
 * These pin the queue transitions and the hard-steer fold that were inline in App.tsx
 * (a 1025-line component), BEFORE they are extracted, so the send/steer UX is unchanged:
 *   - a prompt submitted while busy is enqueued (FIFO); the head drains when idle
 *   - a hard steer (ESC) folds the queued prompts + draft into ONE prompt and the
 *     queued + attached artifacts into one list, replacing the queue
 */

const prompt = (id: string, text: string, artifacts?: readonly ArtifactRef[]): QueuedPrompt => ({
  id,
  text,
  provider: "qwen",
  ...(artifacts ? { artifacts } : {}),
});

const art = (hash: string, size: number): ArtifactRef => ({
  kind: "file",
  mimeType: "text/plain",
  size,
  hash: hash.repeat(64),
});

test("combineSteer folds queued texts in order then the draft, dropping empties", () => {
  assert.equal(combineSteer([prompt("1", "a"), prompt("2", "b")], "draft"), "a\n\nb\n\ndraft");
  assert.equal(combineSteer([], "  only draft  "), "only draft");
  assert.equal(combineSteer([prompt("1", "a")], ""), "a");
  assert.equal(combineSteer([], ""), "");
});

test("enqueue appends to the tail; drainHead removes the head (FIFO)", () => {
  let queue: readonly QueuedPrompt[] = [];
  queue = sendQueueReducer(queue, { type: "enqueue", prompt: prompt("1", "a") });
  queue = sendQueueReducer(queue, { type: "enqueue", prompt: prompt("2", "b") });
  assert.deepEqual(
    queue.map((q) => q.text),
    ["a", "b"],
  );
  queue = sendQueueReducer(queue, { type: "drainHead" });
  assert.deepEqual(
    queue.map((q) => q.text),
    ["b"],
  );
});

test("steer replaces the whole queue with the single folded prompt, or empties it", () => {
  const queue = [prompt("1", "a"), prompt("2", "b")];
  const steered = sendQueueReducer(queue, { type: "steer", prompt: prompt("s", "folded") });
  assert.deepEqual(
    steered.map((q) => q.text),
    ["folded"],
  );
  assert.deepEqual(sendQueueReducer(queue, { type: "steer", prompt: null }), []);
});

test("foldSteer folds queued prompts + draft + artifacts into one steering prompt", () => {
  const a1 = art("a", 1);
  const a2 = art("b", 2);
  const steer = foldSteer([prompt("1", "first", [a1])], "draft now", [a2], {
    id: "s",
    provider: "gpt",
    reasoning: "high",
  });
  assert.ok(steer);
  assert.equal(steer.text, "first\n\ndraft now");
  assert.equal(steer.provider, "gpt");
  assert.equal(steer.reasoning, "high");
  assert.deepEqual(steer.artifacts, [a1, a2]);
});

test("foldSteer returns null when there is no text and no artifacts", () => {
  assert.equal(foldSteer([], "   ", [], { id: "s", provider: "qwen" }), null);
});

test("foldSteer keeps artifacts even when the folded text is empty", () => {
  const a = art("c", 1);
  const steer = foldSteer([], "", [a], { id: "s", provider: "qwen" });
  assert.ok(steer);
  assert.equal(steer.text, "");
  assert.deepEqual(steer.artifacts, [a]);
});

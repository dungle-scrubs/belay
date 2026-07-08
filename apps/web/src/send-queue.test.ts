import assert from "node:assert/strict";
import {
  type ArtifactRef,
  controlProducerId,
  events,
  type PastePayload,
  PRODUCER_IDS,
  pendingFollowUps,
  type SessionEvent,
  type TrevorEventInput,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import {
  combineQueued,
  combineSteer,
  foldQueuedSteer,
  foldSteer,
  type QueuedPrompt,
  queuedPromptsFrom,
  sendQueueReducer,
} from "./send-queue";
import { toTranscript } from "./transcript";

/**
 * Characterization tests for the web send-queue / steering machine (M7 / D-007).
 *
 * These pin the queue transitions and the hard-steer fold that were inline in app.tsx
 * (a 1025-line component), BEFORE they are extracted, so the send/steer UX is unchanged:
 *   - a prompt submitted while busy is enqueued (FIFO); the head drains when idle
 *   - a hard steer (ESC) folds the queued prompts + draft into ONE prompt and the
 *     queued + attached artifacts into one list, replacing the queue
 */

const prompt = (
  id: string,
  text: string,
  artifacts?: readonly ArtifactRef[],
  pastes?: readonly PastePayload[],
): QueuedPrompt => ({
  id,
  text,
  provider: "qwen",
  ...(artifacts ? { artifacts } : {}),
  ...(pastes ? { pastes } : {}),
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
  const steer = foldSteer([prompt("1", "first", [a1])], "draft now", [a2], [], {
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

test("foldSteer stamps the steer meta's ModelRef onto the folded prompt (D-065)", () => {
  const model = { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" };
  const steer = foldSteer([prompt("1", "first")], "go", [], [], {
    id: "s",
    provider: "deepseek",
    reasoning: "high",
    model,
  });
  assert.ok(steer);
  assert.deepEqual(steer.model, model, "the active selection rides the steered prompt");
});

test("foldSteer returns null when there is no text and no artifacts", () => {
  assert.equal(foldSteer([], "   ", [], [], { id: "s", provider: "qwen" }), null);
});

test("foldSteer keeps artifacts even when the folded text is empty", () => {
  const a = art("c", 1);
  const steer = foldSteer([], "", [a], [], { id: "s", provider: "qwen" });
  assert.ok(steer);
  assert.equal(steer.text, "");
  assert.deepEqual(steer.artifacts, [a]);
});

test("foldSteer gathers queued + draft pasted payloads in folded reading order", () => {
  const qp: PastePayload = { text: "queued\npayload" };
  const dp: PastePayload = { text: "draft\npayload" };
  const steer = foldSteer(
    [prompt("1", "first [Pasted text #1 +2 lines]", undefined, [qp])],
    "then [Pasted text #1 +2 lines]",
    [],
    [dp],
    { id: "s", provider: "qwen" },
  );
  assert.ok(steer);
  assert.deepEqual(
    steer.pastes,
    [qp, dp],
    "queued payloads precede the draft's, matching the folded token order",
  );
});

// --- queue-only fold for the first-Escape steer (D-001/D-003) ---

test("combineQueued folds queued texts one trimmed line per prompt, no draft, no blank gaps", () => {
  assert.equal(combineQueued([prompt("1", "first"), prompt("2", "second")]), "first\nsecond");
  // empty / whitespace-only queued prompts are dropped without leaving blank lines
  assert.equal(
    combineQueued([prompt("1", "first"), prompt("2", "   "), prompt("3", "third")]),
    "first\nthird",
  );
  assert.equal(combineQueued([prompt("1", "  spaced  ")]), "spaced");
  assert.equal(combineQueued([]), "");
});

test("foldQueuedSteer folds the queue (one line each) and gathers queued artifacts, ignoring the draft", () => {
  const a1 = art("a", 1);
  const a2 = art("b", 2);
  const folded = foldQueuedSteer([prompt("1", "first", [a1]), prompt("2", "second", [a2])], {
    id: "s",
    provider: "gpt",
    reasoning: "high",
  });
  assert.ok(folded);
  assert.equal(folded.text, "first\nsecond", "one line per queued prompt, no draft mixed in");
  assert.equal(folded.provider, "gpt");
  assert.equal(folded.reasoning, "high");
  assert.deepEqual(folded.artifacts, [a1, a2], "queued artifacts are preserved in order");
});

test("foldQueuedSteer stamps the steer meta's ModelRef onto the folded prompt (D-065)", () => {
  const model = { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" };
  const folded = foldQueuedSteer([prompt("1", "first")], {
    id: "s",
    provider: "deepseek",
    reasoning: "high",
    model,
  });
  assert.ok(folded);
  assert.deepEqual(folded.model, model);
});

test("foldQueuedSteer returns null for an empty or whitespace-only queue with no artifacts", () => {
  assert.equal(foldQueuedSteer([], { id: "s", provider: "qwen" }), null);
  assert.equal(foldQueuedSteer([prompt("1", "   ")], { id: "s", provider: "qwen" }), null);
});

test("foldQueuedSteer keeps queued artifacts even when every queued text is empty", () => {
  const a = art("c", 1);
  const folded = foldQueuedSteer([prompt("1", "   ", [a])], { id: "s", provider: "qwen" });
  assert.ok(folded);
  assert.equal(folded.text, "");
  assert.deepEqual(folded.artifacts, [a]);
});

test("foldQueuedSteer gathers queued pasted payloads in queue order, ignoring the draft", () => {
  const p1: PastePayload = { text: "first\npayload" };
  const p2: PastePayload = { text: "second\npayload" };
  const folded = foldQueuedSteer(
    [
      prompt("1", "a [Pasted text #1 +2 lines]", undefined, [p1]),
      prompt("2", "b [Pasted text #1 +2 lines]", undefined, [p2]),
    ],
    { id: "s", provider: "qwen" },
  );
  assert.ok(folded);
  assert.deepEqual(folded.pastes, [p1, p2], "queued payloads gather in queue order");
});

test("a queued prompt round-trips its pasted payloads through the reducer (survives the wait)", () => {
  const payload: PastePayload = { text: "x".repeat(2000) };
  const queued = prompt("1", "go [Pasted text #1 +1 lines]", undefined, [payload]);
  let queue: readonly QueuedPrompt[] = [];
  queue = sendQueueReducer(queue, { type: "enqueue", prompt: queued });
  assert.deepEqual(queue[0]?.pastes, [payload], "the payload metadata waits with the prompt");
});

/** A durable log event with a stable eventId (the id a supersede references), web-authored by default. */
let queueSeq = 0;
const logEv = (input: TrevorEventInput, eventId = `ev-${queueSeq}`): SessionEvent =>
  storedEvent(input, { seq: queueSeq++, eventId, producerId: PRODUCER_IDS.web });

test("queuedPromptsFrom projects the durable follow-up queue, id = the durable eventId", () => {
  const log = [
    logEv(events.userMessage({ text: "active", provider: "qwen" }), "ev-active"),
    storedEvent(
      { type: "assistant.started", payload: { runId: "r1" } },
      { seq: queueSeq++, producerId: PRODUCER_IDS.host },
    ),
    logEv(events.userMessage({ text: "two", provider: "deepseek", reasoning: "high" }), "ev-2"),
    logEv(events.userMessage({ text: "three", provider: "qwen" }), "ev-3"),
  ];
  const queue = queuedPromptsFrom(log, PRODUCER_IDS.host);
  assert.deepEqual(
    queue.map((q) => ({ id: q.id, text: q.text, provider: q.provider })),
    [
      { id: "ev-2", text: "two", provider: "deepseek" },
      { id: "ev-3", text: "three", provider: "qwen" },
    ],
  );
  assert.equal(queue[0]?.reasoning, "high", "the queued prompt keeps its snapshot reasoning");
});

test("queuedPromptsFrom excludes a superseded prompt (folded/unqueued)", () => {
  const log = [
    logEv(events.userMessage({ text: "active", provider: "qwen" }), "ev-active"),
    storedEvent(
      { type: "assistant.started", payload: { runId: "r1" } },
      { seq: queueSeq++, producerId: PRODUCER_IDS.host },
    ),
    logEv(events.userMessage({ text: "keep", provider: "qwen" }), "ev-keep"),
    logEv(events.userMessage({ text: "drop", provider: "qwen" }), "ev-drop"),
    logEv(events.userSupersede({ supersedes: ["ev-drop"], reason: "unqueue" })),
  ];
  assert.deepEqual(
    queuedPromptsFrom(log, PRODUCER_IDS.host).map((q) => q.text),
    ["keep"],
  );
});

test("queuedPromptsFrom hides the initial handoff target prompt without hiding it from transcript or scheduler", () => {
  const log = [
    storedEvent(
      events.handoffAccepted({ handoffId: "h1", targetSessionId: "target", prompt: "go" }),
      {
        seq: queueSeq++,
        producerId: PRODUCER_IDS.host,
      },
    ),
    storedEvent(events.userMessage({ text: "go", provider: "qwen" }), {
      seq: queueSeq++,
      eventId: "handoff-prompt",
      producerId: controlProducerId(PRODUCER_IDS.host),
    }),
  ];

  assert.deepEqual(
    pendingFollowUps(log, PRODUCER_IDS.host).map((event) => event.eventId),
    ["handoff-prompt"],
    "the host scheduler still sees and can claim the target handoff prompt",
  );
  assert.deepEqual(
    queuedPromptsFrom(log, PRODUCER_IDS.host).map((q) => q.text),
    [],
    "the browser queue panel must not duplicate the target session's first transcript row",
  );
  assert.deepEqual(
    toTranscript(log, { selfProducerId: PRODUCER_IDS.host }).map((message) => ({
      kind: message.kind,
      text: message.kind === "user" ? message.text : null,
    })),
    [{ kind: "user", text: "go" }],
    "the prompt remains visible as the target transcript's first user message",
  );
});

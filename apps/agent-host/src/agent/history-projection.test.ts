import assert from "node:assert/strict";
import { events, type SessionEvent, type TrevorEventInput } from "@trevor/session";
import { test } from "vitest";
import type { ChatMessage } from "../providers";
import { buildHistory } from "./history-projection";

/**
 * Characterization tests for the host history projection (M1 / D-001).
 *
 * These pin the EXACT `ChatMessage[]` the current `main.ts` mutation path
 * produces from a session event log, BEFORE the projection is extracted, so the
 * extraction is proven behavior-preserving. The current behavior is the imperative
 * fold scattered across main.ts:
 *   - user.message (not self-authored)  -> push {role:"user", content[, artifacts]},
 *     collapsing onto a preceding user turn (alternation)
 *   - assistant.completed, non-blank    -> push {role:"assistant", content}
 *   - assistant.completed, blank        -> dropped (the empty-reply poison)
 *   - user.command "/clear" (not self)  -> reset the projection to empty
 *   - everything else (started, delta, thinking, tool/host events) -> ignored
 *
 * The host's own producerId is excluded for user.message / user.command (main.ts
 * gates both on `producerId !== PRODUCER_ID`); assistant.completed is folded
 * regardless of producer.
 */

const SELF = "trevor-host";
const WEB = "trevor-web";

let seq = 0;
/** Wraps an `events.*` constructor output in a durable-log envelope for the fold. */
function ev(input: TrevorEventInput, producerId = WEB): SessionEvent {
  const n = seq++;
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    eventId: `e${n}`,
    payload: input.payload,
    producerId,
    seq: n,
    sessionId: "test",
    type: input.type,
  };
}

const project = (log: SessionEvent[]): ChatMessage[] => buildHistory(log, { selfProducerId: SELF });

test("folds a full turn log into strictly paired user/assistant messages", () => {
  const log = [
    ev(events.userMessage({ text: "hi", provider: "qwen" })),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), SELF),
    ev(events.assistantDelta({ runId: "r1", text: "hel" }), SELF),
    ev(events.assistantCompleted({ runId: "r1", text: "hello" }), SELF),
    ev(events.userMessage({ text: "bye", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r2", text: "goodbye" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "bye" },
    { role: "assistant", content: "goodbye" },
  ]);
});

test("drops a blank assistant completion, then collapses the orphaned user turns", () => {
  // "hey" went unanswered (blank reply dropped), leaving two adjacent user turns,
  // which collapse to the latest - exactly the existing sanitizeHistory contract.
  const log = [
    ev(events.userMessage({ text: "hey", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "\n\n\n\n" }), SELF),
    ev(events.userMessage({ text: "audit this codebase", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "audit this codebase" }]);
});

test("collapses a run of consecutive user turns to the latest (abandoned turn)", () => {
  const log = [
    ev(events.userMessage({ text: "a", provider: "qwen" })),
    ev(events.userMessage({ text: "b", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "b" }]);
});

test("drops a leading assistant completion so the prompt opens on a user turn", () => {
  // A completion arriving before any user message (e.g. a /clear that landed
  // mid-answer) must not lead the prompt - the model sees only the later turn.
  // This is the unique defense folded in from the old sanitizeHistory pass.
  const log = [
    ev(events.assistantCompleted({ runId: "r0", text: "stray reply" }), SELF),
    ev(events.userMessage({ text: "hi", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "hello" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("/clear resets the projection mid-stream", () => {
  const log = [
    ev(events.userMessage({ text: "first", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "reply" }), SELF),
    ev(events.userCommand({ command: "/clear", args: "" })),
    ev(events.userMessage({ text: "after clear", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "after clear" }]);
});

test("/clear with nothing after it yields an empty projection", () => {
  const log = [
    ev(events.userMessage({ text: "first", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "reply" }), SELF),
    ev(events.userCommand({ command: "/clear", args: "" })),
  ];
  assert.deepEqual(project(log), []);
});

test("ignores tool round-trips, host chatter, and self-authored user echoes", () => {
  const log = [
    ev(events.userMessage({ text: "read it", provider: "qwen" })),
    // A self-authored user.message is the host's own echo - never folded.
    ev(events.userMessage({ text: "echo", provider: "qwen" }), SELF),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), SELF),
    ev(events.assistantThinking({ runId: "r1", text: "hmm" }), SELF),
    ev(events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: "{}" }), SELF),
    ev(events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "body" }), SELF),
    ev(events.hostBeat({ instanceId: "abc" }), SELF),
    ev(events.assistantCompleted({ runId: "r1", text: "the file says hi" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "read it" },
    { role: "assistant", content: "the file says hi" },
  ]);
});

test("a self-authored /clear is ignored (does not reset)", () => {
  const log = [
    ev(events.userMessage({ text: "keep me", provider: "qwen" })),
    ev(events.userCommand({ command: "/clear", args: "" }), SELF),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "keep me" }]);
});

test("maps artifacts onto the user turn, omitting the key when there are none", () => {
  const artifact = {
    kind: "file" as const,
    mimeType: "text/plain",
    size: 10,
    hash: "a".repeat(64),
    name: "notes.txt",
  };
  const log = [
    ev(events.userMessage({ text: "with file", provider: "qwen", artifacts: [artifact] })),
    ev(events.assistantCompleted({ runId: "r1", text: "ok" }), SELF),
    ev(events.userMessage({ text: "no file", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "with file", artifacts: [artifact] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "no file" },
  ]);
});

import assert from "node:assert/strict";
import { controlProducerId, type ModelRef, events as sessionEvents } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import { buildControlTurns, controlPromptModel, controlPromptProvider } from "./control-model";

const glm: ModelRef = { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" };
const deepseek: ModelRef = { sourceId: "deepseek", modelId: "deepseek-chat", reasoning: null };

test("returns the most recent turn's catalog model so a continuation stays on it", () => {
  // newest is last; the most recent model-bearing turn wins
  assert.deepEqual(controlPromptModel([{ model: deepseek }, { model: glm }]), glm);
});

test("looks past model-less control prompts back to the last real selection", () => {
  // the user picked glm-5.2, then host-issued control prompts carried no model (the bug);
  // the resume should still land on glm-5.2, not the default provider
  assert.deepEqual(controlPromptModel([{ model: glm }, {}, {}]), glm);
});

test("returns undefined for a legacy provider-string-only session", () => {
  assert.equal(controlPromptModel([{}, {}]), undefined);
  assert.equal(controlPromptModel([]), undefined);
});

/**
 * 02.13: controlPromptProvider is the provider-string fallback below controlPromptModel. A legacy turn
 * carried only a `provider` string (no ModelRef); resume must land on THAT provider, not the host's
 * local default - and must skip the host's own control prompts (stamped with the compaction provider).
 */

test("returns the most recent REAL turn's provider so a legacy turn resumes on it", () => {
  // The downgrade repro: the only real turn ran on "gpt"; resume must pick "gpt", not the default.
  assert.equal(controlPromptProvider([{ provider: "gpt" }]), "gpt");
  // Newest real provider wins.
  assert.equal(controlPromptProvider([{ provider: "deepseek" }, { provider: "gpt" }]), "gpt");
});

test("skips the host's own control prompts so it never re-inherits the compaction provider", () => {
  // The user's turn ran on "gpt"; later host control prompts were stamped with the compaction
  // provider "qwen". The scan must look PAST those control prompts back to "gpt".
  assert.equal(
    controlPromptProvider([
      { provider: "gpt" },
      { provider: "qwen", control: true },
      { provider: "qwen", control: true },
    ]),
    "gpt",
  );
});

test("ignores blank providers and returns undefined when no real turn carries one", () => {
  assert.equal(controlPromptProvider([{ provider: "  " }, {}]), undefined);
  assert.equal(controlPromptProvider([{ provider: "qwen", control: true }]), undefined);
  assert.equal(controlPromptProvider([]), undefined);
});

/**
 * buildControlTurns projects the real log: it keeps only user.message turns and tags the host's own
 * control prompts. Combined with the two scanners it reproduces the host's three-tier resume resolution,
 * so these guard the whole 02.13 fix against real events (the producer-skip wiring included).
 */
const HOST = "host";
const CONTROL = controlProducerId(HOST);
let seq = 0;
const nextSeq = (): number => {
  seq += 1;
  return seq;
};
const userMsg = (
  payload: { text: string; provider: string; model?: ModelRef },
  producerId = "web",
) =>
  storedEvent(sessionEvents.userMessage(payload), { sessionId: "s", seq: nextSeq(), producerId });

// The host's three-tier resolution, reproduced over real turns: ModelRef → last real provider → default.
const resolve = (events: ReturnType<typeof userMsg>[]) => {
  const turns = buildControlTurns(events, HOST);
  return {
    provider: controlPromptProvider(turns) ?? "qwen-default",
    model: controlPromptModel(turns),
  };
};

test("buildControlTurns keeps user turns and tags the host's control prompts", () => {
  const turns = buildControlTurns(
    [
      userMsg({ text: "real", provider: "gpt" }),
      storedEvent(
        sessionEvents.assistantStarted({ runId: "r", warm: true, model: "m", provider: "gpt" }),
        { sessionId: "s", seq: nextSeq(), producerId: "host" },
      ),
      userMsg({ text: "control resume", provider: "qwen" }, CONTROL),
    ],
    HOST,
  );
  assert.equal(turns.length, 2, "only user.message turns are projected");
  assert.equal(turns[0]?.control, false);
  assert.equal(turns[1]?.control, true);
});

test("a legacy provider-string-only paused turn resumes on its provider, not the default", () => {
  // The downgrade repro end-to-end: the only real turn ran on "gpt" with no ModelRef. A later host
  // control prompt was stamped with the compaction provider; resume must still land on "gpt".
  const resolved = resolve([
    userMsg({ text: "do it", provider: "gpt" }),
    userMsg({ text: "continue", provider: "qwen-default" }, CONTROL),
  ]);
  assert.equal(resolved.provider, "gpt");
  assert.equal(resolved.model, undefined);
});

test("a ModelRef-bearing paused turn still resumes on its ModelRef (f539591 regression guard)", () => {
  const glmRef: ModelRef = { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" };
  const resolved = resolve([userMsg({ text: "do it", provider: "zai", model: glmRef })]);
  assert.deepEqual(resolved.model, glmRef);
  assert.equal(resolved.provider, "zai");
});

test("a history with no real user turn falls back to the compaction/default provider", () => {
  const resolved = resolve([userMsg({ text: "control only", provider: "qwen" }, CONTROL)]);
  assert.equal(resolved.provider, "qwen-default");
  assert.equal(resolved.model, undefined);
});

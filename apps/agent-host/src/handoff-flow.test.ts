import assert from "node:assert/strict";
import type { TrevorEventInput } from "@trevor/session";
import { test } from "vitest";
import { type DirectHandoffDeps, runDirectHandoff } from "./handoff-flow";

/**
 * The direct continuation-handoff orchestration (M2). These drive `runDirectHandoff` with a recording
 * deps stub - the same injected-effects style as session-lifecycle.test - and assert the EVENT SEQUENCE
 * and ordering: an empty prompt fails without switching; a valid prompt ensures the target before
 * writing to it, injects the prompt + provenance into the target before the switch, carries the source
 * model onto the target prompt, and writes no generated-prompt events (direct mode skips generation).
 */

interface Call {
  readonly fn: "publish" | "publishPrompt" | "ensureSession" | "spawnHost" | "switchAndRetire";
  readonly sessionId?: string;
  readonly type?: string;
  readonly event?: TrevorEventInput;
}

function recorder(over: Partial<DirectHandoffDeps> = {}): {
  readonly calls: Call[];
  readonly deps: DirectHandoffDeps;
} {
  const calls: Call[] = [];
  const deps: DirectHandoffDeps = {
    sourceSessionId: "src",
    cwd: "/work",
    workspace: "/work",
    newHandoffId: () => "h1",
    newSessionId: () => "tgt",
    targetModel: () => ({
      provider: "qwen",
      model: { sourceId: "qwen", modelId: "coder", reasoning: "high" },
      reasoning: "high",
    }),
    publish: async (sessionId, event) => {
      calls.push({ fn: "publish", sessionId, type: event.type, event });
    },
    publishPrompt: async (sessionId, event) => {
      calls.push({ fn: "publishPrompt", sessionId, type: event.type, event });
    },
    ensureSession: async (sessionId) => {
      calls.push({ fn: "ensureSession", sessionId });
    },
    spawnHost: (target) => {
      calls.push({ fn: "spawnHost", sessionId: target.sessionId });
    },
    switchAndRetire: async (targetSessionId) => {
      calls.push({ fn: "switchAndRetire", sessionId: targetSessionId });
    },
    ...over,
  };
  return { calls, deps };
}

const payloadOf = (call: Call | undefined): Record<string, unknown> =>
  (call?.event?.payload ?? {}) as Record<string, unknown>;

test("direct handoff rejects an empty prompt and does not switch", async () => {
  const { calls, deps } = recorder();
  const result = await runDirectHandoff("   ", deps);

  assert.equal(result.ok, false);
  assert.match(result.text, /usage/i);
  // The only effect is a failure marker in the SOURCE session - nothing is ensured, spawned, or switched.
  assert.deepEqual(
    calls.map((c) => c.fn),
    ["publish"],
  );
  assert.equal(calls[0]?.sessionId, "src");
  assert.equal(calls[0]?.type, "handoff.failed");
  assert.equal(payloadOf(calls[0]).code, "empty_prompt");
});

test("direct handoff ensures the target, injects prompt + provenance, then switches - in order", async () => {
  const { calls, deps } = recorder();
  const result = await runDirectHandoff("do the thing", deps);

  assert.equal(result.ok, true);
  assert.equal(result.targetSessionId, "tgt");
  assert.match(result.text, /tgt/);

  // The exact effect sequence: source request -> ensure target -> target provenance -> target prompt
  // -> source accepted -> spawn target host -> switch + retire.
  assert.deepEqual(
    calls.map((c) => `${c.fn}:${c.sessionId}${c.type ? `:${c.type}` : ""}`),
    [
      "publish:src:handoff.requested",
      "ensureSession:tgt",
      "publish:tgt:handoff.accepted",
      "publishPrompt:tgt:user.message",
      "publish:src:handoff.accepted",
      "spawnHost:tgt",
      "switchAndRetire:tgt",
    ],
  );
});

test("the target's first prompt rides publishPrompt (the control producer), not the lifecycle publish", async () => {
  const { calls, deps } = recorder();
  await runDirectHandoff("run it", deps);
  // The user.message MUST go through publishPrompt so the target host schedules a turn instead of
  // ignoring it as a host self-echo - the bug that left a handed-off session stuck "Working".
  const prompt = calls.find((c) => c.type === "user.message");
  assert.equal(prompt?.fn, "publishPrompt");
  assert.ok(!calls.some((c) => c.fn === "publish" && c.type === "user.message"));
});

test("the target session is ensured before any event is written to it, and before the switch", async () => {
  const { calls, deps } = recorder();
  await runDirectHandoff("go", deps);

  const ensureIdx = calls.findIndex((c) => c.fn === "ensureSession" && c.sessionId === "tgt");
  const firstTargetWrite = calls.findIndex(
    (c) => (c.fn === "publish" || c.fn === "publishPrompt") && c.sessionId === "tgt",
  );
  const switchIdx = calls.findIndex((c) => c.fn === "switchAndRetire");

  assert.ok(ensureIdx >= 0 && firstTargetWrite >= 0 && switchIdx >= 0);
  assert.ok(ensureIdx < firstTargetWrite, "ensure must precede writing to the target");
  assert.ok(firstTargetWrite < switchIdx, "the prompt must be in the target before the switch");
});

test("the target's first prompt is the verbatim text, carrying the source model", async () => {
  const { calls, deps } = recorder();
  await runDirectHandoff("ship the feature", deps);

  const prompt = calls.find((c) => c.sessionId === "tgt" && c.type === "user.message");
  const payload = payloadOf(prompt);
  assert.equal(payload.text, "ship the feature");
  assert.equal(payload.provider, "qwen");
  assert.deepEqual(payload.model, { sourceId: "qwen", modelId: "coder", reasoning: "high" });
});

test("direct mode writes no generated-prompt events", async () => {
  const { calls, deps } = recorder();
  await runDirectHandoff("direct only", deps);

  const types = calls.filter((c) => c.fn === "publish").map((c) => c.type);
  assert.ok(!types.includes("handoff.generating"));
  assert.ok(!types.includes("handoff.generated"));
});

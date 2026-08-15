import assert from "node:assert/strict";
import {
  fakeProvider,
  ProviderUnavailable,
  publishTurnVia,
  transportEmit,
} from "@belay/agent-host/testing";
import type { RunningServer } from "@belay/server-kit";
import { decodeTrevorEvent, type SessionEvent, streamTransport } from "@belay/session";
import { createWorkflowDriver } from "@belay/test-kit";
import { bootStore } from "@belay/test-kit/boot";
import { Stream } from "effect";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-E2E golden path (hermetic): the agent turn pipeline, driven by the deterministic fake
 * provider, publishes through a REAL session-store, and an independent subscriber tails the
 * same durable stream - exactly the host -> store -> web path, minus the model. Proves the
 * pieces are wired end to end: started -> tool.started -> tool.completed -> completed, with
 * the real tool's output carried on the wire.
 */

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

test("a fake-provider turn streams through the store to a subscriber, tool result and all", async () => {
  const transport = streamTransport(store.url);
  const workflow = await createWorkflowDriver(transport, "golden", { who: "viewer" });

  // The turn pipeline writes its events to the real store via a transport-backed Emit.
  await publishTurnVia(
    transportEmit(transport, "golden", "host"),
    fakeProvider(),
    [{ role: "user", content: "Please run echo hello-from-tool." }],
    { runId: "r1" },
  );

  await workflow.waitForType("assistant.completed");

  const types = workflow.events.map((e: SessionEvent) => e.type);
  assert.equal(types[0], "assistant.started");
  assert.ok(
    types.indexOf("tool.started") < types.indexOf("tool.completed") &&
      types.indexOf("tool.completed") < types.lastIndexOf("assistant.completed"),
    types.join(" -> "),
  );

  const toolResult = workflow.events.find((e) => e.type === "tool.completed");
  assert.ok(String(toolResult?.payload.result ?? "").includes("hello-from-tool"));

  const completed = workflow.events.find((e) => e.type === "assistant.completed");
  assert.equal(completed?.payload.error, undefined);
  assert.ok(String(completed?.payload.text ?? "").includes("the tool ran."));

  workflow.close();
});

test("a DeepSeek-like 1M-context low-pressure stop replays as an adaptive step_backstop", async () => {
  const transport = streamTransport(store.url);
  const workflow = await createWorkflowDriver(transport, "low-context-stop", { who: "viewer" });

  let calls = 0;
  await publishTurnVia(
    transportEmit(transport, "low-context-stop", "host"),
    fakeProvider({
      stream: (_messages, tools) => {
        calls += 1;
        if (tools.length === 0) {
          return Stream.empty;
        }
        return Stream.fromIterable([
          {
            type: "tool_call" as const,
            call: {
              id: `c${calls}`,
              name: "noop",
              arguments: JSON.stringify({ round: calls }),
            },
          },
          {
            type: "usage" as const,
            usage: { input: 89_022, output: 1, contextWindow: 1_000_000, genMs: 1 },
          },
        ]);
      },
    }),
    [{ role: "user", content: "keep working" }],
    { runId: "r-low" },
  );

  await workflow.waitForType("assistant.completed", {
    label: "assistant.completed step_backstop",
  });
  const completed = workflow.events.find((e) => e.type === "assistant.completed");
  const decoded = completed ? decodeTrevorEvent(completed) : null;
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  // A 1M window at ~8.9% pressure earns the >=1M tier budget (96), so the backstop replays at the
  // adaptive budget rather than the old static 32.
  assert.equal(decoded.stepLimit, 96);
  assert.equal(decoded.stop?.cause, "step_backstop");
  assert.equal(decoded.stop?.action, "paused");
  assert.equal(decoded.stop?.context?.pressure, 0.089022);

  workflow.close();
});

test("a high-context pressure stop replays as context_pressure after synthesis", async () => {
  const transport = streamTransport(store.url);
  const workflow = await createWorkflowDriver(transport, "context-pressure-stop", {
    who: "viewer",
  });

  await publishTurnVia(
    transportEmit(transport, "context-pressure-stop", "host"),
    fakeProvider({
      stream: (_messages, tools) =>
        tools.length === 0
          ? Stream.fromIterable([{ type: "text" as const, text: "synthesized answer" }])
          : Stream.fromIterable([
              {
                type: "tool_call" as const,
                call: { id: "c1", name: "noop", arguments: "{}" },
              },
              {
                type: "usage" as const,
                usage: { input: 850_000, output: 1, contextWindow: 1_000_000, genMs: 1 },
              },
            ]),
    }),
    [{ role: "user", content: "large context task" }],
    { runId: "r-pressure" },
  );

  await workflow.waitForType("assistant.completed", {
    label: "assistant.completed context_pressure",
  });
  const completed = workflow.events.find((e) => e.type === "assistant.completed");
  const decoded = completed ? decodeTrevorEvent(completed) : null;
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.stepLimit, 1);
  assert.equal(decoded.stop?.cause, "context_pressure");
  assert.equal(decoded.stop?.action, "synthesized");
  assert.equal(decoded.text, "synthesized answer");

  workflow.close();
});

test("a DeepSeek-style thinking-only stream drop reconnects and completes through the store", async () => {
  const transport = streamTransport(store.url);
  const workflow = await createWorkflowDriver(transport, "thinking-retry", { who: "viewer" });

  let calls = 0;
  await publishTurnVia(
    transportEmit(transport, "thinking-retry", "host"),
    fakeProvider({
      id: "deepseek",
      stream: () => {
        calls += 1;
        if (calls === 1) {
          // Thinking only, then a retryable transport drop before any token streams: safe to retry.
          return Stream.concat(
            Stream.fromIterable([{ type: "thinking" as const, text: "planning the edit" }]),
            Stream.fail(
              new ProviderUnavailable({
                provider: "deepseek",
                detail: "stream failed",
                retryable: true,
                classification: "transient_transport",
              }),
            ),
          );
        }
        return Stream.fromIterable([
          { type: "text" as const, text: "Recovered and done." },
          {
            type: "usage" as const,
            usage: { input: 10, output: 5, contextWindow: 1000, genMs: 1 },
          },
        ]);
      },
    }),
    [{ role: "user", content: "make a change" }],
    { runId: "r-think" },
  );

  await workflow.waitForType("assistant.completed", {
    label: "assistant.completed thinking-retry",
  });

  // A reconnecting marker carrying the safe-to-retry transport diagnostic rode the durable wire.
  const reconnecting = workflow.events.find((e) => e.type === "assistant.reconnecting");
  const rDecoded = reconnecting ? decodeTrevorEvent(reconnecting) : null;
  assert.equal(rDecoded?.type, "assistant.reconnecting");
  if (rDecoded?.type !== "assistant.reconnecting") return;
  assert.equal(rDecoded.diagnostic?.safeToRetry, true);
  assert.equal(rDecoded.diagnostic?.reason, "transport_loss");

  // The retry succeeded: a clean completion with the answer, and NEVER a bare `stream failed` error.
  const completed = workflow.events.find((e) => e.type === "assistant.completed");
  const decoded = completed ? decodeTrevorEvent(completed) : null;
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.error, undefined);
  assert.ok(decoded.text.includes("Recovered and done."), decoded.text);

  workflow.close();
});

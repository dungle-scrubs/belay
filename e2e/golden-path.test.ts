import assert from "node:assert/strict";
import { fakeProvider, publishTurnVia, transportEmit } from "@trevor/agent-host/testing";
import { type RunningServer, startServer } from "@trevor/server-kit";
import { decodeTrevorEvent, type SessionEvent } from "@trevor/session";
import { createSessionStore } from "@trevor/session-store/server";
import { subscribe, testTransport, waitFor } from "@trevor/test-kit";
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
  store = await startServer(createSessionStore(":memory:"), { port: 0 });
});

afterAll(async () => {
  await store.close();
});

test("a fake-provider turn streams through the store to a subscriber, tool result and all", async () => {
  const transport = testTransport(store.url);
  await transport.ensureSession("golden");

  const viewer = subscribe(transport, "golden", "viewer");
  await waitFor(viewer.isReplayed);

  // The turn pipeline writes its events to the real store via a transport-backed Emit.
  await publishTurnVia(
    transportEmit(transport, "golden", "host"),
    fakeProvider(),
    [{ role: "user", content: "Please run echo hello-from-tool." }],
    { runId: "r1" },
  );

  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: "assistant.completed",
  });

  const types = viewer.events.map((e: SessionEvent) => e.type);
  assert.equal(types[0], "assistant.started");
  assert.ok(
    types.indexOf("tool.started") < types.indexOf("tool.completed") &&
      types.indexOf("tool.completed") < types.lastIndexOf("assistant.completed"),
    types.join(" -> "),
  );

  const toolResult = viewer.events.find((e) => e.type === "tool.completed");
  assert.ok(String(toolResult?.payload.result ?? "").includes("hello-from-tool"));

  const completed = viewer.events.find((e) => e.type === "assistant.completed");
  assert.equal(completed?.payload.error, undefined);
  assert.ok(String(completed?.payload.text ?? "").includes("the tool ran."));

  viewer.connection.close();
});

test("a DeepSeek-like 1M-context low-pressure stop replays as an adaptive step_backstop", async () => {
  const transport = testTransport(store.url);
  await transport.ensureSession("low-context-stop");

  const viewer = subscribe(transport, "low-context-stop", "viewer");
  await waitFor(viewer.isReplayed);

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

  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: "assistant.completed step_backstop",
  });
  const completed = viewer.events.find((e) => e.type === "assistant.completed");
  const decoded = completed ? decodeTrevorEvent(completed) : null;
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  // A 1M window at ~8.9% pressure earns the >=1M tier budget (96), so the backstop replays at the
  // adaptive budget rather than the old static 32.
  assert.equal(decoded.stepLimit, 96);
  assert.equal(decoded.stop?.cause, "step_backstop");
  assert.equal(decoded.stop?.action, "paused");
  assert.equal(decoded.stop?.context?.pressure, 0.089022);

  viewer.connection.close();
});

test("a high-context pressure stop replays as context_pressure after synthesis", async () => {
  const transport = testTransport(store.url);
  await transport.ensureSession("context-pressure-stop");

  const viewer = subscribe(transport, "context-pressure-stop", "viewer");
  await waitFor(viewer.isReplayed);

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

  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: "assistant.completed context_pressure",
  });
  const completed = viewer.events.find((e) => e.type === "assistant.completed");
  const decoded = completed ? decodeTrevorEvent(completed) : null;
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.stepLimit, 1);
  assert.equal(decoded.stop?.cause, "context_pressure");
  assert.equal(decoded.stop?.action, "synthesized");
  assert.equal(decoded.text, "synthesized answer");

  viewer.connection.close();
});

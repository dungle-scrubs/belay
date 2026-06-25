import assert from "node:assert/strict";
import { fakeProvider, publishTurnVia, transportEmit } from "@trevor/agent-host/testing";
import type { SessionEvent } from "@trevor/session";
import {
  type RunningServer,
  startSessionStore,
  subscribe,
  testTransport,
  waitFor,
} from "@trevor/test-kit";
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
  store = await startSessionStore();
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

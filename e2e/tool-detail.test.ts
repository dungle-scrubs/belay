import assert from "node:assert/strict";
import { fakeProvider, publishTurnVia, transportEmit } from "@trevor/agent-host/testing";
import type { RunningServer } from "@trevor/server-kit";
import { type SessionEvent, streamTransport } from "@trevor/session";
import { subscribe, waitFor } from "@trevor/test-kit";
import { bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-TOOL-DETAIL (plan 08, hermetic): the event pipeline the tool detail takeover consumes, end-to-end
 * against a REAL booted session-store. A fake-provider turn runs a tool, and an independent subscriber
 * tails the same durable stream the web surface reads. Proves the detail's source contract: tool.started
 * carries the name + arguments (the detail's tool name + Arguments body) BEFORE tool.completed (the
 * "running" window the detail shows live), then tool.completed carries the result (the detail's Output) -
 * so the takeover, which re-derives from these rows, flips running -> done in place. The UI-level click
 * flow (inspect button -> takeover updates) is a deferred manual EZE (no headless browser lane here).
 */

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

test("a running tool's started/completed events carry the fields the detail takeover projects", async () => {
  const transport = streamTransport(store.url);
  await transport.ensureSession("detail");

  const viewer = subscribe(transport, "detail", "viewer");
  await waitFor(viewer.isReplayed);

  await publishTurnVia(
    transportEmit(transport, "detail", "host"),
    fakeProvider(),
    [{ role: "user", content: "Please run echo hello-from-tool." }],
    { runId: "r1" },
  );

  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: "assistant.completed",
  });

  const started = viewer.events.find((e: SessionEvent) => e.type === "tool.started");
  const completed = viewer.events.find((e: SessionEvent) => e.type === "tool.completed");

  // The "running" detail: a tool.started with the name + arguments the detail body reads, and it lands
  // strictly before its completion (the window the takeover renders as running).
  assert.ok(started, "the tool emitted a started event");
  assert.ok(
    typeof started?.payload.name === "string" && started.payload.name.length > 0,
    "has a name",
  );
  assert.notEqual(started?.payload.arguments, undefined, "carries arguments for the detail body");
  assert.ok(completed, "the tool emitted a completed event");
  assert.ok(
    viewer.events.indexOf(started!) < viewer.events.indexOf(completed!),
    "started precedes completed (the running -> done transition)",
  );

  // The "done" detail: the same call's completion carries the result the detail's Output section shows.
  assert.equal(
    started?.payload.callId,
    completed?.payload.callId,
    "same call id, re-derived in place",
  );
  assert.ok(
    String(completed?.payload.result ?? "").includes("hello-from-tool"),
    "the result is on the wire for the detail Output",
  );

  viewer.connection.close();
});

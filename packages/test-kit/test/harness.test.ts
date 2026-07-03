import assert from "node:assert/strict";
import type { RunningServer } from "@trevor/server-kit";
import { events, streamTransport } from "@trevor/session";
import { joinSession, liveHost, recordingTransport, storedEvent } from "@trevor/test-kit";
import { type BootedBlob, bootBlob, bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

let store: RunningServer;
let blob: BootedBlob;

beforeAll(async () => {
  store = await bootStore();
  blob = await bootBlob();
});
afterAll(async () => {
  await store.close();
  await blob.close();
});

test("session-store boots and ensureSession round-trips", async () => {
  const transport = streamTransport(store.url);
  assert.equal(await transport.ensureSession("s"), "s");
});

test("blob-store boots and answers /health", async () => {
  const res = await fetch(`${blob.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("joinSession ensures, subscribes, waits for replay, and waitForType returns the event", async () => {
  const rt = recordingTransport();
  rt.seed("s", [storedEvent(events.assistantCompleted({ runId: "r1", text: "done" }))]);

  const viewer = await joinSession(rt.transport, "s", "viewer");
  const completed = await viewer.waitForType("assistant.completed");

  assert.deepEqual(rt.ensured, ["s"]);
  assert.equal(viewer.isReplayed(), true);
  assert.equal(completed.type, "assistant.completed");
});

test("liveHost waits for host.online and returns the completed turn window", async () => {
  const rt = recordingTransport();
  const host = liveHost(rt.transport, "s", { provider: "qwen" });

  const online = host.waitHostOnline();
  rt.connects[0]?.onEvent(
    storedEvent(
      events.hostOnline({
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "host-1",
        cwd: "/repo",
        workspace: "/repo",
        commands: [],
        agents: [],
      }),
    ),
  );
  await online;

  const asked = host.ask("hello");
  assert.deepEqual(rt.publishedBy("s")[0], {
    type: "user.message",
    producerId: "verify",
    payload: { text: "hello", provider: "qwen" },
  });
  rt.connects[0]?.onEvent(storedEvent(events.assistantCompleted({ runId: "r1", text: "done" })));
  const result = await asked;

  assert.equal(result.completed.type, "assistant.completed");
  assert.equal(result.text, "done");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["assistant.completed"],
  );
  host.close();
});

import assert from "node:assert/strict";
import type { RunningServer } from "@belay/server-kit";
import { events, streamTransport } from "@belay/session";
import {
  createWorkflowDriver,
  joinSession,
  liveHost,
  recordingTransport,
  storedEvent,
} from "@belay/test-kit";
import { type BootedBlob, bootBlob, bootStore, bootWorkflowStack } from "@belay/test-kit/boot";
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

test("WorkflowDriver publishes prompts and returns a completion window with labels", async () => {
  const rt = recordingTransport();
  const driver = await createWorkflowDriver(rt.transport, "s", {
    who: "viewer",
    producerId: "web",
    provider: "qwen",
  });

  const asked = driver.promptToCompletion("hello", { label: "test completion" });
  assert.deepEqual(rt.publishedBy("s")[0], {
    type: "user.message",
    producerId: "web",
    payload: { text: "hello", provider: "qwen" },
  });
  rt.connects[0]?.onEvent(
    storedEvent(events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: "{}" })),
  );
  rt.connects[0]?.onEvent(storedEvent(events.assistantCompleted({ runId: "r1", text: "done" })));

  const result = await asked;
  assert.equal(result.text, "done");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["tool.started", "assistant.completed"],
  );
  assert.equal((await driver.waitForType("tool.started")).type, "tool.started");
  driver.close();
});

test("WorkflowDriver publishes commands and returns the correlated result window", async () => {
  const rt = recordingTransport();
  const driver = await createWorkflowDriver(rt.transport, "s", {
    who: "viewer",
    producerId: "web",
  });

  const command = driver.command("/status", "now");
  assert.deepEqual(rt.publishedBy("s")[0], {
    type: "user.command",
    producerId: "web",
    payload: { command: "/status", args: "now" },
  });
  rt.connects[0]?.onEvent(
    storedEvent(events.commandResult({ command: "/status", text: "ready", ok: true })),
  );

  const result = await command;
  assert.equal(result.text, "ready");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["command.result"],
  );
  driver.close();
});

test("bootWorkflowStack boots a hermetic store and creates replayed workflow drivers", async () => {
  const stack = await bootWorkflowStack();
  try {
    const workflow = await stack.workflow("workflow-stack", { who: "viewer" });

    assert.equal(workflow.isReplayed(), true);
    await workflow.publish({
      ...events.userMessage({ text: "hello", provider: "fake" }),
      producerId: "web",
    });
    const message = await workflow.waitForType("user.message", { label: "workflow user.message" });

    assert.equal(message.type, "user.message");
    workflow.close();
  } finally {
    await stack.close();
  }
});

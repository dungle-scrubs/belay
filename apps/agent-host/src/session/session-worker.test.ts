import assert from "node:assert/strict";
import type { ProviderRegistry } from "@host/providers";
import {
  events,
  PRODUCER_IDS,
  type SessionEvent,
  UNKNOWN_INTERNET,
  type Usage,
} from "@trevor/session";
import { NOOP_SINK } from "@trevor/session/telemetry";
import { createProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import { recordingTransport, storedEvent, waitFor } from "@trevor/test-kit";
import { test } from "vitest";
import { fakeProvider } from "../../test/support/fake-provider";
import { makeSessionWorker, type SessionWorkerDeps } from "./session-worker";

/**
 * Responsible for: regression coverage for the shared host session worker boundary.
 * Not for: tangent discovery policy, which is covered by tangent-adoption.test.ts.
 */

const HOST_PRODUCER = PRODUCER_IDS.host;

function providers(): ProviderRegistry {
  const qwen = fakeProvider({
    id: "qwen",
    step: () => [{ type: "text", text: "worker answer" }],
  });
  return {
    qwen: { ...qwen, debugInfo: () => ({ served: 6_144 }) },
  };
}

function deps(overrides: Partial<SessionWorkerDeps> = {}): SessionWorkerDeps {
  const rec = recordingTransport();
  return {
    sessionId: "s1",
    producerId: HOST_PRODUCER,
    instanceId: "instance-abcdef01",
    transport: rec.transport,
    providers: providers(),
    residency: { onActiveModelChanged: () => Promise.resolve() },
    internet: { refreshIfStale: () => Promise.resolve(UNKNOWN_INTERNET) },
    lease: { isLeader: () => true },
    hostTelemetry: NOOP_SINK,
    providerTrace: createProviderTraceWriter({ enabled: false }),
    ...overrides,
  };
}

function prompt(seq: number): SessionEvent {
  return storedEvent(events.userMessage({ text: "hello", provider: "qwen" }), {
    sessionId: "s1",
    seq,
    producerId: PRODUCER_IDS.web,
  });
}

function modelPrompt(seq: number): SessionEvent {
  return storedEvent(
    events.userMessage({
      text: "continue on the large model",
      provider: "zai",
      model: { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" },
    }),
    {
      sessionId: "s1",
      seq,
      producerId: PRODUCER_IDS.web,
    },
  );
}

function started(seq: number, runId: string, provider: string, model: string): SessionEvent {
  return storedEvent(events.assistantStarted({ runId, warm: true, provider, model }), {
    sessionId: "s1",
    seq,
    producerId: HOST_PRODUCER,
  });
}

function progress(seq: number, runId: string, usage: Usage): SessionEvent {
  return storedEvent(events.assistantProgress({ runId, usage }), {
    sessionId: "s1",
    seq,
    producerId: HOST_PRODUCER,
  });
}

function completed(seq: number, runId: string, usage: Usage): SessionEvent {
  return storedEvent(events.assistantCompleted({ runId, text: "done", usage }), {
    sessionId: "s1",
    seq,
    producerId: HOST_PRODUCER,
  });
}

function compacted(seq: number): SessionEvent {
  return storedEvent(
    events.contextCompacted({
      foldId: "fold-1",
      throughSeq: 4,
      summary: "summary",
      manifest: { turnRange: { fromSeq: 1, toSeq: 4 }, files: [], tools: [], topics: [] },
      tokensBefore: 5_200,
      tokensAfter: 2_000,
      model: "qwen-small",
    }),
    {
      sessionId: "s1",
      seq,
      producerId: HOST_PRODUCER,
    },
  );
}

function workerWithLiveCompaction(rec: ReturnType<typeof recordingTransport>) {
  let worker: ReturnType<typeof makeSessionWorker>;
  let compactCalls = 0;
  worker = makeSessionWorker(
    deps({
      transport: rec.transport,
      autoConnect: false,
      compaction: {
        needed: () => worker.isLive() && worker.compactionController.needed(true),
        run: () => {
          compactCalls += 1;
        },
      },
    }),
  );
  return {
    worker,
    compactCalls: () => compactCalls,
  };
}

test("worker publishes live prompts to its own session", async () => {
  const rec = recordingTransport();
  const worker = makeSessionWorker(deps({ transport: rec.transport }));
  await waitFor(() => worker.isLive(), { label: "worker live" });

  const stream = rec.connects[0];
  assert.ok(stream, "worker opened a stream");
  stream.onEvent(prompt(1));

  await waitFor(() => rec.publishedBy("s1").some((event) => event.type === "assistant.completed"), {
    label: "worker live completion",
  });

  assert.equal(worker.isLive(), true);
  assert.equal(rec.publishedBy("s1").at(-1)?.payload.text, "worker answer");
  worker.close();
});

test("worker cancel publishes the same cancelled completion shape used by main and tangent sessions", async () => {
  const rec = recordingTransport();
  const worker = makeSessionWorker(deps({ transport: rec.transport }));
  await waitFor(() => worker.isLive(), { label: "worker live" });

  const stream = rec.connects[0];
  assert.ok(stream, "worker opened a stream");
  stream.onEvent(
    storedEvent(
      events.assistantStarted({ runId: "r1", warm: true, model: "qwen", provider: "qwen" }),
      {
        sessionId: "s1",
        seq: 1,
        producerId: HOST_PRODUCER,
      },
    ),
  );
  stream.onEvent(
    storedEvent(events.userCancel({ runId: "r1" }), {
      sessionId: "s1",
      seq: 2,
      producerId: PRODUCER_IDS.web,
    }),
  );

  await waitFor(() => rec.publishedBy("s1").some((event) => event.type === "assistant.completed"), {
    label: "worker cancelled completion",
  });

  const completed = rec.publishedBy("s1").find((event) => event.type === "assistant.completed");
  assert.equal(completed?.payload.runId, "r1");
  assert.equal(completed?.payload.cancelled, true);
  assert.notEqual(completed?.payload.interrupted, true);
  worker.close();
});

test("replayed foreground window is re-anchored before live blocking-before compaction", async () => {
  const rec = recordingTransport();
  rec.seed("s1", [
    prompt(1),
    started(2, "small-run", "qwen", "qwen-small"),
    progress(3, "small-run", { input: 5_200, output: 10, contextWindow: 6_144, genMs: 1 }),
    completed(4, "small-run", { input: 5_200, output: 10, contextWindow: 6_144, genMs: 1 }),
    modelPrompt(5),
    started(6, "large-run", "zai", "glm-5.2"),
    progress(7, "large-run", { input: 20_900, output: 20, contextWindow: 262_144, genMs: 1 }),
    completed(8, "large-run", { input: 20_900, output: 20, contextWindow: 262_144, genMs: 1 }),
  ]);

  const h = workerWithLiveCompaction(rec);

  h.worker.connect();
  await waitFor(() => h.worker.isLive(), { label: "worker replay complete" });

  rec.connects[0]?.onEvent(modelPrompt(9));

  assert.equal(
    h.compactCalls(),
    0,
    "a live large-window prompt must observe its provider before blocking-before compaction",
  );
  await waitFor(() => rec.publishedBy("s1").some((event) => event.type === "assistant.started"), {
    label: "large prompt started without blocking fold",
  });
  h.worker.close();
});

test("live preflight still blocks a genuinely over-budget small-model prompt", async () => {
  const rec = recordingTransport();
  rec.seed("s1", [
    modelPrompt(1),
    started(2, "large-run", "zai", "glm-5.2"),
    progress(3, "large-run", { input: 20_900, output: 20, contextWindow: 262_144, genMs: 1 }),
    completed(4, "large-run", { input: 20_900, output: 20, contextWindow: 262_144, genMs: 1 }),
  ]);

  const h = workerWithLiveCompaction(rec);

  h.worker.connect();
  await waitFor(() => h.worker.isLive(), { label: "worker replay complete" });

  rec.connects[0]?.onEvent(prompt(5));

  assert.equal(
    h.compactCalls(),
    1,
    "small selected models still compact when the prompt is over budget",
  );
  assert.equal(
    rec.publishedBy("s1").some((event) => event.type === "assistant.started"),
    false,
    "the small-model turn is held behind blocking-before compaction",
  );
  h.worker.close();
});

test("reconnect resets compaction state before replay rebuilds folds", async () => {
  const rec = recordingTransport();
  rec.seed("s1", [prompt(1), compacted(2)]);

  const worker = makeSessionWorker(deps({ transport: rec.transport, autoConnect: false }));
  worker.connect();
  await waitFor(() => worker.isLive(), { label: "first replay complete" });
  assert.equal(worker.compactionController.debug().lastFold?.throughSeq, 4);

  rec.seed("s1", [prompt(1)]);
  worker.connect();
  await waitFor(() => worker.isLive(), { label: "second replay complete" });

  assert.equal(worker.compactionController.debug().lastFold, null);
  assert.deepEqual(worker.compactionController.debug().provider, { id: "qwen", model: "fake-1" });
  worker.close();
});

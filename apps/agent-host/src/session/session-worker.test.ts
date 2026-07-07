import assert from "node:assert/strict";
import type { ProviderRegistry } from "@host/providers";
import { events, PRODUCER_IDS, type SessionEvent, UNKNOWN_INTERNET } from "@trevor/session";
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
  return {
    qwen: fakeProvider({
      id: "qwen",
      step: () => [{ type: "text", text: "worker answer" }],
    }),
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

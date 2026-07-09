import assert from "node:assert/strict";
import { tangentIsolationReport } from "@host/agent/tangent-isolation";
import type { ChatMessage, ProviderRegistry } from "@host/providers";
import {
  events,
  PRODUCER_IDS,
  type SessionEvent,
  type SessionTransport,
  UNKNOWN_INTERNET,
} from "@trevor/session";
import { NOOP_SINK } from "@trevor/session/telemetry";
import { createProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import {
  type RecordingTransport,
  recordingTransport,
  storedEvent,
  waitFor,
} from "@trevor/test-kit";
import { test } from "vitest";
import { fakeProvider } from "../../test/support/fake-provider";
import { makeTangentAdoption, type TangentAdoptionDeps } from "./tangent-adoption";

/**
 * Parent-host tangent adoption (plan 37 takeover): the parent host runs turns for the tangent sessions
 * branched off it, each in an ISOLATED per-tangent worker (its own log, `startTurn` bound to the
 * tangent id) that only the parent LEADER answers. Driven with the in-memory recording transport (seed
 * a replay, drive `onEvent`, read the published writes) and a deterministic fake provider - no store,
 * no model.
 */

const PARENT_ID = "parent-session";
const HOST_PRODUCER = PRODUCER_IDS.host;
const USAGE = { input: 10, output: 5, contextWindow: 1000, genMs: 1 } as const;

/** Decorates a recording transport so `connectSession` returns a connection whose `close()` is tracked
 *  (the recording transport's own connection close is a no-op), letting a test assert teardown really
 *  disconnects. Everything else delegates unchanged, so `rec.connects`/`publishedBy` still work. */
function trackingTransport(rec: RecordingTransport): {
  readonly transport: SessionTransport;
  readonly closed: readonly string[];
} {
  const closed: string[] = [];
  const transport: SessionTransport = {
    ...rec.transport,
    connectSession: (options) => {
      const connection = rec.transport.connectSession(options);
      return {
        close: () => {
          closed.push(options.sessionId);
          connection.close();
        },
      };
    },
  };
  return { transport, closed };
}

/** A fake provider registry keyed by the default source ("qwen"), whose one-step answer captures the
 *  exact prompt the model was handed so a test can assert what did (and did not) reach the turn. */
function capturingProviders(answer: string): {
  readonly providers: ProviderRegistry;
  prompt(): readonly ChatMessage[];
} {
  let captured: readonly ChatMessage[] = [];
  const provider = fakeProvider({
    id: "qwen",
    step: (messages) => {
      captured = messages;
      return [
        { type: "text", text: answer },
        { type: "usage", usage: USAGE },
      ];
    },
  });
  return { providers: { qwen: provider }, prompt: () => captured };
}

function deps(
  transport: SessionTransport,
  providers: ProviderRegistry,
  isLeader: () => boolean,
): TangentAdoptionDeps {
  return {
    parentSessionId: PARENT_ID,
    producerId: HOST_PRODUCER,
    instanceId: "instance-abcdef01",
    transport,
    providers,
    residency: { onActiveModelChanged: () => Promise.resolve() },
    internet: { refreshIfStale: () => Promise.resolve(UNKNOWN_INTERNET) },
    lease: { isLeader },
    hostTelemetry: NOOP_SINK,
    providerTrace: createProviderTraceWriter({ enabled: false }),
  };
}

/** The `session.tangentOf` seed marker a real tangent's log opens with (web producer), stamped on the
 *  tangent session. Its presence is the tangent's whole isolation guarantee - it copies no parent event. */
function tangentMarker(tangentId: string, seq = 1): SessionEvent {
  return storedEvent(
    events.sessionTangentOf({
      parentSessionId: PARENT_ID,
      sourceMessageId: "m1",
      quote: "the selected snapshot",
    }),
    { sessionId: tangentId, seq, producerId: PRODUCER_IDS.web },
  );
}

/** A browser-authored `user.message` on the tangent stream (an answerable producer). */
function tangentPrompt(tangentId: string, text: string, seq: number): SessionEvent {
  return storedEvent(events.userMessage({ text, provider: "qwen" }), {
    sessionId: tangentId,
    seq,
    producerId: PRODUCER_IDS.web,
  });
}

/** Yields past all queued microtasks + timers so the recording transport's replay (a queued microtask)
 *  has run and each worker has gone live. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The `onEvent` sink the worker registered for `tangentId` (its live-stream entry point). */
function streamOf(rec: RecordingTransport, tangentId: string): (event: SessionEvent) => void {
  const options = rec.connects.find((c) => c.sessionId === tangentId);
  assert.ok(options, `a stream was opened for ${tangentId}`);
  return options.onEvent;
}

test("a leader worker answers a tangent user.message, publishing assistant.* to the TANGENT (isolated)", async () => {
  const rec = recordingTransport();
  const marker = tangentMarker("tangent-1");
  rec.seed("tangent-1", [marker]);
  // A decoy parent log with distinctive content: the worker never subscribes to the parent, so none of
  // this may reach the tangent's prompt.
  const parentEvents = [
    storedEvent(events.userMessage({ text: "PARENT-SECRET find the auth bug", provider: "qwen" }), {
      sessionId: PARENT_ID,
      seq: 1,
    }),
    storedEvent(
      events.assistantCompleted({ runId: "rp", text: "PARENT-ANSWER it is in auth.ts" }),
      {
        sessionId: PARENT_ID,
        seq: 2,
        producerId: HOST_PRODUCER,
      },
    ),
  ];
  rec.seed(PARENT_ID, parentEvents);

  const { providers, prompt } = capturingProviders("the tangent answer");
  const adoption = makeTangentAdoption(deps(rec.transport, providers, () => true));

  adoption.reconcile(["tangent-1"]);
  await settle(); // replay completes -> the worker goes live

  const promptEvent = tangentPrompt("tangent-1", "what does THIS thread need?", 2);
  streamOf(rec, "tangent-1")(promptEvent);

  await waitFor(() => rec.publishedBy("tangent-1").some((e) => e.type === "assistant.completed"), {
    label: "tangent assistant.completed",
  });

  const tangentLog = rec.publishedBy("tangent-1");
  assert.ok(
    tangentLog.some((e) => e.type === "assistant.started"),
    "the turn started on the tangent",
  );
  const completed = tangentLog.find((e) => e.type === "assistant.completed");
  assert.equal(completed?.payload.text, "the tangent answer", "the answer landed on the tangent");
  assert.equal(rec.publishedBy(PARENT_ID).length, 0, "NOTHING was published to the parent session");

  // Isolation: the exact prompt the model saw contains this tangent's question and NONE of the parent's
  // transcript - the worker's log is fed only from the tangent's own stream.
  const promptText = prompt()
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  assert.ok(
    promptText.includes("what does THIS thread need?"),
    "the tangent's question is in the prompt",
  );
  assert.ok(
    !promptText.includes("PARENT-SECRET"),
    "no parent user turn leaked into the tangent prompt",
  );
  assert.ok(
    !promptText.includes("PARENT-ANSWER"),
    "no parent reply leaked into the tangent prompt",
  );

  // The canonical diagnostic agrees: the tangent's seed + first prompt carry zero parent history.
  const report = tangentIsolationReport({
    tangentEvents: [marker, promptEvent],
    parentEvents,
    parentSessionId: PARENT_ID,
    seedQuote: "the selected snapshot",
  });
  assert.equal(report.isolated, true, "the tangent prompt is isolated from the parent");
  assert.deepEqual(report.leakedFromParent, [], "no parent content leaked");

  adoption.teardownAll();
});

test("a leader worker CATCHES UP a prompt already pending when it adopts the tangent", async () => {
  // The real case: the web writes the tangent's `user.message` before any host serves it, so at
  // adoption the prompt is ALREADY in the log and arrives on REPLAY (off-live). The worker must run it
  // on go-live catch-up - a prompt admitted while `live` is false never forks on its own.
  const rec = recordingTransport();
  const pending = tangentPrompt("tangent-1", "answer the pending one", 2);
  rec.seed("tangent-1", [tangentMarker("tangent-1"), pending]);

  const { providers } = capturingProviders("caught up");
  const adoption = makeTangentAdoption(deps(rec.transport, providers, () => true));

  adoption.reconcile(["tangent-1"]);
  // No live event is ever driven: the ONLY way this completes is the replay-complete catch-up.
  await waitFor(() => rec.publishedBy("tangent-1").some((e) => e.type === "assistant.completed"), {
    label: "pending tangent turn caught up on adoption",
  });

  const completed = rec.publishedBy("tangent-1").find((e) => e.type === "assistant.completed");
  assert.equal(completed?.payload.text, "caught up", "the already-pending prompt was answered");
  assert.equal(rec.publishedBy(PARENT_ID).length, 0, "nothing was published to the parent");

  adoption.teardownAll();
});

test("reconcile adopts a new tangent once (idempotent) and teardownAll disconnects every worker", async () => {
  const rec = recordingTransport();
  const tracked = trackingTransport(rec);
  const { providers } = capturingProviders("x");
  const adoption = makeTangentAdoption(deps(tracked.transport, providers, () => true));

  adoption.reconcile(["t1"]);
  await settle();
  assert.equal(adoption.adoptedCount(), 1, "one worker after the first reconcile");

  // Re-reconciling the same id is a no-op: no second worker, no second stream opened.
  adoption.reconcile(["t1"]);
  await settle();
  assert.equal(adoption.adoptedCount(), 1, "still one worker (idempotent)");
  assert.equal(
    rec.connects.filter((c) => c.sessionId === "t1").length,
    1,
    "the tangent stream was opened exactly once",
  );

  // A newly-discovered id is adopted alongside the existing one.
  adoption.reconcile(["t1", "t2"]);
  await settle();
  assert.equal(adoption.adoptedCount(), 2, "the second tangent is adopted");

  // An id that fell out of the discovered set has its worker torn down.
  adoption.reconcile(["t1"]);
  assert.equal(adoption.adoptedCount(), 1, "the dropped tangent's worker is released");
  assert.deepEqual(tracked.closed, ["t2"], "the dropped worker's stream was closed");

  adoption.teardownAll();
  assert.equal(adoption.adoptedCount(), 0, "teardownAll drops every worker");
  assert.deepEqual(
    tracked.closed,
    ["t2", "t1"],
    "teardownAll closed the remaining worker's stream",
  );
});

test("adopt starts one tangent worker without fetching or dropping existing workers", async () => {
  const rec = recordingTransport();
  const tracked = trackingTransport(rec);
  const { providers } = capturingProviders("event adopted");
  const adoption = makeTangentAdoption(deps(tracked.transport, providers, () => true));

  adoption.reconcile(["existing"]);
  await settle();
  adoption.adopt("tangent-event", "event");
  adoption.adopt("tangent-event", "event");
  await settle();

  assert.equal(
    adoption.adoptedCount(),
    2,
    "event adoption adds one worker beside existing workers",
  );
  assert.equal(
    rec.connects.filter((c) => c.sessionId === "tangent-event").length,
    1,
    "the event-created tangent stream was opened exactly once",
  );
  assert.deepEqual(tracked.closed, [], "single-tangent adoption never releases unrelated workers");

  adoption.teardownAll();
});

test("adopted event tangent catches up a pending prompt immediately", async () => {
  const rec = recordingTransport();
  const pending = tangentPrompt("tangent-event", "answer from the event path", 2);
  rec.seed("tangent-event", [tangentMarker("tangent-event"), pending]);
  const { providers } = capturingProviders("fast path answer");
  const adoption = makeTangentAdoption(deps(rec.transport, providers, () => true));

  adoption.adopt("tangent-event", "event");

  await waitFor(
    () => rec.publishedBy("tangent-event").some((e) => e.type === "assistant.completed"),
    {
      label: "event-adopted tangent turn completed",
    },
  );
  const completed = rec.publishedBy("tangent-event").find((e) => e.type === "assistant.completed");
  assert.equal(completed?.payload.text, "fast path answer");
  assert.equal(
    rec.publishedBy(PARENT_ID).length,
    0,
    "the event path still publishes only to tangent",
  );

  adoption.teardownAll();
});

test("a user.cancel hard-cancels the tangent's in-flight run (a cancelled completion is published)", async () => {
  const rec = recordingTransport();
  rec.seed("tangent-1", [tangentMarker("tangent-1")]);
  const { providers } = capturingProviders("unused");
  const adoption = makeTangentAdoption(deps(rec.transport, providers, () => true));
  adoption.reconcile(["tangent-1"]);
  await settle();

  const stream = streamOf(rec, "tangent-1");
  // A run in flight on the tangent (the host's own started echo), then the user presses ESC (user.cancel).
  stream(
    storedEvent(
      events.assistantStarted({ runId: "r1", warm: true, model: "qwen", provider: "qwen" }),
      { sessionId: "tangent-1", seq: 2, producerId: HOST_PRODUCER },
    ),
  );
  stream(
    storedEvent(events.userCancel({ runId: "r1" }), {
      sessionId: "tangent-1",
      seq: 3,
      producerId: PRODUCER_IDS.web,
    }),
  );

  await waitFor(() => rec.publishedBy("tangent-1").some((e) => e.type === "assistant.completed"), {
    label: "cancelled completion for the tangent run",
  });
  const completed = rec.publishedBy("tangent-1").find((e) => e.type === "assistant.completed");
  assert.equal(
    completed?.payload.cancelled,
    true,
    "the tangent run was cancelled by the user (ESC)",
  );
  assert.equal((completed?.payload as { runId?: string }).runId, "r1");

  adoption.teardownAll();
});

test("a NON-leader worker records the prompt but never answers it", async () => {
  const rec = recordingTransport();
  rec.seed("tangent-1", [tangentMarker("tangent-1")]);
  const { providers } = capturingProviders("should never run");
  // Not the leader: only the parent leader answers tangents.
  const adoption = makeTangentAdoption(deps(rec.transport, providers, () => false));

  adoption.reconcile(["tangent-1"]);
  await settle();

  streamOf(rec, "tangent-1")(tangentPrompt("tangent-1", "answer me", 2));
  await settle();
  await settle();

  const assistantEvents = rec
    .publishedBy("tangent-1")
    .filter((e) => e.type.startsWith("assistant."));
  assert.deepEqual(assistantEvents, [], "a non-leader publishes no turn for the tangent");

  adoption.teardownAll();
});

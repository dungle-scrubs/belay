import assert from "node:assert/strict";
import {
  type DirectHandoffDeps,
  isAnswerablePrompt,
  runDirectHandoff,
  TurnScheduler,
} from "@trevor/agent-host/testing";
import { type RunningServer, startServer } from "@trevor/server-kit";
import {
  decodeTrevorEvent,
  PRODUCER_IDS,
  type SessionEvent,
  events as sessionEvents,
} from "@trevor/session";
import { createSessionStore } from "@trevor/session-store/server";
import { subscribe, testTransport, waitFor } from "@trevor/test-kit";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-E2E continuation handoff (02, M2), hermetic: drives the REAL direct-handoff orchestration through a
 * REAL session-store, then replays the target log through the SAME turn scheduler + self-echo predicate
 * the live host uses. This catches the bug a manual browser test surfaced - the injected prompt was
 * stamped with the host's own producer id, so the target host ignored it as a self-echo and the session
 * sat "Working" forever. The fix: inject via the control producer; this proves it end to end (and the
 * negative case reproduces the original bug) without a browser or a spawned OS host.
 */

const HOST = PRODUCER_IDS.host;
const CONTROL = `${HOST}:control`;

let store: RunningServer;

beforeAll(async () => {
  store = await startServer(createSessionStore(":memory:"), { port: 0 });
});

afterAll(async () => {
  await store.close();
});

/** Reads a session's full durable log via a replay-then-read subscriber. */
async function readLog(url: string, sessionId: string): Promise<SessionEvent[]> {
  const transport = testTransport(url);
  const viewer = subscribe(transport, sessionId, `reader-${sessionId}`);
  await waitFor(viewer.isReplayed, { label: `${sessionId} replay` });
  viewer.connection.close();
  return viewer.events;
}

/**
 * Replays a target session log through a real TurnScheduler wired exactly as the live host wires it
 * (handleEvent's answerable-prompt gate + deps.start's startTurn guard, both via isAnswerablePrompt),
 * then goes live + becomes leader and runs the catch-up. Returns the prompts that were actually
 * STARTED - the faithful answer to "would the target host run this prompt?".
 */
function replayAndSchedule(events: readonly SessionEvent[]): SessionEvent[] {
  const started: SessionEvent[] = [];
  let live = false;
  let leader = false;
  const scheduler = new TurnScheduler({
    isLeader: () => leader,
    // Mirrors main.ts deps.start: admit, then fork only when live, answerable, and leader.
    start: (event) => {
      if (!live || !isAnswerablePrompt(event.producerId, HOST) || !leader) {
        return null;
      }
      started.push(event);
      return { runId: `run-${started.length}`, cancel: () => {} };
    },
  });

  // Replay: feed turn-relevant events through the same producer gate handleEvent applies.
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "user.message" && isAnswerablePrompt(event.producerId, HOST)) {
      scheduler.noteTurn(event);
    } else if (decoded?.type === "assistant.started") {
      scheduler.noteTurn(event);
    }
  }

  // goLive + onBecomeLeader catch-up: run the latest unanswered, unattempted prompt.
  live = true;
  leader = true;
  const pending = scheduler.pendingCatchUp();
  if (pending) {
    scheduler.noteTurn(pending);
  }
  return started;
}

function directDeps(url: string): DirectHandoffDeps {
  const transport = testTransport(url);
  return {
    sourceSessionId: "src",
    cwd: "/work/proj",
    workspace: "/work/proj",
    newHandoffId: () => "handoff-1",
    newSessionId: () => "tgt",
    targetModel: () => ({
      provider: "lmstudio",
      model: { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" },
    }),
    publish: (sessionId, event) =>
      transport.publishEvent(sessionId, { ...event, producerId: HOST }),
    publishPrompt: (sessionId, event) =>
      transport.publishEvent(sessionId, { ...event, producerId: CONTROL }),
    ensureSession: async (sessionId) => {
      await transport.ensureSession(sessionId);
    },
    spawnHost: () => {},
    switchAndRetire: async (targetSessionId) => {
      await transport.publishEvent("src", {
        ...sessionEvents.sessionSwitch({ sessionId: targetSessionId, reason: "handoff" }),
        producerId: HOST,
      });
    },
  };
}

test("direct handoff injects the target prompt via the control producer, and the target host runs it", async () => {
  const transport = testTransport(store.url);
  await transport.ensureSession("src");

  const result = await runDirectHandoff("continue the parser work", directDeps(store.url));
  assert.equal(result.ok, true);
  assert.equal(result.targetSessionId, "tgt");

  // The TARGET log: provenance + the first prompt, which MUST ride the control producer (the fix) so the
  // target host schedules it instead of dropping it as a self-echo.
  const target = await readLog(store.url, "tgt");
  const prompt = target.find((e) => e.type === "user.message");
  assert.ok(prompt, "target has a first user.message");
  assert.equal(
    prompt?.producerId,
    CONTROL,
    "prompt rides the control producer, not the host's own id",
  );
  assert.equal((prompt?.payload as { text?: string }).text, "continue the parser work");
  // The source model carries over onto the target prompt.
  assert.deepEqual((prompt?.payload as { model?: unknown }).model, {
    sourceId: "zai",
    modelId: "glm-5.2",
    reasoning: "xhigh",
  });
  assert.ok(
    target.some((e) => e.type === "handoff.accepted"),
    "target carries handoff provenance",
  );

  // The SOURCE log: the handoff lifecycle + the switch the browser follows.
  const source = await readLog(store.url, "src");
  assert.ok(source.some((e) => e.type === "handoff.requested"));
  assert.ok(source.some((e) => e.type === "handoff.accepted"));
  const sw = source.find((e) => e.type === "session.switch");
  assert.equal((sw?.payload as { sessionId?: string }).sessionId, "tgt");

  // The faithful end: replay the target log through the real scheduler. The injected prompt IS started.
  const started = replayAndSchedule(target);
  assert.equal(started.length, 1, "the target host schedules exactly the injected prompt");
  assert.equal(started[0]?.type, "user.message");
  assert.equal((started[0]?.payload as { text?: string }).text, "continue the parser work");
});

test("regression: a prompt stamped with the host's own producer is dropped (the original bug)", async () => {
  // Reproduce the pre-fix injection: the target prompt published with the host's BARE producer id.
  const transport = testTransport(store.url);
  await transport.ensureSession("bug");
  await transport.publishEvent("bug", {
    ...sessionEvents.handoffAccepted({ handoffId: "h", targetSessionId: "bug", prompt: "run me" }),
    producerId: HOST,
  });
  await transport.publishEvent("bug", {
    ...sessionEvents.userMessage({ text: "run me", provider: "lmstudio" }),
    producerId: HOST, // the bug: self-authored, so the target host treats it as its own echo
  });

  const events = await readLog(store.url, "bug");
  const started = replayAndSchedule(events);
  assert.equal(
    started.length,
    0,
    "a self-authored prompt is never scheduled - the forever-Working bug",
  );
});

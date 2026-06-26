import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import { decodeTrevorEvent, events, type TrevorEventInput } from "./protocol";

/**
 * The protocol is the single source of truth shared by host and web: `events.*` builds
 * the wire payload, `decodeTrevorEvent` reads it back permissively. These guard the two
 * properties the rest of the system leans on - the emit/consume sides stay in lockstep,
 * and decode never throws (unknown -> null, missing correlation id -> the event's own id).
 */

/** Wrap an emit-side input into a full stored SessionEvent (what decodeTrevorEvent reads). */
const stored = (input: TrevorEventInput, over: Partial<SessionEvent> = {}): SessionEvent => ({
  sessionId: "s",
  seq: 1,
  eventId: "ev-1",
  producerId: "host",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: input.type,
  payload: input.payload as Record<string, unknown>,
  ...over,
});

test("events.userMessage round-trips through decodeTrevorEvent", () => {
  const decoded = decodeTrevorEvent(stored(events.userMessage({ text: "hi", provider: "qwen" })));
  assert.equal(decoded?.type, "user.message");
  assert.deepEqual(decoded, {
    type: "user.message",
    text: "hi",
    provider: "qwen",
    reasoning: undefined,
    artifacts: [],
  });
});

test("optional fields are omitted on the wire, not sent as null", () => {
  const completed = events.assistantCompleted({ runId: "r", text: "x" });
  assert.equal("usage" in completed.payload, false);
  assert.equal("error" in completed.payload, false);
  assert.equal("cancelled" in completed.payload, false);

  const msg = events.userMessage({ text: "hi", provider: "qwen" });
  assert.equal("reasoning" in msg.payload, false);
  assert.equal("artifacts" in msg.payload, false);
});

test("an unknown event type decodes to null (forward-compatible)", () => {
  assert.equal(decodeTrevorEvent(stored({ type: "future.thing", payload: {} })), null);
});

test("assistant.reconnecting round-trips through decodeTrevorEvent (D-079)", () => {
  const decoded = decodeTrevorEvent(
    stored(events.assistantReconnecting({ runId: "r", attempt: 2, detail: "websocket closed" })),
  );
  assert.deepEqual(decoded, {
    type: "assistant.reconnecting",
    runId: "r",
    attempt: 2,
    detail: "websocket closed",
  });
});

test("host.online round-trips the announced subagents (D-045)", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.hostOnline({
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "i",
        cwd: "~",
        workspace: "~",
        commands: [],
        agents: [{ id: "explorer", description: "read-only", tools: ["read", "grep"], skills: [] }],
      }),
    ),
  );
  assert.equal(decoded?.type, "host.online");
  if (decoded?.type !== "host.online") return;
  assert.deepEqual(decoded.agents, [
    { id: "explorer", description: "read-only", tools: ["read", "grep"], skills: [] },
  ]);
});

test("a missing runId falls back to the event's own id, never collapsing turns", () => {
  const decoded = decodeTrevorEvent(
    stored({ type: "assistant.delta", payload: { text: "hi" } }, { eventId: "ev-9" }),
  );
  assert.equal(decoded?.type, "assistant.delta");
  assert.equal(decoded?.type === "assistant.delta" && decoded.runId, "ev-9");
});

test("assistant.completed coerces cancelled/noReply/stepLimit to safe defaults", () => {
  const decoded = decodeTrevorEvent(stored(events.assistantCompleted({ runId: "r", text: "ok" })));
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.cancelled, false);
  assert.equal(decoded.noReply, false);
  assert.equal(decoded.stepLimit, 0);
  assert.equal(decoded.usage, undefined);
});

test("context.compacted round-trips, including the per-fold delta manifest", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.contextCompacted({
        foldId: "f1",
        throughSeq: 42,
        summary: "rolling summary",
        manifest: {
          turnRange: { fromSeq: 1, toSeq: 42 },
          files: ["src/a.ts"],
          tools: ["read"],
          topics: ["auth"],
        },
        tokensBefore: 50_000,
        tokensAfter: 20_000,
        model: "qwen",
      }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "context.compacted",
    foldId: "f1",
    throughSeq: 42,
    supersedes: undefined,
    summary: "rolling summary",
    manifest: {
      turnRange: { fromSeq: 1, toSeq: 42 },
      files: ["src/a.ts"],
      tools: ["read"],
      topics: ["auth"],
    },
    tokensBefore: 50_000,
    tokensAfter: 20_000,
    model: "qwen",
  });
});

test("a superseding fold chains off the prior foldId; supersedes is omitted when absent", () => {
  const first = events.contextCompacted({
    foldId: "f1",
    throughSeq: 10,
    summary: "s1",
    manifest: { turnRange: { fromSeq: 1, toSeq: 10 }, files: [], tools: [], topics: [] },
    tokensBefore: 40_000,
    tokensAfter: 18_000,
    model: "qwen",
  });
  assert.equal("supersedes" in first.payload, false);

  const second = events.contextCompacted({
    foldId: "f2",
    throughSeq: 20,
    supersedes: "f1",
    summary: "s2",
    manifest: { turnRange: { fromSeq: 11, toSeq: 20 }, files: [], tools: [], topics: [] },
    tokensBefore: 45_000,
    tokensAfter: 19_000,
    model: "qwen",
  });
  const decoded = decodeTrevorEvent(stored(second));
  assert.equal(decoded?.type === "context.compacted" && decoded.supersedes, "f1");
});

test("context.compacting round-trips the live fold-progress tick", () => {
  const decoded = decodeTrevorEvent(
    stored(events.contextCompacting({ foldId: "f1", tokens: 240, budget: 1_000 })),
  );
  assert.deepEqual(decoded, {
    type: "context.compacting",
    foldId: "f1",
    tokens: 240,
    budget: 1_000,
  });
});

test("a malformed context.compacted manifest coerces to empty arrays, never throws", () => {
  const decoded = decodeTrevorEvent(
    stored({ type: "context.compacted", payload: { summary: "s", manifest: "nope" } }),
  );
  assert.equal(decoded?.type, "context.compacted");
  if (decoded?.type !== "context.compacted") return;
  assert.deepEqual(decoded.manifest, {
    turnRange: { fromSeq: 0, toSeq: 0 },
    files: [],
    tools: [],
    topics: [],
  });
});

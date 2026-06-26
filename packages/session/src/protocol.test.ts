import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import { decodeTrevorEvent, events, LIFECYCLE_TYPES, type TrevorEventInput } from "./protocol";

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
        branch: "main",
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
  assert.equal(decoded.branch, "main");
  assert.deepEqual(decoded.agents, [
    { id: "explorer", description: "read-only", tools: ["read", "grep"], skills: [] },
  ]);
});

test("host.online round-trips the structured git status (D-088)", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.hostOnline({
        branch: "feat/x",
        git: {
          branch: "feat/x",
          detached: null,
          dirty: true,
          ahead: 2,
          behind: 1,
          upstream: true,
          worktree: false,
        },
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "i",
        cwd: "~",
        workspace: "~",
        commands: [],
        agents: [],
      }),
    ),
  );
  assert.equal(decoded?.type, "host.online");
  if (decoded?.type !== "host.online") return;
  assert.deepEqual(decoded.git, {
    branch: "feat/x",
    detached: null,
    dirty: true,
    ahead: 2,
    behind: 1,
    upstream: true,
    worktree: false,
  });
});

test("host.online round-trips managed worktrees and defaults to [] when absent (D-091)", () => {
  const worktree = {
    id: "wt1",
    baseRepo: "/dev/trevorV2",
    baseRepoName: "trevorV2",
    branch: "feat/x",
    path: "~/.trevorV2/.worktrees/h/feat-x-wt1",
    sessionId: "s-wt1",
    dirty: true,
    ahead: 2,
    behind: 1,
    conflict: false,
    detached: false,
    current: false,
    baseline: false,
    missing: false,
  };
  const withWt = decodeTrevorEvent(
    stored(
      events.hostOnline({
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "i",
        cwd: "~",
        workspace: "~",
        commands: [],
        agents: [],
        worktrees: [worktree],
      }),
    ),
  );
  assert.equal(withWt?.type, "host.online");
  if (withWt?.type !== "host.online") return;
  assert.deepEqual(withWt.worktrees, [worktree]);

  // An older host that omits worktrees decodes to an empty list, never undefined.
  const without = decodeTrevorEvent(
    stored(
      events.hostOnline({
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "i",
        cwd: "~",
        workspace: "~",
        commands: [],
        agents: [],
      }),
    ),
  );
  assert.equal(without?.type === "host.online" && without.worktrees.length, 0);
});

test("host.online without a git field stays decode-tolerant (older host)", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.hostOnline({
        branch: "main",
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "i",
        cwd: "~",
        workspace: "~",
        commands: [],
        agents: [],
      }),
    ),
  );
  assert.equal(decoded?.type, "host.online");
  if (decoded?.type !== "host.online") return;
  assert.equal(decoded.git, undefined);
  assert.equal(decoded.branch, "main");
});

test("host.online git coerces a partial/malformed payload to safe defaults", () => {
  const decoded = decodeTrevorEvent(
    stored({
      type: "host.online",
      payload: { git: { branch: "wip", dirty: "yes", ahead: "x" } },
    }),
  );
  assert.equal(decoded?.type, "host.online");
  if (decoded?.type !== "host.online") return;
  assert.deepEqual(decoded.git, {
    branch: "wip",
    detached: null,
    dirty: false, // non-boolean truthiness is ignored - only `true` counts
    ahead: 0, // non-number coerces to 0
    behind: 0,
    upstream: false,
    worktree: false,
  });
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

test("session.switch round-trips the host-authored handoff target", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.sessionSwitch({ sessionId: "trevor-20260626-123456z-abcdef12", reason: "clear" }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "session.switch",
    sessionId: "trevor-20260626-123456z-abcdef12",
    reason: "clear",
  });
});

test("user.shell + shell.result round-trip through decodeTrevorEvent (D-082)", () => {
  const shell = decodeTrevorEvent(
    stored(events.userShell({ requestId: "req-1", command: "printf hello" })),
  );
  assert.deepEqual(shell, { type: "user.shell", requestId: "req-1", command: "printf hello" });

  const result = decodeTrevorEvent(
    stored(
      events.shellResult({
        requestId: "req-1",
        command: "printf hello",
        output: "hello",
        ok: true,
      }),
    ),
  );
  assert.deepEqual(result, {
    type: "shell.result",
    requestId: "req-1",
    command: "printf hello",
    output: "hello",
    ok: true,
  });
});

test("shell.result coerces a missing ok to false and a missing requestId to the event id", () => {
  const decoded = decodeTrevorEvent(
    stored({ type: "shell.result", payload: { command: "x" } }, { eventId: "ev-shell" }),
  );
  assert.equal(decoded?.type, "shell.result");
  if (decoded?.type !== "shell.result") return;
  assert.equal(decoded.ok, false);
  assert.equal(decoded.requestId, "ev-shell");
  assert.equal(decoded.output, "");
});

test("events.raw stamps the same TrevorEventInput envelope as the typed builders (D-025)", () => {
  // A forward-compat / arbitrary event built by hand vs. through events.raw: the builder
  // must produce the identical `{ type, payload }` shape the typed constructors yield, so the
  // test path shares the production envelope pipeline rather than re-spelling the input shape.
  const type = "future.thing";
  const payload = { foo: "bar", n: 1 };
  const built = events.raw(type, payload);
  assert.deepEqual(built, { type, payload });

  // The same shape a typed builder yields: events.raw of a known type/payload must equal the
  // typed constructor for that event (same fields, same structure).
  const typed = events.assistantDelta({ runId: "r", text: "hi" });
  const viaRaw = events.raw(typed.type, typed.payload);
  assert.deepEqual(viaRaw, typed);

  // And it still rides the real consume side: a raw arbitrary type decodes to null (forward-compat),
  // while a raw payload for a known type decodes exactly as the typed builder would.
  assert.equal(decodeTrevorEvent(stored(built)), null);
  assert.deepEqual(decodeTrevorEvent(stored(viaRaw)), decodeTrevorEvent(stored(typed)));
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

test("LIFECYCLE_TYPES names exactly the lifecycle events, drawn from their constructors (D-032)", () => {
  // The inventory's per-session activity signal reads these; pinning the set here keeps the
  // protocol the single source - adding a lifecycle event must update this list, not a literal
  // buried in session-store. Each entry must be a real emit-side event type.
  assert.deepEqual(LIFECYCLE_TYPES, ["assistant.started", "assistant.completed", "user.command"]);
  assert.equal(LIFECYCLE_TYPES.length, new Set(LIFECYCLE_TYPES).size);
  assert.equal(
    events.assistantStarted({ runId: "r", warm: false, model: "m", provider: "p" }).type,
    LIFECYCLE_TYPES[0],
  );
  assert.equal(events.assistantCompleted({ runId: "r", text: "x" }).type, LIFECYCLE_TYPES[1]);
  assert.equal(events.userCommand({ command: "/x", args: "" }).type, LIFECYCLE_TYPES[2]);
});

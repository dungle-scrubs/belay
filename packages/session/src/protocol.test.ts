import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import {
  decodeTrevorEvent,
  events,
  LEGACY_TASK_REVISION,
  LIFECYCLE_TYPES,
  type TrevorEventInput,
  taskSnapshotReplaces,
} from "./protocol";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "./provider-question";

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
  assert.equal("model" in msg.payload, false);
});

test("user.message carries a ModelRef alongside the legacy provider, and round-trips it (D-065)", () => {
  const model = { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" };
  const msg = events.userMessage({ text: "hi", provider: "deepseek", model });
  assert.deepEqual(msg.payload.model, model, "the ref rides the wire next to provider");
  assert.deepEqual(decodeTrevorEvent(stored(msg)), {
    type: "user.message",
    text: "hi",
    provider: "deepseek",
    reasoning: undefined,
    model,
    artifacts: [],
  });
});

test("a legacy user.message (no model) decodes with no model key", () => {
  const decoded = decodeTrevorEvent(stored(events.userMessage({ text: "hi", provider: "qwen" })));
  assert.equal(decoded?.type === "user.message" && "model" in decoded, false);
});

test("a garbled user.message model is dropped so the host falls back to provider (D-065)", () => {
  const decoded = decodeTrevorEvent(
    stored({
      type: "user.message",
      payload: { text: "hi", provider: "qwen", model: { sourceId: 5 } },
    }),
  );
  assert.equal(decoded?.type, "user.message");
  assert.equal(
    decoded?.type === "user.message" && "model" in decoded,
    false,
    "unusable ref dropped",
  );
});

test("an unknown event type decodes to null (forward-compatible)", () => {
  assert.equal(decodeTrevorEvent(stored({ type: "future.thing", payload: {} })), null);
});

test("assistant.reconnecting round-trips through decodeTrevorEvent (D-079)", () => {
  const decoded = decodeTrevorEvent(
    stored(events.assistantReconnecting({ runId: "r", attempt: 2, detail: "websocket closed" })),
  );
  // No maxAttempts passed (a pre-02.15-style event): it stays absent so old logs decode unchanged.
  assert.deepEqual(decoded, {
    type: "assistant.reconnecting",
    runId: "r",
    attempt: 2,
    detail: "websocket closed",
  });
});

test("assistant.continued (step-budget checkpoint) round-trips through decodeTrevorEvent (02.17)", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.assistantContinued({
        runId: "r",
        steps: 64,
        pressure: 0.207,
        threshold: 128,
        detail: "continued at step 64 - 20.7% context, room left",
      }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "assistant.continued",
    runId: "r",
    steps: 64,
    pressure: 0.207,
    threshold: 128,
    detail: "continued at step 64 - 20.7% context, room left",
  });
});

test("assistant.reconnecting round-trips the threaded maxAttempts budget (02.15)", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.assistantReconnecting({
        runId: "r",
        attempt: 2,
        maxAttempts: 10,
        detail: "websocket closed",
      }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "assistant.reconnecting",
    runId: "r",
    attempt: 2,
    maxAttempts: 10,
    detail: "websocket closed",
  });
});

test("assistant.reconnecting optionally carries a provider diagnostic", () => {
  const diagnostic = {
    provider: "deepseek",
    model: "deepseek-chat",
    phase: "model-step",
    reason: "transport_loss",
    retryable: true,
    safeToRetry: true,
    attempt: 2,
    detail: "stream failed",
    partials: { textChars: 0, thinkingChars: 43, toolCalls: 0, toolResults: 0 },
    status: 502,
    code: "stream_error",
    requestId: "req_123",
  } as const;
  const decoded = decodeTrevorEvent(
    stored(
      events.assistantReconnecting({
        runId: "r",
        attempt: 2,
        detail: "stream failed",
        diagnostic,
      }),
    ),
  );
  assert.equal(decoded?.type, "assistant.reconnecting");
  if (decoded?.type !== "assistant.reconnecting") return;
  assert.deepEqual(decoded.diagnostic, diagnostic);
});

test("assistant.completed optionally carries a provider diagnostic while preserving error", () => {
  const diagnostic = {
    provider: "deepseek",
    model: "deepseek-chat",
    phase: "model-step",
    reason: "transport_loss",
    retryable: true,
    safeToRetry: false,
    attempt: 3,
    detail: "stream failed",
    partials: { textChars: 12, thinkingChars: 80, toolCalls: 0, toolResults: 0 },
  } as const;
  const decoded = decodeTrevorEvent(
    stored(
      events.assistantCompleted({
        runId: "r",
        text: "",
        error: "deepseek unavailable: stream failed",
        diagnostic,
      }),
    ),
  );
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.error, "deepseek unavailable: stream failed");
  assert.deepEqual(decoded.diagnostic, diagnostic);
});

test("assistant.completed stop metadata round-trips through decodeTrevorEvent", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.assistantCompleted({
        runId: "r",
        text: "",
        stepLimit: 32,
        stop: {
          cause: "step_backstop",
          action: "paused",
          summary: "Paused at the step backstop before context pressure.",
          steps: 32,
          context: { inputTokens: 89_022, contextWindow: 1_000_000, pressure: 0.089022 },
          diagnosticRef: null,
        },
      }),
    ),
  );
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.stepLimit, 32);
  assert.deepEqual(decoded.stop, {
    cause: "step_backstop",
    action: "paused",
    summary: "Paused at the step backstop before context pressure.",
    steps: 32,
    context: { inputTokens: 89_022, contextWindow: 1_000_000, pressure: 0.089022 },
    diagnosticRef: null,
  });
});

test("legacy assistant.completed events decode with no stop object", () => {
  const decoded = decodeTrevorEvent(
    stored(events.assistantCompleted({ runId: "r", text: "legacy", stepLimit: 32 })),
  );
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.stepLimit, 32);
  assert.equal(decoded.stop, undefined);
  assert.equal(decoded.diagnostic, undefined);
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

test("host.online round-trips the model sources + catalog, defaulting to empty when absent (D-065)", () => {
  const source = {
    sourceId: "zai",
    type: "api-key" as const,
    label: "Z.ai",
    status: "ready" as const,
    modelCount: 1,
    auth: "authenticated" as const,
    freshness: { refreshedAt: null, stale: false },
    actions: ["refresh" as const],
  };
  const entry = {
    sourceId: "zai",
    modelId: "glm-5.2",
    displayName: "GLM-5.2",
    kind: "cloud" as const,
    capabilities: ["tools", "reasoning"],
    contextLength: 200000,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels: ["off", "high"],
    defaultReasoning: "high",
  };
  const base = {
    providers: ["qwen"],
    default: "qwen",
    models: {},
    instanceId: "i",
    cwd: "~",
    workspace: "~",
    commands: [],
    agents: [],
  };
  const decoded = decodeTrevorEvent(
    stored(events.hostOnline({ ...base, sources: [source], catalog: { zai: [entry] } })),
  );
  assert.equal(decoded?.type, "host.online");
  if (decoded?.type !== "host.online") return;
  assert.deepEqual(decoded.sources, [source]);
  assert.deepEqual(decoded.catalog.zai, [entry]);

  // A host that announces neither decodes to empty (not undefined), so consumers never branch on it.
  const bare = decodeTrevorEvent(stored(events.hostOnline(base)));
  assert.equal(
    bare?.type === "host.online" && Array.isArray(bare.sources) && bare.sources.length,
    0,
  );
  assert.deepEqual(bare?.type === "host.online" ? bare.catalog : null, {});
});

test("host.sourceAuth round-trips a source sign-in flow (D-065 M5)", () => {
  // Device-code phase: the verification URL + short user code (no API key) survive the round trip.
  const dc = decodeTrevorEvent(
    stored(
      events.hostSourceAuth({
        state: {
          sourceId: "openai",
          phase: "device-code",
          verificationUri: "https://example.com/device",
          userCode: "WXYZ-1234",
        },
      }),
    ),
  );
  assert.equal(dc?.type, "host.sourceAuth");
  if (dc?.type !== "host.sourceAuth") return;
  assert.deepEqual(dc.auth, {
    sourceId: "openai",
    phase: "device-code",
    verificationUri: "https://example.com/device",
    userCode: "WXYZ-1234",
  });

  // Completion + error phases decode their phase (and a sanitized detail for error).
  const done = decodeTrevorEvent(
    stored(events.hostSourceAuth({ state: { sourceId: "openai", phase: "complete" } })),
  );
  assert.equal(done?.type === "host.sourceAuth" && done.auth.phase, "complete");
  const err = decodeTrevorEvent(
    stored(
      events.hostSourceAuth({ state: { sourceId: "openai", phase: "error", detail: "timed out" } }),
    ),
  );
  assert.equal(err?.type === "host.sourceAuth" && err.auth.detail, "timed out");

  // A garbled phase decodes to a cancelled flow (never throws).
  const bad = decodeTrevorEvent(
    stored({ type: "host.sourceAuth", payload: { sourceId: "x", phase: "?" } }),
  );
  assert.equal(bad?.type === "host.sourceAuth" && bad.auth.phase, "cancelled");
});

test("session.title round-trips a durable rename (editable session titles)", () => {
  const decoded = decodeTrevorEvent(stored(events.sessionTitle({ title: "Auth refactor" })));
  assert.deepEqual(decoded, { type: "session.title", title: "Auth refactor" });
  // A garbled/missing title coerces to an empty string (the inventory then falls back to the derived title).
  const bad = decodeTrevorEvent(stored({ type: "session.title", payload: { title: 42 } }));
  assert.equal(bad?.type === "session.title" && bad.title, "");
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

test("session.switch carries the continuation-handoff reason (02, M2)", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.sessionSwitch({ sessionId: "trevor-20260626-123456z-abcdef12", reason: "handoff" }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "session.switch",
    sessionId: "trevor-20260626-123456z-abcdef12",
    reason: "handoff",
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

// --- ask_user provider-question events (M3) ---

const QUESTION_CONTRACT: ProviderQuestionContract = {
  schemaVersion: 1,
  questions: [
    {
      id: "db",
      question: "Which database?",
      answerShape: "single_choice",
      multiSelect: false,
      requiresReason: false,
      allowDefer: false,
      choices: [
        { id: "pg", label: "Postgres", recommended: true },
        { id: "sqlite", label: "SQLite" },
      ],
    },
  ],
};

test("provider.question.requested round-trips the contract + correlation ids", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.providerQuestionRequested({
        questionId: "q-1",
        runId: "r-1",
        toolCallId: "tc-1",
        toolName: "ask_user",
        adapter: "ask_user",
        contract: QUESTION_CONTRACT,
      }),
    ),
  );
  assert.equal(decoded?.type, "provider.question.requested");
  if (decoded?.type !== "provider.question.requested") return;
  assert.equal(decoded.questionId, "q-1");
  assert.equal(decoded.runId, "r-1");
  assert.equal(decoded.toolCallId, "tc-1");
  assert.equal(decoded.toolName, "ask_user");
  assert.deepEqual(decoded.contract, QUESTION_CONTRACT);
});

test("provider.question.answer round-trips an accept (with per-question entries) and a decline", () => {
  const accept: ProviderQuestionAnswer = {
    action: "accept",
    answer: "Postgres",
    questions: [{ id: "db", answer: "Postgres", selected: [{ id: "pg", label: "Postgres" }] }],
  };
  const acc = decodeTrevorEvent(
    stored(events.providerQuestionAnswer({ questionId: "q-1", answer: accept })),
  );
  assert.equal(acc?.type, "provider.question.answer");
  if (acc?.type !== "provider.question.answer") return;
  assert.equal(acc.questionId, "q-1");
  assert.deepEqual(acc.answer, accept);

  const dec = decodeTrevorEvent(
    stored(events.providerQuestionAnswer({ questionId: "q-1", answer: { action: "decline" } })),
  );
  assert.deepEqual(dec?.type === "provider.question.answer" ? dec.answer : null, {
    action: "decline",
  });
});

test("provider.question.resolved round-trips the outcome + sanitized summary", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.providerQuestionResolved({
        questionId: "q-1",
        runId: "r-1",
        toolCallId: "tc-1",
        outcome: "answered",
        summary: "Answered (1 question)",
      }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "provider.question.resolved",
    questionId: "q-1",
    runId: "r-1",
    toolCallId: "tc-1",
    outcome: "answered",
    summary: "Answered (1 question)",
  });
});

test("provider.question.requested decodes a sparse/forward-compat payload with safe defaults", () => {
  // No questionId/toolName/adapter; a choice with unknown extra metadata; a string preview; no flags.
  const decoded = decodeTrevorEvent(
    stored(
      {
        type: "provider.question.requested",
        payload: {
          runId: "r",
          contract: {
            questions: [
              { question: "Pick?", choices: [{ label: "A", preview: "+--+", futuristicField: 9 }] },
            ],
          },
        },
      },
      { eventId: "ev-q" },
    ),
  );
  assert.equal(decoded?.type, "provider.question.requested");
  if (decoded?.type !== "provider.question.requested") return;
  assert.equal(decoded.questionId, "ev-q"); // missing id falls back to the event id
  assert.equal(decoded.toolName, "ask_user"); // default
  assert.equal(decoded.adapter, "ask_user"); // default
  const q0 = decoded.contract.questions[0];
  assert.equal(q0?.id, "question_1"); // filled deterministically
  assert.equal(q0?.answerShape, "single_choice"); // derived from the presence of choices
  assert.equal(q0?.choices[0]?.id, "choice_1");
  assert.equal(q0?.choices[0]?.preview?.text, "+--+"); // string preview -> structured
  // Unknown metadata is dropped rather than carried through.
  assert.equal("futuristicField" in (q0?.choices[0] ?? {}), false);
});

test("provider.question.answer decodes a garbled/missing action as an accept (forward-compatible)", () => {
  const decoded = decodeTrevorEvent(
    stored({
      type: "provider.question.answer",
      payload: { questionId: "q", answer: { questions: [] } },
    }),
  );
  assert.equal(decoded?.type === "provider.question.answer" && decoded.answer.action, "accept");
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

// --- continuation handoff events (02, M1) ---

test("handoff.requested round-trips mode/source/prompt, defaulting proposed to false", () => {
  const decoded = decodeTrevorEvent(
    stored(
      events.handoffRequested({
        handoffId: "h1",
        mode: "direct",
        sourceSessionId: "s-src",
        prompt: "do the thing",
      }),
    ),
  );
  assert.deepEqual(decoded, {
    type: "handoff.requested",
    handoffId: "h1",
    mode: "direct",
    sourceSessionId: "s-src",
    prompt: "do the thing",
    proposed: false,
  });
});

test("a model-proposed generate handoff carries proposed:true and omits prompt", () => {
  const built = events.handoffRequested({
    handoffId: "h2",
    mode: "generate",
    sourceSessionId: "s-src",
    proposed: true,
  });
  assert.equal("prompt" in built.payload, false);
  const decoded = decodeTrevorEvent(stored(built));
  assert.equal(decoded?.type === "handoff.requested" && decoded.proposed, true);
  assert.equal(decoded?.type === "handoff.requested" && decoded.mode, "generate");
});

test("the handoff lifecycle events round-trip through decodeTrevorEvent", () => {
  assert.deepEqual(
    decodeTrevorEvent(stored(events.handoffGenerating({ handoffId: "h1", detail: "summarizing" }))),
    {
      type: "handoff.generating",
      handoffId: "h1",
      detail: "summarizing",
    },
  );
  assert.deepEqual(
    decodeTrevorEvent(
      stored(events.handoffGenerated({ handoffId: "h1", prompt: "the target prompt" })),
    ),
    { type: "handoff.generated", handoffId: "h1", prompt: "the target prompt" },
  );
  assert.deepEqual(
    decodeTrevorEvent(stored(events.handoffApproved({ handoffId: "h1", prompt: "edited" }))),
    {
      type: "handoff.approved",
      handoffId: "h1",
      prompt: "edited",
    },
  );
  assert.deepEqual(
    decodeTrevorEvent(stored(events.handoffRejected({ handoffId: "h1", reason: "not now" }))),
    {
      type: "handoff.rejected",
      handoffId: "h1",
      reason: "not now",
    },
  );
  assert.deepEqual(
    decodeTrevorEvent(
      stored(events.handoffFailed({ handoffId: "h1", code: "HO001", detail: "empty" })),
    ),
    {
      type: "handoff.failed",
      handoffId: "h1",
      code: "HO001",
      detail: "empty",
    },
  );
  assert.deepEqual(
    decodeTrevorEvent(
      stored(events.handoffAccepted({ handoffId: "h1", targetSessionId: "s-tgt", prompt: "go" })),
    ),
    { type: "handoff.accepted", handoffId: "h1", targetSessionId: "s-tgt", prompt: "go" },
  );
});

test("handoff.requested decodes a sparse/forward-compat payload with safe defaults", () => {
  const decoded = decodeTrevorEvent(
    stored(
      { type: "handoff.requested", payload: { mode: "???" } },
      { eventId: "ev-h", sessionId: "s-fallback" },
    ),
  );
  assert.equal(decoded?.type, "handoff.requested");
  if (decoded?.type !== "handoff.requested") return;
  assert.equal(decoded.handoffId, "ev-h"); // missing id falls back to the event id
  assert.equal(decoded.mode, "generate"); // an unknown mode coerces to generate
  assert.equal(decoded.sourceSessionId, "s-fallback"); // missing source falls back to the event's session
  assert.equal(decoded.proposed, false);
  assert.equal("prompt" in decoded, false);
});

// --- Plan 09 M5: tasks.current freshness metadata (D-004) ---

const oneTask = [
  {
    id: "task_1",
    subject: "wire the API",
    activeForm: "wiring the API",
    status: "in_progress" as const,
    blockedBy: [],
    blocks: [],
  },
];

test("tasks.current carries a monotonic revision and round-trips it", () => {
  const decoded = decodeTrevorEvent(stored(events.tasksCurrent({ tasks: oneTask, rev: 7 })));
  assert.equal(decoded?.type, "tasks.current");
  if (decoded?.type !== "tasks.current") return;
  assert.equal(decoded.rev, 7);
  assert.equal(decoded.tasks[0]?.id, "task_1");
});

test("a legacy tasks.current without a revision decodes to LEGACY_TASK_REVISION", () => {
  // An old log (or a caller that omits rev) carries no freshness field; it must decode conservatively.
  const legacy = events.tasksCurrent({ tasks: oneTask });
  assert.equal("rev" in legacy.payload, false);

  const decoded = decodeTrevorEvent(stored(legacy));
  assert.equal(decoded?.type, "tasks.current");
  if (decoded?.type !== "tasks.current") return;
  assert.equal(decoded.rev, LEGACY_TASK_REVISION);
  assert.equal(LEGACY_TASK_REVISION, 0);
});

test("taskSnapshotReplaces: higher revision wins, equal replaces (latest), lower is stale", () => {
  assert.equal(taskSnapshotReplaces(5, 3), true); // newer
  assert.equal(taskSnapshotReplaces(3, 3), true); // tie -> latest arrival wins
  assert.equal(taskSnapshotReplaces(2, 5), false); // stale, rejected
  // Legacy events all share rev 0, so the latest still wins among them.
  assert.equal(taskSnapshotReplaces(LEGACY_TASK_REVISION, LEGACY_TASK_REVISION), true);
});

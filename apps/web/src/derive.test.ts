import assert from "node:assert/strict";
import {
  HOST_ROLE,
  type HostPresence,
  type ProviderQuestionContract,
  type SessionEvent,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import {
  commandsFrom,
  defaultProviderFrom,
  detectOrphanedTurn,
  fmtCtx,
  fmtTokens,
  hostStatus,
  isSessionArchived,
  latestSessionSwitch,
  parseBangShell,
  parseCommand,
  pendingQuestionFrom,
  providerModelsFrom,
  tasksFrom,
  toolSummary,
} from "./derive";

/**
 * The pure view-model selectors over the session event log (derive.ts). They fold raw
 * SessionEvent[] into the shapes App.tsx renders, so a fold bug shows as a wrong transcript,
 * stale meter, or a dead host that still looks present. Tested as pure functions - no DOM.
 */

let n = 0;
const evt = (
  type: string,
  payload: Record<string, unknown>,
  createdAt = "2026-06-25T00:00:00.000Z",
): SessionEvent => {
  n += 1;
  return storedEvent({ type, payload }, { sessionId: "s", seq: n, producerId: "host", createdAt });
};

const online = (instanceId: string, extra: Record<string, unknown> = {}) =>
  evt("host.online", {
    instanceId,
    providers: ["qwen"],
    models: {
      qwen: {
        label: "Qwen",
        model: "q",
        reasoningLevels: [],
        defaultReasoning: "off",
        kind: "local",
      },
    },
    commands: [{ name: "/clear", summary: "reset" }],
    branch: "main",
    default: "qwen",
    workspace: "/ws",
    cwd: "/cwd",
    ...extra,
  });

test("fmtTokens and fmtCtx render compact counts", () => {
  assert.equal(fmtTokens(6100), "6.1k");
  assert.equal(fmtTokens(812), "812");
  assert.equal(fmtTokens(1000), "1.0k");
  assert.equal(fmtCtx(8192), "8k");
  assert.equal(fmtCtx(1_000_000), "1M");
  assert.equal(fmtCtx(1_500_000), "1.5M");
  assert.equal(fmtCtx(512), "512");
  assert.equal(fmtCtx(0), "?");
});

test("toolSummary picks the salient arg per tool and truncates", () => {
  assert.equal(toolSummary("bash", JSON.stringify({ command: "echo hi" })), "echo hi");
  assert.equal(toolSummary("grep", JSON.stringify({ pattern: "TODO" })), "TODO");
  assert.equal(toolSummary("read", JSON.stringify({ path: "src/app.ts" })), "src/app.ts");
  assert.equal(toolSummary("bash", "not json"), "");
  // A no-arg tool (e.g. doctor) collapses to an empty summary rather than rendering "{}".
  assert.equal(toolSummary("doctor", "{}"), "");
  assert.equal(toolSummary("doctor", ""), "");
  assert.ok(toolSummary("bash", JSON.stringify({ command: "x".repeat(80) })).endsWith("…"));
});

test("parseCommand routes only an exact known /command, else an ordinary prompt", () => {
  const known = new Set(["/clear", "/note"]);
  assert.deepEqual(parseCommand("/clear", known), { command: "/clear", args: "" });
  assert.deepEqual(parseCommand("/note  hi there ", known), { command: "/note", args: "hi there" });
  assert.equal(parseCommand("/unknown", known), null);
  assert.equal(parseCommand("hello", known), null);
});

test("parseBangShell triggers only on a RAW leading ! with a non-empty command (D-082)", () => {
  assert.deepEqual(parseBangShell("!git status"), { command: "git status" });
  // The command is trimmed of surrounding whitespace.
  assert.deepEqual(parseBangShell("!  ls -la  "), { command: "ls -la" });
  // A lone `!` (the inert "empty bang" state) and a whitespace-only command publish nothing.
  assert.equal(parseBangShell("!"), null);
  assert.equal(parseBangShell("!   "), null);
  // A space BEFORE the bang is an ordinary prompt, not the shell lane (raw-first-char rule).
  assert.equal(parseBangShell(" !ls"), null);
  // A slash, plain text, and empty draft are never the shell lane.
  assert.equal(parseBangShell("/doctor"), null);
  assert.equal(parseBangShell("explain !important"), null);
  assert.equal(parseBangShell(""), null);
});

test("the shell and command lanes never overlap: a ! draft is shell, a / draft is command", () => {
  // Submit routing precedence (App.onSubmit): a raw leading `!` is the shell lane and never reaches
  // the command/prompt path; a `/` is the command lane and is never a bang.
  const known = new Set(["/doctor"]);
  assert.ok(parseBangShell("!echo hi"));
  assert.equal(parseCommand("!echo hi", known), null);
  assert.equal(parseBangShell("/doctor"), null);
  assert.deepEqual(parseCommand("/doctor", known), { command: "/doctor", args: "" });
});

test("providerModelsFrom / defaultProviderFrom / commandsFrom take the latest host.online", () => {
  assert.deepEqual(providerModelsFrom([]), {});
  const events = [online("h1"), online("h1", { default: "gpt", models: {} })];
  assert.deepEqual(providerModelsFrom(events), {}); // latest wins (second announced empty)
  assert.equal(defaultProviderFrom(events), "gpt");
  const commands = commandsFrom([online("h1")]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "/clear");
});

test("isSessionArchived reflects the latest session.archived event (D-094)", () => {
  assert.equal(isSessionArchived([]), false, "no archive event -> not archived");
  assert.equal(
    isSessionArchived([evt("session.archived", { archived: true })]),
    true,
    "an archive event marks it archived",
  );
  assert.equal(
    isSessionArchived([
      evt("session.archived", { archived: true }),
      evt("session.archived", { archived: false }),
    ]),
    false,
    "the latest event wins: an unarchive clears it",
  );
});

test("latestSessionSwitch returns the newest host-authored session target", () => {
  assert.equal(latestSessionSwitch([]), null);
  assert.equal(
    latestSessionSwitch([
      evt("session.switch", { sessionId: "trevor-20260626-010203z-aaaaaaaa", reason: "clear" }),
      evt("session.switch", { sessionId: "trevor-20260626-010204z-bbbbbbbb", reason: "clear" }),
    ]),
    "trevor-20260626-010204z-bbbbbbbb",
  );
});

test("latestSessionSwitch ignores replayed handoffs when scoped after replay", () => {
  const historical = evt("session.switch", {
    sessionId: "opchain-20260626-112204z-8d63eb6b",
    reason: "cd",
  });
  const live = evt("session.switch", {
    sessionId: "opchain-20260626-125838z-34a7fc20",
    reason: "cd",
  });

  assert.equal(latestSessionSwitch([historical], { afterSeq: historical.seq }), null);
  assert.equal(
    latestSessionSwitch([historical, live], { afterSeq: historical.seq }),
    "opchain-20260626-125838z-34a7fc20",
  );
});

test("tasksFrom returns the latest checklist snapshot", () => {
  const snap = tasksFrom([
    evt("tasks.current", { tasks: [{ id: "t1", subject: "do it", status: "pending" }] }),
  ]);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]?.subject, "do it");
  assert.equal(snap[0]?.status, "pending");
  assert.deepEqual(tasksFrom([]), []);
});

test("hostStatus (live presence): present with the live leader, others are standbys", () => {
  const events = [online("h1"), evt("host.role", { instanceId: "h1", role: HOST_ROLE.leader })];
  const presence = (...ids: string[]): HostPresence[] =>
    ids.map((instanceId) => ({ instanceId, participantId: instanceId, displayName: instanceId }));

  const solo = hostStatus(events, presence("h1"), Date.now());
  assert.equal(solo.present, true);
  assert.equal(solo.leaderId, "h1");
  assert.equal(solo.standbyCount, 0);
  assert.equal(solo.workspace, "/ws");
  assert.equal(solo.cwd, "/cwd");
  assert.equal(solo.branch, "main");

  const withStandby = hostStatus(events, presence("h1", "h2"), Date.now());
  assert.equal(withStandby.standbyCount, 1);

  // A leader that is no longer in the live set is not reported as the leader.
  assert.equal(hostStatus(events, presence("h2"), Date.now()).leaderId, null);
});

test("hostStatus folds the structured git status from host.online (D-088)", () => {
  const git = {
    branch: "feat/x",
    detached: null,
    dirty: true,
    ahead: 2,
    behind: 0,
    upstream: true,
    worktree: false,
  };
  const events = [online("h1", { git })];
  const presence = (...ids: string[]): HostPresence[] =>
    ids.map((instanceId) => ({ instanceId, participantId: instanceId, displayName: instanceId }));
  const status = hostStatus(events, presence("h1"), Date.now());
  assert.deepEqual(status.git, git);

  // A host without a git field (non-git cwd / older host) leaves git null.
  assert.equal(hostStatus([online("h1")], presence("h1"), Date.now()).git, null);
});

test("hostStatus (no live presence): latches present from host.online, leader from role", () => {
  const at = "2026-06-25T12:00:00.000Z";
  const events = [
    online("h1", {}),
    { ...evt("host.role", { instanceId: "h1", role: HOST_ROLE.leader }), createdAt: at },
  ];
  const status = hostStatus(events, null, Date.parse(at) + 1000);
  assert.equal(status.present, true);
  assert.equal(status.leaderId, "h1");
});

/**
 * pendingQuestionFrom (M5): the live ask_user surface reads this to know which question, if any, is
 * open. A requested is pending until a resolved with the same questionId arrives.
 */
const QUESTION: ProviderQuestionContract = {
  schemaVersion: 1,
  questions: [
    {
      id: "q1",
      question: "Pick one?",
      answerShape: "free_text",
      multiSelect: false,
      requiresReason: false,
      allowDefer: false,
      choices: [],
    },
  ],
};
const requested = (questionId: string) =>
  evt("provider.question.requested", {
    questionId,
    runId: "r1",
    toolCallId: "tc1",
    toolName: "ask_user",
    adapter: "ask_user",
    contract: QUESTION,
  });
const resolved = (questionId: string) =>
  evt("provider.question.resolved", {
    questionId,
    runId: "r1",
    toolCallId: "tc1",
    outcome: "answered",
    summary: "Answered 1 question",
  });

test("pendingQuestionFrom returns the latest unresolved question with its contract", () => {
  const pending = pendingQuestionFrom([requested("a")]);
  assert.equal(pending?.questionId, "a");
  assert.deepEqual(pending?.contract, QUESTION);
});

test("pendingQuestionFrom is null once the question is resolved", () => {
  assert.equal(pendingQuestionFrom([requested("a"), resolved("a")]), null);
});

test("pendingQuestionFrom skips a resolved question and returns a later unresolved one", () => {
  const pending = pendingQuestionFrom([requested("a"), resolved("a"), requested("b")]);
  assert.equal(pending?.questionId, "b");
});

test("pendingQuestionFrom is null when there are no questions", () => {
  assert.equal(pendingQuestionFrom([]), null);
});

/**
 * detectOrphanedTurn: the web stall guard's firing policy. It recovers an in-flight turn ONLY when no
 * leader host can ever finish it, the browser has a live replayed view, and the log has been silent
 * past the grace window. Each test pins one of those guards.
 */
const AT = "2026-06-25T00:00:00.000Z";
const inFlight = () => [
  evt("user.message", { text: "hi" }, AT),
  evt("assistant.started", { runId: "r1" }, AT),
];

test("detectOrphanedTurn recovers an in-flight turn when no leader can finish it", () => {
  const now = Date.parse(AT) + 20_000;
  const orphan = detectOrphanedTurn(inFlight(), {
    leaderPresent: false,
    connected: true,
    now,
    graceMs: 12_000,
  });
  assert.deepEqual(orphan, { runId: "r1", silentMs: 20_000 });
});

test("detectOrphanedTurn stays out while a leader host is connected (its turn to finish)", () => {
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    detectOrphanedTurn(inFlight(), { leaderPresent: true, connected: true, now, graceMs: 12_000 }),
    null,
  );
});

test("detectOrphanedTurn stays out while the browser is disconnected or replaying", () => {
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    detectOrphanedTurn(inFlight(), {
      leaderPresent: false,
      connected: false,
      now,
      graceMs: 12_000,
    }),
    null,
  );
});

test("detectOrphanedTurn waits out the grace window so a reconnecting host reconciles first", () => {
  const now = Date.parse(AT) + 5_000; // under the 12s grace
  assert.equal(
    detectOrphanedTurn(inFlight(), { leaderPresent: false, connected: true, now, graceMs: 12_000 }),
    null,
  );
});

test("detectOrphanedTurn does not fire for a completed turn", () => {
  const events = [...inFlight(), evt("assistant.completed", { runId: "r1", text: "done" }, AT)];
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    detectOrphanedTurn(events, { leaderPresent: false, connected: true, now, graceMs: 12_000 }),
    null,
  );
});

test("detectOrphanedTurn does not fire on an idle session with no in-flight turn", () => {
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    detectOrphanedTurn([evt("user.message", { text: "hi" }, AT)], {
      leaderPresent: false,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    null,
  );
});

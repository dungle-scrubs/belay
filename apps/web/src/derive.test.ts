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
  isHostlessPendingPrompt,
  isSessionArchived,
  lastUserModelFrom,
  latestSessionSwitch,
  parseBangShell,
  parseCommand,
  pendingHandoffFrom,
  pendingQuestionFrom,
  providerModelsFrom,
  summarizeProviderQuestion,
  tasksFrom,
  tasksStale,
  toolSummary,
  vimEnabledFrom,
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

test("vimEnabledFrom reflects the latest host.online preference (plan 06), false with no host", () => {
  assert.equal(vimEnabledFrom([]), false, "no host announced -> Vim mode off");
  assert.equal(vimEnabledFrom([online("h1")]), false, "host announced no preference -> off");
  assert.equal(vimEnabledFrom([online("h1", { vimEnabled: true })]), true);
  // Latest host.online wins (the host re-announces when the preference changes).
  assert.equal(
    vimEnabledFrom([online("h1", { vimEnabled: true }), online("h1", { vimEnabled: false })]),
    false,
  );
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

// M2 characterization: with no freshness metadata, every tasks.current shares the legacy revision,
// so the latest one in the event array wins. This documents the tie behavior the M7 freshness change
// must preserve for legacy logs while still rejecting an out-of-order STALE snapshot.
test("tasksFrom: among legacy (rev-less) snapshots, the latest array entry wins", () => {
  const snap = tasksFrom([
    evt("tasks.current", { tasks: [{ id: "t1", subject: "old", status: "pending" }] }),
    evt("tasks.current", { tasks: [{ id: "t1", subject: "new", status: "in_progress" }] }),
  ]);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]?.subject, "new");
  assert.equal(snap[0]?.status, "in_progress");
});

// M7: a stale snapshot (lower revision) arriving AFTER a fresher one must not overwrite it.
test("tasksFrom ignores a stale snapshot that follows a fresher one in the event list", () => {
  const snap = tasksFrom([
    evt("tasks.current", {
      tasks: [{ id: "t1", subject: "fresh", status: "in_progress" }],
      rev: 5,
    }),
    evt("tasks.current", { tasks: [{ id: "t1", subject: "stale", status: "pending" }], rev: 2 }),
  ]);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]?.subject, "fresh");
  assert.equal(snap[0]?.status, "in_progress");
});

// M7: equal revisions tie to the later arrival (deterministic), matching the legacy latest-wins rule.
test("tasksFrom: a same-revision tie resolves to the later event", () => {
  const snap = tasksFrom([
    evt("tasks.current", { tasks: [{ id: "t1", subject: "first", status: "pending" }], rev: 3 }),
    evt("tasks.current", { tasks: [{ id: "t1", subject: "second", status: "completed" }], rev: 3 }),
  ]);
  assert.equal(snap[0]?.subject, "second");
  assert.equal(snap[0]?.status, "completed");
});

// M7: a fresher snapshot anywhere in the log wins even if a lower-rev event is last.
test("tasksFrom picks the highest revision regardless of array position", () => {
  const snap = tasksFrom([
    evt("tasks.current", { tasks: [{ id: "t1", subject: "low", status: "pending" }], rev: 1 }),
    evt("tasks.current", { tasks: [{ id: "t1", subject: "high", status: "in_progress" }], rev: 9 }),
    evt("tasks.current", { tasks: [{ id: "t1", subject: "mid", status: "completed" }], rev: 4 }),
  ]);
  assert.equal(snap[0]?.subject, "high");
});

// 09.1: the checklist is "stale" when the user spoke after the model last touched it (it may have
// moved on to a new topic) - the soft signal behind the panel's stale badge + dismiss nudge.
const task = (status: string) =>
  evt("tasks.current", { tasks: [{ id: "t1", subject: "do it", status }], rev: 1 });
const userMsg = () => evt("user.message", { text: "now do something else" });

test("tasksStale: a user message after the latest tasks.current marks it stale", () => {
  assert.equal(tasksStale([task("in_progress"), userMsg()]), true);
});

test("tasksStale: a checklist updated after the user's message is fresh", () => {
  // The model answered and updated the list in the same turn - not stale.
  assert.equal(tasksStale([userMsg(), task("in_progress")]), false);
});

test("tasksStale: no checklist (or an empty/cleared one) is never stale", () => {
  assert.equal(tasksStale([userMsg()]), false, "no tasks.current at all");
  assert.equal(
    tasksStale([evt("tasks.current", { tasks: [], rev: 2 }), userMsg()]),
    false,
    "a cleared (empty) checklist is not stale - the panel already hides",
  );
});

// 09.1: a session inherits the model/effort from its last user turn (a handoff stamps it on the first
// prompt), so the picker doesn't fall back to the host default on a fresh handoff target.
test("lastUserModelFrom returns the most recent user-message model + effort", () => {
  assert.equal(lastUserModelFrom([]), null, "no user turn yet -> null");

  const got = lastUserModelFrom([
    evt("user.message", {
      text: "audit this",
      provider: "zai",
      model: { sourceId: "zai", modelId: "glm-5.2", reasoning: "high" },
      reasoning: "high",
    }),
    evt("assistant.completed", { runId: "r1" }),
  ]);
  assert.equal(got?.provider, "zai");
  assert.equal(got?.reasoning, "high");
  assert.equal(got?.model?.modelId, "glm-5.2");
});

test("lastUserModelFrom takes the LATEST user message that carries a provider", () => {
  assert.equal(
    lastUserModelFrom([
      evt("user.message", { text: "first", provider: "qwen" }),
      evt("user.message", { text: "second", provider: "minimax" }),
    ])?.provider,
    "minimax",
  );
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
 * pendingHandoffFrom (02.10): the generate-mode handoff lifecycle the approval surface reads to show a
 * generating spinner, then the draft with approve/edit/reject, then disappear once it resolves.
 */
const hgenerating = (id: string) => evt("handoff.generating", { handoffId: id });
const hgenerated = (id: string, prompt: string) =>
  evt("handoff.generated", { handoffId: id, prompt });

test("pendingHandoffFrom reports generating, then the generated draft", () => {
  assert.deepEqual(pendingHandoffFrom([hgenerating("h1")]), {
    status: "generating",
    handoffId: "h1",
  });
  assert.deepEqual(pendingHandoffFrom([hgenerating("h1"), hgenerated("h1", "do the work")]), {
    status: "generated",
    handoffId: "h1",
    prompt: "do the work",
  });
});

for (const terminal of [
  "handoff.approved",
  "handoff.rejected",
  "handoff.failed",
  "handoff.accepted",
]) {
  test(`pendingHandoffFrom clears once ${terminal} arrives`, () => {
    const events = [
      hgenerating("h1"),
      hgenerated("h1", "do the work"),
      evt(terminal, { handoffId: "h1", code: "x", targetSessionId: "t", prompt: "p" }),
    ];
    assert.equal(pendingHandoffFrom(events), null);
  });
}

test("pendingHandoffFrom ignores direct-mode handoffs (no generating/generated)", () => {
  const events = [
    evt("handoff.requested", {
      handoffId: "h1",
      mode: "direct",
      sourceSessionId: "s",
      prompt: "p",
    }),
    evt("handoff.accepted", { handoffId: "h1", targetSessionId: "t", prompt: "p" }),
  ];
  assert.equal(pendingHandoffFrom(events), null);
});

test("pendingHandoffFrom is null with no handoff events", () => {
  assert.equal(pendingHandoffFrom([]), null);
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

// --- summarizeProviderQuestion (02.7): pair request + answer + resolved into a slim view ---

const freeText = (id: string, question: string): ProviderQuestionContract["questions"][number] => ({
  id,
  question,
  answerShape: "free_text",
  multiSelect: false,
  requiresReason: false,
  allowDefer: false,
  choices: [],
});

test("summarizeProviderQuestion pairs each question with its answer by id", () => {
  const view = summarizeProviderQuestion({
    contract: {
      schemaVersion: 1,
      questions: [freeText("db", "Database?"), freeText("orm", "ORM?")],
    },
    answer: {
      action: "accept",
      answer: "Postgres + Drizzle",
      questions: [
        { id: "orm", answer: "Drizzle" },
        { id: "db", answer: "Postgres" },
      ],
    },
    outcome: "answered",
    summary: "Answered",
  });
  assert.equal(view.outcome, "answered");
  assert.deepEqual(view.items, [
    { id: "db", question: "Database?", answer: "Postgres" },
    { id: "orm", question: "ORM?", answer: "Drizzle" },
  ]);
  assert.equal(view.summary, "Postgres + Drizzle", "the accept's combined summary is the headline");
});

test("summarizeProviderQuestion falls back to the resolved summary when the answer is missing", () => {
  const view = summarizeProviderQuestion({
    contract: { schemaVersion: 1, questions: [freeText("x", "Which?")] },
    answer: undefined,
    outcome: "expired",
    summary: "Expired before an answer",
  });
  assert.deepEqual(view.items, [{ id: "x", question: "Which?", answer: "" }]);
  assert.equal(view.summary, "Expired before an answer");
});

test("summarizeProviderQuestion falls back to an outcome label when contract and summary are absent", () => {
  const view = summarizeProviderQuestion({ outcome: "cancelled", summary: "" });
  assert.deepEqual(view.items, []);
  assert.equal(view.summary, "Cancelled");
});

test("summarizeProviderQuestion leaves answers blank for a decline (no per-question content)", () => {
  const view = summarizeProviderQuestion({
    contract: { schemaVersion: 1, questions: [freeText("x", "Proceed?")] },
    answer: { action: "decline" },
    outcome: "declined",
    summary: "Declined",
  });
  assert.deepEqual(view.items, [{ id: "x", question: "Proceed?", answer: "" }]);
  assert.equal(view.summary, "Declined");
});

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

/**
 * isHostlessPendingPrompt (02.14): the disjoint twin of detectOrphanedTurn. A prompt published with no
 * host gets no assistant.started, so the orphan guard (which needs an in-flight runId) stays silent and
 * the busy derivation would spin "Working" forever. This helper recognizes that exact state so the UI
 * can drop the fake spinner for the no-host affordance. The host's reattach catch-up still runs the
 * queued prompt - this is presentation only.
 */
const hostlessPrompt = () => [evt("user.message", { text: "do the thing" }, AT)];

test("fires for a trailing prompt with no host, where the orphan guard is silent (the gap)", () => {
  const now = Date.parse(AT) + 20_000;
  const check = { leaderPresent: false, connected: true, now, graceMs: 12_000 };
  // The orphan guard cannot help (no started run), yet the prompt is stranded:
  assert.equal(detectOrphanedTurn(hostlessPrompt(), check), null);
  assert.equal(isHostlessPendingPrompt(hostlessPrompt(), check), true);
});

test("fires after a completed prior turn leaves a fresh unanswered prompt with no host", () => {
  const events = [
    evt("user.message", { text: "first" }, AT),
    evt("assistant.started", { runId: "r1" }, AT),
    evt("assistant.completed", { runId: "r1", text: "done" }, AT),
    evt("user.message", { text: "second, hostless" }, AT),
  ];
  const now = Date.parse(AT) + 20_000;
  assert.equal(
    isHostlessPendingPrompt(events, {
      leaderPresent: false,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    true,
  );
});

test("stays FALSE while a leader is present (a genuinely slow turn still reads Working)", () => {
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    isHostlessPendingPrompt(hostlessPrompt(), {
      leaderPresent: true,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    false,
  );
});

test("stays FALSE before the grace window elapses", () => {
  const now = Date.parse(AT) + 5_000; // under 12s
  assert.equal(
    isHostlessPendingPrompt(hostlessPrompt(), {
      leaderPresent: false,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    false,
  );
});

test("stays FALSE while a run is actually in flight (disjoint from detectOrphanedTurn)", () => {
  const now = Date.parse(AT) + 60_000;
  // inFlight() has a started-but-uncompleted run -> that's the orphan guard's job, not this.
  assert.equal(
    isHostlessPendingPrompt(inFlight(), {
      leaderPresent: false,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    false,
  );
});

test("stays FALSE on an answered, idle session (newest turn is a completion)", () => {
  const events = [...inFlight(), evt("assistant.completed", { runId: "r1", text: "done" }, AT)];
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    isHostlessPendingPrompt(events, {
      leaderPresent: false,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    false,
  );
});

test("stays FALSE while the browser is disconnected or replaying", () => {
  const now = Date.parse(AT) + 60_000;
  assert.equal(
    isHostlessPendingPrompt(hostlessPrompt(), {
      leaderPresent: false,
      connected: false,
      now,
      graceMs: 12_000,
    }),
    false,
  );
});

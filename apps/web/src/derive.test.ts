import assert from "node:assert/strict";
import {
  type CommandSpec,
  HOST_ROLE,
  type HostPresence,
  type ProviderQuestionContract,
  type SessionEvent,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import {
  commandArgPreview,
  commandsFrom,
  defaultProviderFrom,
  detectOrphanedSubagents,
  detectOrphanedTurn,
  fmtCtx,
  fmtTokens,
  hostAnnouncement,
  hostStatus,
  isHostlessPendingPrompt,
  isSessionArchived,
  isTurnActive,
  jobsFrom,
  lastUserModelFrom,
  latestSessionSwitch,
  modelPrefsFrom,
  parseBangShell,
  parseCommand,
  pendingHandoffFrom,
  pendingQuestionFrom,
  providerModelsFrom,
  resolveKnownRoot,
  summarizeProviderQuestion,
  tasksFrom,
  tasksStale,
  toolSummary,
  turnStatusHeaderFrom,
  unreconciledSubagents,
  vimEnabledFrom,
} from "./derive";

/**
 * The pure view-model selectors over the session event log (derive.ts). They fold raw
 * SessionEvent[] into the shapes app.tsx renders, so a fold bug shows as a wrong transcript,
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

test("toolSummary: a non-string salient field collapses to empty, never the raw args JSON", () => {
  // write is keyed on `path` (the default salientToolArg branch); a malformed/mid-stream call
  // missing `path` but carrying other populated fields (e.g. `content`) must NOT fall back to
  // dumping the whole args blob - that would leak file content into anything that renders this
  // summary (a tool row header, a compact-row line, an action-shimmer running label).
  const leaky = toolSummary("write", JSON.stringify({ content: "SECRET_TOKEN=hunter2" }));
  assert.equal(leaky, "");
  assert.doesNotMatch(leaky, /SECRET_TOKEN|hunter2/);

  const editLeaky = toolSummary(
    "edit",
    JSON.stringify({ old: "const a = 1;", new: "const a = 2;" }),
  );
  assert.equal(editLeaky, "");
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
  assert.deepEqual(providerModelsFrom(null), {});
  const events = [online("h1"), online("h1", { default: "gpt", models: {} })];
  const announcement = hostAnnouncement(events);
  assert.deepEqual(providerModelsFrom(announcement), {}); // latest wins (second announced empty)
  assert.equal(defaultProviderFrom(announcement), "gpt");
  const commands = commandsFrom(hostAnnouncement([online("h1")]));
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "/clear");
});

test("vimEnabledFrom reflects the latest host.online preference (plan 06), false with no host", () => {
  assert.equal(vimEnabledFrom(null), false, "no host announced -> Vim mode off");
  assert.equal(
    vimEnabledFrom(hostAnnouncement([online("h1")])),
    false,
    "host announced no preference -> off",
  );
  assert.equal(vimEnabledFrom(hostAnnouncement([online("h1", { vimEnabled: true })])), true);
  // Latest host.online wins (the host re-announces when the preference changes).
  assert.equal(
    vimEnabledFrom(
      hostAnnouncement([online("h1", { vimEnabled: true }), online("h1", { vimEnabled: false })]),
    ),
    false,
  );
});

test("modelPrefsFrom reads the host default + favorites, empty with no host / older host (plan 51)", () => {
  assert.deepEqual(
    modelPrefsFrom(null),
    { default: null, pinned: [] },
    "no host -> no default/favorites",
  );
  assert.deepEqual(
    modelPrefsFrom(hostAnnouncement([online("h1")])),
    { default: null, pinned: [] },
    "host omitted the field (older host) -> empty preference, not a crash",
  );
  const def = { sourceId: "zai", modelId: "glm-5.2", reasoning: "high" };
  const pin = { sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null };
  assert.deepEqual(
    modelPrefsFrom(
      hostAnnouncement([online("h1", { modelPrefs: { default: def, pinned: [pin] } })]),
    ),
    { default: def, pinned: [pin] },
  );
  // The latest host.online wins (the host re-announces after a set-default / toggle-favorite).
  assert.deepEqual(
    modelPrefsFrom(
      hostAnnouncement([
        online("h1", { modelPrefs: { default: def, pinned: [pin] } }),
        online("h1", { modelPrefs: { default: null, pinned: [] } }),
      ]),
    ),
    { default: null, pinned: [] },
  );
});

test("jobsFrom returns the latest host.online job snapshots, empty with no host (plan 09)", () => {
  assert.deepEqual(jobsFrom(null), [], "no host -> no jobs");
  const running = {
    id: "p1",
    command: "sleep 9",
    source: "bash",
    cwd: "/w",
    startedAt: 1,
    status: "running",
    exitCode: null,
    stdoutTotal: 0,
    stderrTotal: 0,
  };
  assert.equal(jobsFrom(hostAnnouncement([online("h1", { jobs: [running] })]))[0]?.id, "p1");
  // A newer host.online with the job exited supersedes the older running snapshot - no stale row.
  const live = jobsFrom(
    hostAnnouncement([
      online("h1", { jobs: [running] }),
      online("h1", { jobs: [{ ...running, status: "exited", exitCode: 0 }] }),
    ]),
  );
  assert.equal(live[0]?.status, "exited");
});

test("jobsFrom downgrades a dead host's running job to interrupted, keeps a live leader's running (D-003)", () => {
  const running = {
    id: "p1",
    command: "pnpm dev",
    source: "bash",
    cwd: "/w",
    startedAt: 1,
    status: "running",
    exitCode: null,
    stdoutTotal: 0,
    stderrTotal: 0,
  };
  const exited = { ...running, id: "p2", status: "exited", exitCode: 0 };
  const announcement = hostAnnouncement([online("h1", { jobs: [running, exited] })]);

  // The announcing host h1 is still the live leader -> its jobs render exactly as announced.
  const underLeader = jobsFrom(announcement, "h1");
  assert.equal(underLeader[0]?.status, "running");
  assert.equal(underLeader[0]?.interrupted, undefined, "a live leader's job is untouched");

  // h1 is no longer the live leader (a different host leads, or none) -> its running job is orphaned.
  for (const leaderId of ["h2", null]) {
    const stale = jobsFrom(announcement, leaderId);
    assert.equal(stale[0]?.interrupted, true, "the dead host's running job is interrupted");
    assert.equal(
      stale[1]?.interrupted,
      undefined,
      "an already-terminal (exited) job is left alone",
    );
  }

  // The default (single-arg) path assumes the announcer is live, so no downgrade (preserves callers).
  assert.equal(jobsFrom(announcement)[0]?.interrupted, undefined);
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
 * detectOrphanedSubagents (plan 52 / D-001): the subagent mirror of detectOrphanedTurn. A background
 * child OUTLIVES its spawning turn, so its terminal `delegated.to` can be lost independently of any turn
 * reconcile; the browser closes such an orphan only under the SAME conservative gate as the turn path.
 */
const delegated = (childSessionId: string, status: string, extra: Record<string, unknown> = {}) =>
  evt(
    "delegated.to",
    {
      runId: "r1",
      childSessionId,
      agent: "explorer",
      task: "scan",
      mode: "background",
      status,
      ...extra,
    },
    AT,
  );
const withRunningChild = () => [
  evt("user.message", { text: "audit the repo" }, AT),
  evt("assistant.completed", { runId: "r1", text: "started it in the background" }, AT),
  delegated("s::sub::bg", "running"),
];

test("detectOrphanedSubagents returns an orphaned running child when no leader can fold it back", () => {
  const now = Date.parse(AT) + 20_000;
  const orphans = detectOrphanedSubagents(withRunningChild(), {
    leaderPresent: false,
    connected: true,
    now,
    graceMs: 12_000,
  });
  assert.deepEqual(orphans, [
    {
      childSessionId: "s::sub::bg",
      runId: "r1",
      agent: "explorer",
      task: "scan",
      mode: "background",
    },
  ]);
});

test("detectOrphanedSubagents stays out while a leader is present (its child to finish)", () => {
  const now = Date.parse(AT) + 60_000;
  assert.deepEqual(
    detectOrphanedSubagents(withRunningChild(), {
      leaderPresent: true,
      connected: true,
      now,
      graceMs: 12_000,
    }),
    [],
  );
});

test("detectOrphanedSubagents stays out while disconnected or within the grace window", () => {
  assert.deepEqual(
    detectOrphanedSubagents(withRunningChild(), {
      leaderPresent: false,
      connected: false,
      now: Date.parse(AT) + 60_000,
      graceMs: 12_000,
    }),
    [],
    "disconnected -> the view may be partial, so never reconcile",
  );
  assert.deepEqual(
    detectOrphanedSubagents(withRunningChild(), {
      leaderPresent: false,
      connected: true,
      now: Date.parse(AT) + 5_000,
      graceMs: 12_000,
    }),
    [],
    "under grace -> a reconnecting host reconciles its own child first",
  );
});

test("detectOrphanedSubagents ignores a child already closed by any terminal link (done/interrupted)", () => {
  const now = Date.parse(AT) + 20_000;
  const check = { leaderPresent: false, connected: true, now, graceMs: 12_000 } as const;
  // A done fold-back closes the link.
  assert.deepEqual(
    detectOrphanedSubagents(
      [...withRunningChild(), delegated("s::sub::bg", "done", { result: "found 3 TODOs" })],
      check,
    ),
    [],
  );
  // An already-interrupted link is terminal too (idempotent with the host reap - no re-detect).
  assert.deepEqual(
    detectOrphanedSubagents([...withRunningChild(), delegated("s::sub::bg", "interrupted")], check),
    [],
  );
});

test("unreconciledSubagents drops children already in the reconciled set (once-per-child guard)", () => {
  const now = Date.parse(AT) + 20_000;
  const detected = detectOrphanedSubagents(
    [...withRunningChild(), delegated("s::sub::two", "running")],
    { leaderPresent: false, connected: true, now, graceMs: 12_000 },
  );
  assert.equal(detected.length, 2, "two orphaned children fanned out");
  // The app's reconciledSubagentRef already published one; only the untouched child remains.
  const pending = unreconciledSubagents(detected, new Set(["s::sub::bg"]));
  assert.deepEqual(
    pending.map((o) => o.childSessionId),
    ["s::sub::two"],
  );
  // Once both are reconciled, nothing is left to publish (fires at most once per childSessionId).
  assert.deepEqual(unreconciledSubagents(detected, new Set(["s::sub::bg", "s::sub::two"])), []);
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

// resolveKnownRoot (plan 44.3 M1.5): the one place the picker and the session-view "start host" agree on
// where a session launches, folding the log, the inventory, and projects.json in priority order.

test("resolveKnownRoot prefers the viewed host's workspace, then its cwd", () => {
  assert.equal(resolveKnownRoot({ host: { workspace: "/ws", cwd: "/cwd" } }), "/ws");
  assert.equal(resolveKnownRoot({ host: { workspace: null, cwd: "/cwd" } }), "/cwd");
});

test("resolveKnownRoot falls back to the inventory summary, then the projects mapping", () => {
  const noHost = { workspace: null, cwd: null };
  assert.equal(
    resolveKnownRoot({ host: noHost, summary: { workspace: "/sum-ws", cwd: null } }),
    "/sum-ws",
    "a stale/never-loaded log falls back to the inventory summary workspace",
  );
  assert.equal(
    resolveKnownRoot({ host: noHost, summary: { workspace: null, cwd: "/sum-cwd" } }),
    "/sum-cwd",
    "then the summary cwd",
  );
  assert.equal(
    resolveKnownRoot({ host: noHost, project: { root: "/proj-root" } }),
    "/proj-root",
    "then the projects.json root",
  );
});

test("resolveKnownRoot is null when no source knows the root (keeps the plain no-host hint)", () => {
  assert.equal(resolveKnownRoot({ host: { workspace: null, cwd: null } }), null);
});

// --- plan 50: turnStatusHeaderFrom - the pinned live turn-status header projection ---

const userMessage = () => evt("user.message", { text: "do it" });
const started = (runId: string, over: Record<string, unknown> = {}) =>
  evt("assistant.started", { runId, warm: true, model: "qwen", ...over });
const progress = (runId: string, output: number) =>
  evt("assistant.progress", { runId, usage: { output } });
const completed = (runId: string) => evt("assistant.completed", { runId, text: "done" });
const taskEvent = (activeForm: string, subject: string, status = "in_progress") =>
  evt("tasks.current", { tasks: [{ id: "t1", subject, activeForm, status }], rev: 1 });

test("turnStatusHeaderFrom is undefined when no turn is active", () => {
  assert.equal(turnStatusHeaderFrom([], { awaitingResponse: false }), undefined);
  assert.equal(
    turnStatusHeaderFrom([userMessage(), started("r1"), completed("r1")], {
      awaitingResponse: false,
    }),
    undefined,
    "a settled turn pins nothing",
  );
});

test("turnStatusHeaderFrom: an in-progress task drives the headline from its activeForm", () => {
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      progress("r1", 340),
      taskEvent("Adding schemas and tests…", "Add schemas and tests"),
    ],
    { awaitingResponse: false },
  );
  assert.equal(header?.headline, "Adding schemas and tests…");
  // The engine state is the distinct HOW (a warm, silent turn -> thinking), kept separate from the WHAT.
  assert.equal(header?.state, "thinking");
  assert.equal(header?.outputTokens, 340);
  assert.ok(header?.startedAt, "the active run's start time drives the elapsed cell");
});

test("turnStatusHeaderFrom: with no task the headline falls back to the engine turnActionLabel", () => {
  const header = turnStatusHeaderFrom([userMessage(), started("r1")], { awaitingResponse: false });
  assert.equal(header?.headline, "thinking");
  assert.equal(header?.state, "thinking");
});

test("turnStatusHeaderFrom: a running inline delegation reads 'delegating to {agent}…', never the tool verb (09.4 M5)", () => {
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      evt("tool.started", { runId: "r1", callId: "c1", name: "delegate_inline", arguments: "{}" }),
      evt("delegated.to", {
        runId: "r1",
        childSessionId: "s::sub::a",
        agent: "explorer",
        task: "search",
        mode: "inline",
        status: "running",
      }),
    ],
    { awaitingResponse: false },
  );
  assert.equal(header?.state, "delegating to explorer…");
  assert.equal(
    header?.headline,
    "delegating to explorer…",
    "no task -> the headline is the delegation state",
  );
  assert.doesNotMatch(header?.state ?? "", /delegate_inline/);
});

test("turnStatusHeaderFrom: background-delegation start gets the same friendly headline (09.4 M5)", () => {
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      evt("tool.started", {
        runId: "r1",
        callId: "c1",
        name: "delegate_background",
        arguments: "{}",
      }),
      evt("delegated.to", {
        runId: "r1",
        childSessionId: "s::sub::bg",
        agent: "auditor",
        task: "scan",
        mode: "background",
        status: "running",
      }),
    ],
    { awaitingResponse: false },
  );
  assert.equal(header?.state, "delegating to auditor…");
});

test("turnStatusHeaderFrom: the delegating headline clears once the only child folds back (09.4 M5)", () => {
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      evt("tool.started", { runId: "r1", callId: "c1", name: "delegate_inline", arguments: "{}" }),
      evt("delegated.to", {
        runId: "r1",
        childSessionId: "s::sub::a",
        agent: "explorer",
        task: "t",
        mode: "inline",
        status: "running",
      }),
      evt("delegated.to", {
        runId: "r1",
        childSessionId: "s::sub::a",
        agent: "explorer",
        task: "t",
        mode: "inline",
        status: "done",
        result: "ok",
      }),
    ],
    { awaitingResponse: false },
  );
  // The delegation is terminal but the turn is still in flight, so the header no longer says
  // "delegating…" and never regresses to a raw delegate_inline tool verb.
  assert.notEqual(header?.state, "delegating to explorer…");
  assert.doesNotMatch(header?.state ?? "", /delegate_inline/);
});

test("turnStatusHeaderFrom: a running tool with no task drives a tool-verb headline", () => {
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      evt("tool.started", {
        runId: "r1",
        callId: "c1",
        name: "read",
        arguments: JSON.stringify({ path: "src/foo.ts" }),
      }),
    ],
    { awaitingResponse: false },
  );
  assert.equal(header?.headline, "reading src/foo.ts");
  assert.equal(header?.state, "reading src/foo.ts");
});

test("turnStatusHeaderFrom: a completed tool no longer drives the headline", () => {
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      evt("tool.started", { runId: "r1", callId: "c1", name: "read", arguments: "{}" }),
      evt("tool.completed", { runId: "r1", callId: "c1", name: "read", result: "ok" }),
    ],
    { awaitingResponse: false },
  );
  // No tool is mid-flight now, so the engine phase carries the state again.
  assert.equal(header?.state, "thinking");
  assert.equal(header?.headline, "thinking");
});

test("turnStatusHeaderFrom: output tokens come from the newest assistant.progress snapshot", () => {
  const header = turnStatusHeaderFrom(
    [userMessage(), started("r1"), progress("r1", 100), progress("r1", 340)],
    { awaitingResponse: false },
  );
  assert.equal(header?.outputTokens, 340);
});

test("turnStatusHeaderFrom: output tokens never decrease within a turn (monotonic clamp, R-3)", () => {
  // An advisory progress snapshot reporting FEWER output tokens than a prior one must not regress the
  // cell (D-002/R-3): the header clamps to the max seen in the live turn.
  const header = turnStatusHeaderFrom(
    [userMessage(), started("r1"), progress("r1", 340), progress("r1", 200)],
    { awaitingResponse: false },
  );
  assert.equal(header?.outputTokens, 340);
});

test("turnStatusHeaderFrom: the token cell is absent until the first progress snapshot", () => {
  const header = turnStatusHeaderFrom([userMessage(), started("r1")], { awaitingResponse: false });
  assert.equal(header?.outputTokens, undefined);
});

test("turnStatusHeaderFrom is undefined after assistant.completed", () => {
  const header = turnStatusHeaderFrom(
    [userMessage(), started("r1"), progress("r1", 340), completed("r1")],
    { awaitingResponse: false },
  );
  assert.equal(header, undefined);
});

test("turnStatusHeaderFrom: a /clear mid-turn does not leak the prior run's tokens into the awaiting gap", () => {
  // The pre-clear run streamed 500 tokens but never completed; after `/clear` + a fresh prompt the new
  // awaiting-gap header must not show a stale `↓ 500` (the token walk stops at `/clear`, like its siblings).
  const header = turnStatusHeaderFrom(
    [
      userMessage(),
      started("r1"),
      progress("r1", 500),
      evt("user.command", { command: "/clear", args: "" }),
      userMessage(),
    ],
    { awaitingResponse: true },
  );
  assert.equal(
    header?.outputTokens,
    undefined,
    "the pre-clear run's tokens do not leak past /clear",
  );
});

test("turnStatusHeaderFrom: the awaiting gap (no run yet) still pins a Working header", () => {
  const header = turnStatusHeaderFrom([userMessage()], { awaitingResponse: true });
  assert.equal(header?.headline, "Working");
  assert.equal(header?.outputTokens, undefined);
  assert.ok(header?.startedAt, "the trailing user.message drives the elapsed cell before the run");
});

test("isTurnActive is the shared active-turn predicate (active run OR awaiting response)", () => {
  assert.equal(isTurnActive([], false), false);
  assert.equal(isTurnActive([], true), true, "awaiting a response counts as active");
  assert.equal(isTurnActive([userMessage(), started("r1")], false), true, "a live run is active");
  assert.equal(
    isTurnActive([userMessage(), started("r1"), completed("r1")], false),
    false,
    "a settled turn is inactive",
  );
});

const FIX_SPEC: CommandSpec = {
  name: "/fix",
  summary: "fix an issue",
  argumentHint: "<issue>",
  body: "Fix issue #$0 for $ARGUMENTS",
};

test("commandArgPreview: previews the substitution past the first space (plan 44.5 M6)", () => {
  const preview = commandArgPreview("/fix 123", [FIX_SPEC]);
  assert.equal(preview?.command, "/fix");
  assert.equal(preview?.argumentHint, "<issue>");
  assert.equal(preview?.text, "Fix issue #123 for 123");
  assert.deepEqual(preview?.missing, []);
});

test("commandArgPreview: null before the first space (the slash menu still owns that region)", () => {
  assert.equal(commandArgPreview("/fix", [FIX_SPEC]), null);
});

test("commandArgPreview: null for a non-file command (no body announced)", () => {
  assert.equal(commandArgPreview("/help now", [{ name: "/help", summary: "help" }]), null);
});

test("commandArgPreview: reports a $N ref that has no arg yet as missing", () => {
  const preview = commandArgPreview("/fix ", [FIX_SPEC]);
  assert.equal(preview?.text, "Fix issue # for ");
  assert.deepEqual(preview?.missing, ["$0"]);
});

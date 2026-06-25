import assert from "node:assert/strict";
import { HOST_ROLE, type HostPresence, type SessionEvent } from "@trevor/session";
import { test } from "vitest";
import {
  activeRunId,
  commandsFrom,
  defaultProviderFrom,
  fmtCtx,
  fmtTokens,
  hostStatus,
  isOverflowError,
  parseCommand,
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
  return { sessionId: "s", seq: n, eventId: `e${n}`, producerId: "host", createdAt, type, payload };
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
    default: "qwen",
    workspace: "/ws",
    cwd: "/cwd",
    ...extra,
  });

test("activeRunId returns the latest unfinished run, else null", () => {
  assert.equal(activeRunId([]), null);
  const started = (runId: string) =>
    evt("assistant.started", { runId, warm: true, model: "m", provider: "qwen" });
  const done = (runId: string) => evt("assistant.completed", { runId, text: "ok" });
  assert.equal(activeRunId([started("r1")]), "r1");
  assert.equal(activeRunId([started("r1"), done("r1")]), null);
  assert.equal(activeRunId([started("r1"), started("r2"), done("r1")]), "r2");
});

test("a dead orphan run (started, never completed, then a later run finished) is NOT active", () => {
  const started = (runId: string) =>
    evt("assistant.started", { runId, warm: true, model: "m", provider: "qwen" });
  const done = (runId: string) => evt("assistant.completed", { runId, text: "ok" });
  // r1 started but its host crashed before completing; r2 then ran and finished. Nothing is active.
  // The old bug returned "r1" here, latching `busy` forever and freezing the send queue.
  assert.equal(activeRunId([started("r1"), started("r2"), done("r2")]), null);
});

test("a /clear resets active-run detection: a pre-clear orphan does not count", () => {
  const started = (runId: string) =>
    evt("assistant.started", { runId, warm: true, model: "m", provider: "qwen" });
  const clear = () => evt("user.command", { command: "/clear", args: "" });
  assert.equal(activeRunId([started("r1"), clear()]), null, "pre-clear orphan cleared");
  assert.equal(activeRunId([started("r1"), clear(), started("r2")]), "r2", "post-clear run counts");
});

test("fmtTokens and fmtCtx render compact counts", () => {
  assert.equal(fmtTokens(6100), "6.1k");
  assert.equal(fmtTokens(812), "812");
  assert.equal(fmtTokens(1000), "1.0k");
  assert.equal(fmtCtx(8192), "8k");
  assert.equal(fmtCtx(512), "512");
  assert.equal(fmtCtx(0), "?");
});

test("isOverflowError matches context/token-limit failures only", () => {
  assert.equal(isOverflowError("context length exceeded"), true);
  assert.equal(isOverflowError("This model's maximum context is 8192 tokens"), true);
  assert.equal(isOverflowError("token limit reached"), true);
  assert.equal(isOverflowError("ECONNREFUSED: network down"), false);
});

test("toolSummary picks the salient arg per tool and truncates", () => {
  assert.equal(toolSummary("bash", JSON.stringify({ command: "echo hi" })), "echo hi");
  assert.equal(toolSummary("grep", JSON.stringify({ pattern: "TODO" })), "TODO");
  assert.equal(toolSummary("read", JSON.stringify({ path: "src/app.ts" })), "src/app.ts");
  assert.equal(toolSummary("bash", "not json"), "");
  assert.ok(toolSummary("bash", JSON.stringify({ command: "x".repeat(80) })).endsWith("…"));
});

test("parseCommand routes only an exact known /command, else an ordinary prompt", () => {
  const known = new Set(["/clear", "/note"]);
  assert.deepEqual(parseCommand("/clear", known), { command: "/clear", args: "" });
  assert.deepEqual(parseCommand("/note  hi there ", known), { command: "/note", args: "hi there" });
  assert.equal(parseCommand("/unknown", known), null);
  assert.equal(parseCommand("hello", known), null);
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

  const withStandby = hostStatus(events, presence("h1", "h2"), Date.now());
  assert.equal(withStandby.standbyCount, 1);

  // A leader that is no longer in the live set is not reported as the leader.
  assert.equal(hostStatus(events, presence("h2"), Date.now()).leaderId, null);
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

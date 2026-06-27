import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import {
  activeSessions,
  archivedSessions,
  type InventoryRow,
  relativeTime,
  type SessionSummary,
  sortInventory,
  summarizeSession,
} from "./inventory";
import { events } from "./protocol";

let seq = 0;
function ev(
  type: string,
  payload: Record<string, unknown>,
  createdAt = "2026-06-26T00:00:00.000Z",
): SessionEvent {
  seq += 1;
  return {
    sessionId: "s",
    seq,
    eventId: `e${seq}`,
    producerId: "host",
    createdAt,
    type,
    payload,
  };
}

const hostOnlineEvent = (over: Record<string, unknown> = {}): SessionEvent =>
  ev("host.online", {
    instanceId: "h1",
    providers: ["qwen"],
    default: "qwen",
    models: {},
    cwd: "~/dev/trevorV2",
    workspace: "~/dev/trevorV2",
    commands: [],
    agents: [],
    ...over,
  });

const baseRow = (over: Partial<InventoryRow> = {}): InventoryRow => ({
  sessionId: "sess-1",
  createdAt: "2026-06-26T00:00:00.000Z",
  updatedAt: "2026-06-26T01:00:00.000Z",
  eventCount: 12,
  hostOnline: hostOnlineEvent(),
  firstUser: ev("user.message", { text: "add the resume chooser please" }),
  lifecycle: [],
  archived: null,
  hostPresent: false,
  ...over,
});

test("summarizeSession projects title, cwd/workspace, project, and counts", () => {
  const s = summarizeSession(baseRow());
  assert.equal(s.title, "add the resume chooser please");
  assert.equal(s.cwd, "~/dev/trevorV2");
  assert.equal(s.workspace, "~/dev/trevorV2");
  assert.equal(s.project, "trevorV2");
  assert.equal(s.eventCount, 12);
});

test("title falls back to the session id when there is no user message", () => {
  const s = summarizeSession(baseRow({ sessionId: "trevor-xyz", firstUser: null }));
  assert.equal(s.title, "trevor-xyz");
});

test("title truncates a long first message", () => {
  const long = "x".repeat(120);
  const s = summarizeSession(baseRow({ firstUser: ev("user.message", { text: long }) }));
  assert.ok(s.title.endsWith("…"));
  assert.ok(s.title.length <= 61);
});

test("host presence: live when a socket is present", () => {
  assert.equal(summarizeSession(baseRow({ hostPresent: true })).host, "live");
});

test("host presence: stale when a host.online exists but no socket", () => {
  assert.equal(summarizeSession(baseRow({ hostPresent: false })).host, "stale");
});

test("host presence: none when the log never had a host", () => {
  const s = summarizeSession(baseRow({ hostOnline: null, hostPresent: false }));
  assert.equal(s.host, "none");
  assert.equal(s.cwd, null);
  assert.equal(s.project, null);
});

test("git/branch carry through from the latest host.online", () => {
  const git = {
    branch: "feat/resume",
    detached: null,
    dirty: true,
    ahead: 1,
    behind: 0,
    upstream: true,
    worktree: false,
  };
  const s = summarizeSession(
    baseRow({ hostOnline: hostOnlineEvent({ branch: "feat/resume", git }) }),
  );
  assert.equal(s.branch, "feat/resume");
  assert.deepEqual(s.git, git);
});

test("activity is running for an unfinished run, settled once completed, idle when never ran", () => {
  const started = events.assistantStarted({
    runId: "r1",
    warm: true,
    model: "m",
    provider: "qwen",
  });
  const completed = events.assistantCompleted({ runId: "r1", text: "done" });
  const startedEv = ev(started.type, started.payload as Record<string, unknown>);
  const completedEv = ev(completed.type, completed.payload as Record<string, unknown>);
  assert.equal(summarizeSession(baseRow({ lifecycle: [] })).activity, "idle");
  assert.equal(summarizeSession(baseRow({ lifecycle: [startedEv] })).activity, "running");
  assert.equal(
    summarizeSession(baseRow({ lifecycle: [startedEv, completedEv] })).activity,
    "settled",
    "a finished run reads as settled, distinct from a never-ran idle session",
  );
});

test("a /clear resets activity to idle: a pre-clear orphan run and prior work do not count", () => {
  const started = events.assistantStarted({
    runId: "r1",
    warm: true,
    model: "m",
    provider: "qwen",
  });
  const completed = events.assistantCompleted({ runId: "r1", text: "done" });
  const clear = events.userCommand({ command: "/clear", args: "" });
  const lifecycle = [
    ev(started.type, started.payload as Record<string, unknown>),
    ev(completed.type, completed.payload as Record<string, unknown>),
    ev(clear.type, clear.payload as Record<string, unknown>),
  ];
  assert.equal(
    summarizeSession(baseRow({ lifecycle })).activity,
    "idle",
    "after /clear the session is idle again, not settled from the cleared work",
  );
});

test("sortInventory puts the current project first, each block by recency desc", () => {
  const mk = (id: string, project: string, updatedAt: string): SessionSummary => ({
    sessionId: id,
    title: id,
    cwd: null,
    workspace: `~/dev/${project}`,
    project,
    branch: null,
    git: null,
    createdAt: updatedAt,
    updatedAt,
    eventCount: 1,
    host: "none",
    activity: "idle",
    archived: false,
  });
  const list = [
    mk("a", "other", "2026-06-26T05:00:00.000Z"),
    mk("b", "trevorV2", "2026-06-26T01:00:00.000Z"),
    mk("c", "trevorV2", "2026-06-26T09:00:00.000Z"),
    mk("d", "other", "2026-06-26T02:00:00.000Z"),
  ];
  const sorted = sortInventory(list, "trevorV2");
  assert.deepEqual(
    sorted.map((s) => s.sessionId),
    ["c", "b", "a", "d"],
  );
  // null current project => pure recency
  assert.deepEqual(
    sortInventory(list, null).map((s) => s.sessionId),
    ["c", "a", "d", "b"],
  );
});

test("relativeTime renders compact buckets", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  assert.equal(relativeTime("2026-06-26T11:59:30.000Z", now), "just now");
  assert.equal(relativeTime("2026-06-26T11:30:00.000Z", now), "30m ago");
  assert.equal(relativeTime("2026-06-26T09:00:00.000Z", now), "3h ago");
  assert.equal(relativeTime("2026-06-23T12:00:00.000Z", now), "3d ago");
  assert.equal(relativeTime("2026-06-05T12:00:00.000Z", now), "3w ago");
  assert.equal(relativeTime("not-a-date", now), "");
  // Through 10 weeks stays a week label; past it switches to a specific date (never "months ago").
  assert.equal(relativeTime("2026-04-17T12:00:00.000Z", now), "10w ago", "exactly 70 days");
  assert.equal(relativeTime("2026-04-10T12:00:00.000Z", now), "Apr 10, 2026", "11 weeks -> date");
  assert.equal(relativeTime("2026-01-01T12:00:00.000Z", now), "Jan 1, 2026");
  assert.equal(relativeTime("2025-12-25T12:00:00.000Z", now), "Dec 25, 2025");
});

test("summarizeSession derives archived from the latest session.archived event (newest wins)", () => {
  const noFlag = summarizeSession(baseRow());
  assert.equal(noFlag.archived, false, "no session.archived event -> not archived");

  const archived = events.sessionArchived({ archived: true });
  assert.equal(
    summarizeSession(
      baseRow({ archived: ev(archived.type, archived.payload as Record<string, unknown>) }),
    ).archived,
    true,
    "an archived: true marker archives the session",
  );

  // The store keeps only the LATEST session.archived, so an unarchive (archived: false) reads as active.
  const unarchived = events.sessionArchived({ archived: false });
  assert.equal(
    summarizeSession(
      baseRow({ archived: ev(unarchived.type, unarchived.payload as Record<string, unknown>) }),
    ).archived,
    false,
    "the latest marker (unarchive) wins",
  );
});

test("activeSessions / archivedSessions partition the inventory by the archived flag", () => {
  const a = summarizeSession(baseRow({ sessionId: "a" }));
  const archivedEvent = events.sessionArchived({ archived: true });
  const b = summarizeSession(
    baseRow({
      sessionId: "b",
      archived: ev(archivedEvent.type, archivedEvent.payload as Record<string, unknown>),
    }),
  );

  assert.deepEqual(
    activeSessions([a, b]).map((s) => s.sessionId),
    ["a"],
    "active view excludes archived",
  );
  assert.deepEqual(
    archivedSessions([a, b]).map((s) => s.sessionId),
    ["b"],
    "archived view keeps only archived",
  );
});

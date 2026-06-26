import assert from "node:assert/strict";
import type { SessionSummary } from "@trevor/session";
import { test } from "vitest";
import { buildResumeRows, type ResumeContext } from "./resume-rows";

const NOW = Date.parse("2026-06-26T12:00:00.000Z");

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  sessionId: "s",
  title: "a session",
  cwd: "~/dev/trevorV2",
  workspace: "~/dev/trevorV2",
  project: "trevorV2",
  branch: "main",
  git: null,
  createdAt: "2026-06-25T12:00:00.000Z",
  updatedAt: "2026-06-26T11:00:00.000Z",
  eventCount: 10,
  host: "none",
  activity: "idle",
  archived: false,
  ...over,
});

const ctx = (over: Partial<ResumeContext> = {}): ResumeContext => ({
  currentSessionId: "cur",
  currentProject: "trevorV2",
  busy: false,
  nowMs: NOW,
  ...over,
});

test("the chooser is scoped to the current working directory's project (others excluded)", () => {
  const sessions = [
    summary({ sessionId: "op", project: "opchain", updatedAt: "2026-06-26T05:00:00.000Z" }),
    summary({ sessionId: "p-old", updatedAt: "2026-06-26T01:00:00.000Z" }),
    summary({ sessionId: "p-new", updatedAt: "2026-06-26T10:00:00.000Z" }),
  ];
  const rows = buildResumeRows(sessions, ctx({ currentSessionId: "none" }));
  // Only the current project's sessions, by recency; the opchain session is not offered.
  assert.deepEqual(
    rows.map((r) => r.id),
    ["p-new", "p-old"],
  );
  assert.ok(rows.every((r) => r.group === undefined));
});

test("status reflects activity then host presence (running > live > stale > none)", () => {
  const tone = (s: Partial<SessionSummary>) =>
    buildResumeRows([summary(s)], ctx({ currentSessionId: "x" }))[0];
  assert.equal(tone({ sessionId: "a", activity: "running", host: "live" })?.status, "running");
  assert.equal(tone({ sessionId: "b", host: "live" })?.status, "host ready");
  assert.equal(tone({ sessionId: "c", host: "stale" })?.status, "stale host");
  assert.equal(tone({ sessionId: "d", host: "none" })?.status, "no host");
});

test("the current session's own row is disabled (no resume-to-self) and marked current", () => {
  const rows = buildResumeRows([summary({ sessionId: "cur" })], ctx());
  assert.equal(rows[0]?.current, true);
  assert.equal(rows[0]?.disabledReason, "current session");
});

test("while the current session is busy, every other row is disabled (switch-blocked)", () => {
  const rows = buildResumeRows(
    [summary({ sessionId: "cur" }), summary({ sessionId: "other" })],
    ctx({ busy: true }),
  );
  const other = rows.find((r) => r.id === "other");
  assert.equal(other?.disabledReason, "finish the current run first");
});

test("metadata carries location, branch, event count, and a relative time", () => {
  const rows = buildResumeRows(
    [summary({ sessionId: "x", eventCount: 42, updatedAt: "2026-06-26T09:00:00.000Z" })],
    ctx({ currentSessionId: "none" }),
  );
  const meta = rows[0]?.metadata ?? "";
  assert.ok(meta.includes("~/dev/trevorV2"), meta);
  assert.ok(meta.includes("main"), meta);
  assert.ok(meta.includes("42 events"), meta);
  assert.ok(meta.includes("3h ago"), meta);
});

test("no known current project => unscoped (show all), pure recency order", () => {
  const rows = buildResumeRows(
    [
      summary({ sessionId: "a", project: "x", updatedAt: "2026-06-26T01:00:00.000Z" }),
      summary({ sessionId: "b", project: "y", updatedAt: "2026-06-26T05:00:00.000Z" }),
    ],
    ctx({ currentProject: null, currentSessionId: "none" }),
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["b", "a"],
  );
  assert.ok(rows.every((r) => r.group === undefined));
});

test("buildResumeRows never mutates the source summaries", () => {
  const sessions = [summary({ sessionId: "a" }), summary({ sessionId: "b" })];
  const before = JSON.stringify(sessions);
  buildResumeRows(sessions, ctx());
  assert.equal(JSON.stringify(sessions), before);
});

test("an archived session never appears in the default resume rows (D-094)", () => {
  const rows = buildResumeRows(
    [summary({ sessionId: "active" }), summary({ sessionId: "filed", archived: true })],
    ctx({ currentSessionId: "x" }),
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["active"],
    "the archived session is excluded; the active one remains",
  );
});

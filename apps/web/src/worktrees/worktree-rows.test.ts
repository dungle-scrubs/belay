import assert from "node:assert/strict";
import type { WorktreeSummary } from "@trevor/session";
import { test } from "vitest";
import {
  buildWorktreeRows,
  type WorktreeActivity,
  type WorktreeRowsContext,
} from "./worktree-rows";

const wt = (over: Partial<WorktreeSummary>): WorktreeSummary => ({
  id: "wt",
  baseRepo: "/dev/trevorV2",
  baseRepoName: "trevorV2",
  branch: "feat/x",
  path: "~/.worktrees/h/feat-x-wt",
  sessionId: "s-wt",
  dirty: false,
  ahead: 0,
  behind: 0,
  conflict: false,
  detached: false,
  current: false,
  baseline: false,
  missing: false,
  ...over,
});

const ctx = (over: Partial<WorktreeRowsContext> = {}): WorktreeRowsContext => ({
  busy: false,
  ...over,
});

test("baseline row is labeled and grouped by base repo", () => {
  const rows = buildWorktreeRows(
    [wt({ id: "baseline", branch: "main", baseline: true }), wt({ id: "a" })],
    ctx(),
  );
  assert.equal(rows[0]?.label, "main (baseline)");
  assert.equal(rows[0]?.group, "trevorV2");
  assert.equal(rows[1]?.label, "feat/x");
});

test("git deltas render as the status (clean / dirty ↑↓)", () => {
  assert.equal(buildWorktreeRows([wt({})], ctx())[0]?.status, "clean");
  assert.equal(
    buildWorktreeRows([wt({ dirty: true, ahead: 2, behind: 1 })], ctx())[0]?.status,
    "dirty ↑2 ↓1",
  );
});

test("a rebase conflict is a danger status", () => {
  const row = buildWorktreeRows([wt({ conflict: true })], ctx())[0];
  assert.equal(row?.status, "rebase conflict");
  assert.equal(row?.statusTone, "danger");
});

test("cross-referenced activity surfaces agents-running and needs-you", () => {
  const activity = new Map<string, WorktreeActivity>([
    ["s-run", { host: "live", activity: "running" }],
    ["s-idle", { host: "live", activity: "idle" }],
  ]);
  const rows = buildWorktreeRows(
    [wt({ id: "r", sessionId: "s-run" }), wt({ id: "i", sessionId: "s-idle" })],
    ctx({ activityBySession: activity }),
  );
  assert.equal(rows.find((r) => r.id === "r")?.status, "agents running");
  assert.equal(rows.find((r) => r.id === "i")?.status, "needs you");
});

test("the current worktree is marked and disabled (no switch-to-self)", () => {
  const row = buildWorktreeRows([wt({ id: "cur", current: true })], ctx())[0];
  assert.equal(row?.current, true);
  assert.equal(row?.disabledReason, "current worktree");
});

test("a missing worktree is disabled with a repair reason", () => {
  const row = buildWorktreeRows([wt({ id: "gone", missing: true })], ctx())[0];
  assert.equal(row?.status, "missing");
  assert.equal(row?.disabledReason, "missing — needs repair");
});

test("while busy, every non-current row is disabled (switch-blocked)", () => {
  const rows = buildWorktreeRows(
    [wt({ id: "cur", current: true }), wt({ id: "other" })],
    ctx({ busy: true }),
  );
  assert.equal(rows.find((r) => r.id === "other")?.disabledReason, "finish the current run first");
});

test("rows from different base repos carry distinct group headings", () => {
  const rows = buildWorktreeRows(
    [wt({ id: "a", baseRepoName: "trevorV2" }), wt({ id: "b", baseRepoName: "opchain" })],
    ctx(),
  );
  assert.equal(rows[0]?.group, "trevorV2");
  assert.equal(rows[1]?.group, "opchain");
});

test("buildWorktreeRows never mutates the source summaries", () => {
  const src = [wt({ id: "a" }), wt({ id: "b" })];
  const before = JSON.stringify(src);
  buildWorktreeRows(src, ctx());
  assert.equal(JSON.stringify(src), before);
});

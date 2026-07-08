# Worktree Sidebar Surface - Progress Report

**Plan:** `58.2-worktree-sidebar-surface`
**Stage:** ready (plan authored, awaiting go to implement)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 32 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 32 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

---

## M1 - Host stamps `session.project` with the base repo (4/4)

- [ ] RED: Test `switchToWorkspace` (reason "worktree") emits `session.project` with the base repo on the TARGET session.
- [ ] GREEN: Widen `SessionSwitchDeps` (transport: ensureSession|publishEvent + `baseRepoFor` seam); publish marker to `opts.sessionId` (not `emit`, which writes to SESSION_ID).
- [ ] RED: Test `/worktree-new` also stamps the base repo (same path).
- [ ] REFACTOR: Centralize base-repo resolution; commands.ts + session-switch.ts ask the manager once.

## M2 - Sidebar base-repo grouping, online + offline (4/4)

- [ ] RED: Worktree session groups under base repo via the durable marker (offline).
- [ ] RED: Worktree join keys on `sessionId` (exact, offline-safe), NOT on path (abbreviation mismatch); baseline row (`baseline === true`) is excluded so the main checkout is not badged.
- [ ] GREEN: `buildProjectSidebar` accepts `worktrees`, joins on `sessionId` (excluding `baseline: true` rows); grouping via M1 marker.
- [ ] REFACTOR: Pull the session-to-worktree join (`Map<sessionId, WorktreeSummary>`, baseline excluded) into a pure helper.

## M3 - Worktree badge on session rows (5/5)

- [ ] RED: SessionRow in a known worktree renders a FolderGit2 badge (excluding the baseline row).
- [ ] GREEN: Add `worktree` field to the row view model; render FolderGit2 (baseline excluded by the `!baseline` filter in the M2 join map).
- [ ] RED: Hovering the badge opens a Radix tooltip with branch + abbreviated path + git state.
- [ ] GREEN: Build `WorktreeBadge` (FolderGit2 + existing Radix Tooltip).
- [ ] REFACTOR: Extract the tooltip into its own reusable module.

## M4 - Host-side merged detection (5/5) (protocol change)

- [ ] RED: `WorktreeManager.summaries` marks a worktree `merged: true` when in `git branch --merged <default>`.
- [ ] GREEN: Add `merged` to `WorktreeSummary` (`events.ts`) + `coerceWorktrees` (`decode.ts`) + `summaryRow` (`manager.ts`); add `branchMerged` to `git.ts`.
- [ ] RED: Default branch resolved dynamically (`origin/HEAD` → `main` → `master`).
- [ ] GREEN: Resolve the default branch via `git symbolic-ref refs/remotes/origin/HEAD` with fallbacks.
- [ ] REFACTOR: Gate the merged check behind a periodic cadence (host.online + 5 min).

## M5 - Disabled session row for merged worktrees (4/4)

- [ ] RED: Merged-worktree session renders dimmed with a "merged" label.
- [ ] GREEN: Render merged rows with `opacity-50` + "merged" replacing the timestamp.
- [ ] RED: Archive still works on merged rows.
- [ ] GREEN: Keep the archive hover action functional on merged rows.

## M6 - Orphan detection and registry cleanup (5/5)

- [ ] RED: Verify the existing `missing` flag flows to the browser.
- [ ] GREEN: Render missing worktrees as disabled with "orphaned".
- [ ] RED: `/worktree-reconcile` drops orphaned entries and the sidebar updates.
- [ ] GREEN: Wire the sidebar to consume updated worktree state from `host.online`.
- [ ] REFACTOR: Consolidate merged/orphaned/active into a `worktreeStatus` field.

## M7 - Tooltip richness and final polish (5/5) (protocol change)

- [ ] RED: Tooltip shows last-commit info (short hash + subject).
- [ ] GREEN: Add `lastCommit?` to `WorktreeSummary` (`events.ts`) + `coerceWorktrees` (`decode.ts`) + `summaryRow` (`manager.ts`); add `headCommitInfo` to `git.ts` (existing `headCommit` returns sha only, not subject).
- [ ] RED: Storybook stories for normal, worktree-active, worktree-merged states.
- [ ] GREEN: Build the stories and verify rendering.
- [ ] REFACTOR: Clean up any dead code from the old per-worktree-project grouping.

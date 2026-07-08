# Worktree Sidebar Surface - Progress Report

**Plan:** `58.2-worktree-sidebar-surface`
**Stage:** ready (plan authored, awaiting go to implement)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 26 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 26 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

---

## M1 - Base-Repo Grouping for Worktree Sessions (5/5)

- [ ] RED: Add a model test proving a session whose `projectPath` is a managed worktree path is grouped under its base repo.
- [ ] GREEN: Extend `buildProjectSidebar` to remap worktree sessions to their base repo via worktree summaries.
- [ ] RED: Add a test proving grouping works via the durable `session.project` marker when the host is offline.
- [ ] GREEN: Verify the host publishes `session.project` with the base repo path for worktree sessions.
- [ ] REFACTOR: Centralize worktree-path-to-base-repo resolution.

## M2 - Worktree Badge on Session Rows (5/5)

- [ ] RED: Add a test proving a SessionRow in a known worktree renders a FolderGit2 badge.
- [ ] GREEN: Add the `worktree` field to the session row view model and render the badge.
- [ ] RED: Add a test proving hovering the badge opens a Radix tooltip with branch + path + git state.
- [ ] GREEN: Build `WorktreeBadge` component with the rich tooltip.
- [ ] REFACTOR: Extract the tooltip into its own reusable module.

## M3 - Host-Side Merged Detection (5/5)

- [ ] RED: Add a test proving `WorktreeManager.summaries` marks a worktree `merged` when its branch is in `git branch --merged`.
- [ ] GREEN: Add `branchMerged` to `git.ts` and call it from the manager.
- [ ] RED: Add a test proving the default branch is resolved dynamically.
- [ ] GREEN: Resolve the default branch via `origin/HEAD` with fallbacks.
- [ ] REFACTOR: Gate the merged check behind a periodic cadence.

## M4 - Disabled Session Row for Merged Worktrees (4/4)

- [ ] RED: Add a test proving a merged-worktree session renders dimmed with a "merged" label.
- [ ] GREEN: Render merged rows with `opacity-50` + "merged" replacing the timestamp.
- [ ] RED: Add a test proving archive still works on merged rows.
- [ ] GREEN: Keep the archive hover action functional on merged rows.

## M5 - Orphan Detection and Registry Cleanup (5/5)

- [ ] RED: Verify the existing `missing` flag flows to the browser.
- [ ] GREEN: Render missing worktrees as disabled with "orphaned".
- [ ] RED: Add a test proving reconcile drops orphaned entries and the sidebar updates.
- [ ] GREEN: Wire the sidebar to consume updated worktree state from `host.online`.
- [ ] REFACTOR: Consolidate merged/orphaned/active into a `worktreeStatus` field.

## M6 - Tooltip Richness and Final Polish (5/5)

- [ ] RED: Add a test proving the tooltip shows last-commit info.
- [ ] GREEN: Extend `WorktreeSummary` with `lastCommit` and include it in the announcement.
- [ ] RED: Add Storybook stories for normal, worktree-active, and worktree-merged states.
- [ ] GREEN: Build the stories and verify rendering.
- [ ] REFACTOR: Clean up dead code from the old per-worktree-project grouping.

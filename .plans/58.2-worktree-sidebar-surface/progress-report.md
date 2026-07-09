# Worktree Sidebar Surface - Progress Report

**Plan:** `58.2-worktree-sidebar-surface`
**Stage:** implementing
**Current focus:** M2 - Sidebar grouping and scoped sessionId worktree join (5/5)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 15 |
| Checked (done) | 5 |
| Current-cutoff blockers (unchecked) | 10 |
| Accepted/deferred follow-up | 8 |
| Superseded/obsolete | 0 |

---

## Current Cutoff

### M1 - Host stamps `session.project` before worktree spawn (5/5)

- [x] RED: Unit-test `switchToWorkspace({ reason: "worktree" })` call order:
      `ensureSession` -> target `session.project` publish -> spawn -> source `session.switch`.
- [x] RED: No `baseRepoFor(cwd)` fails before spawn and does not emit `session.switch`.
- [x] GREEN: Add `baseRepoFor`, `publishToSession`, and injectable spawn seams; publish the marker
      to `opts.sessionId`, not through current-session `emit`.
- [x] GREEN: Wire `main.ts` with `worktrees.contextFor(cwd)?.baseRepo` and `transport.publishEvent`
      using the host producer id.
- [x] REFACTOR: Keep base-repo resolution centralized on `WorktreeManager.contextFor`.

### M2 - Sidebar grouping and scoped `sessionId` worktree join (5/5)

- [ ] RED: Worktree session groups under base repo via durable `projectPath` with no host online.
- [ ] RED: Worktree join keys on `sessionId` and excludes `baseline === true`.
- [ ] RED: No path inference: worktree-looking paths receive no badge when `sessionId` is absent from
      the supplied worktree snapshot.
- [ ] GREEN: Add `ProjectSessionRow { summary, worktree }`; group by `sessionProjectPath(summary)`.
- [ ] GREEN: Pass current `readModel.worktrees` through `useProjectSidebar`; document/test that this
      is current-host-scoped, not an all-project index.

### M3 - Worktree badge and tooltip (5/5)

- [ ] RED: Session row with `row.worktree` renders a `FolderGit2` badge labeled `worktree`; rows
      without `row.worktree` do not.
- [ ] GREEN: Add `worktree-badge.tsx` with lucide `FolderGit2` and Radix tooltip primitives.
- [ ] GREEN: Preserve stable row layout: title, badge, truncation, and the existing right slot do not
      overlap.
- [ ] RED: Tooltip hover/focus shows branch, abbreviated path, and git state.
- [ ] GREEN: Add Storybook stories for normal, worktree, long-title worktree, and baseline no-badge.

---

## Accepted/Deferred Follow-Up

### FP1 - All-project worktree metadata source (3)

- [ ] Decide and build a host/supervisor-owned all-project worktree metadata source; the browser must
      not scan local state.
- [ ] Define stale-vs-live semantics for metadata from non-current projects.
- [ ] Test badge/status attachment for sessions outside the currently viewed host's base repo.

### FP2 - Merged and orphaned disabled states (4)

- [ ] Add `merged` only after an all-project data source exists, or explicitly scope it to current repo.
- [ ] Specify merged-check owner, cache, cadence, and invalidation before implementation.
- [ ] Define branch identity for merged detection, including retargeted/detached worktrees.
- [ ] Add protocol round-trip/defaulting tests for each new `WorktreeSummary` field.

### FP3 - Last-commit tooltip enrichment (1)

- [ ] Add `lastCommit` and bounded tooltip rendering after the metadata source is settled.

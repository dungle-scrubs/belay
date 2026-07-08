# Worktree Sidebar Surface - Implementation Plan

## 0. Hard Dependencies

- [x] `.plans/58-project-sidebar-sessions` - **merged** (the project sidebar is live): `buildProjectSidebar`
  groups sessions under projects, `SessionRow` renders the session with hover actions, the
  `WorktreeManager` + registry already exist under `apps/agent-host/src/worktrees/`. This plan is a
  pure delta on top of the sidebar and the existing worktree infrastructure. <!-- D-001 -->
- [x] `.plans/01-managed-worktree-hardening` - **merged**: `WorktreeManager`, `WorktreeRecord` registry,
  cwd-path advisory lock, managed-worktree path layout (`<state-home>/.worktrees/<repo-hash>/<branch-slug>-<id>`).
- [x] Downstream accommodation - none. No plan numbered higher than 58.2 exists; plan 58.1 is on `main`
  (compact exemption, unrelated). <!-- D-002 -->

## 1. Architecture

Worktrees are currently invisible in the sidebar. A worktree session appears as a session under its
worktree path (treated as a separate project), with no indication it belongs to a branch of a larger
repo. This plan surfaces the worktree relationship at the **session row level**: a `FolderGit2` badge
on sessions that live in a managed worktree, with a rich Radix tooltip showing the branch, the
abbreviated worktree path, and git state (dirty/ahead/behind/conflict). Merged worktrees are detected
and shown as disabled; the user archives them when ready.

The design principle: **worktrees are a property of the session, not a separate project.** Worktree
sessions group under their parent repo's project entry, not a separate folder. The sidebar already
groups by `projectPath`; a worktree session's `projectPath` resolves to the **base repo** (the main
checkout), so it appears under the same project as non-worktree sessions. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Worktree path is never user-visible in the sidebar (only in the tooltip, abbreviated) | The session row shows the session title + badge; the path is tooltip-only |
| Merged detection must be reliable and host-driven | The host runs `git branch --merged`; the browser cannot. The host publishes worktree state via `host.online` worktrees |
| Existing `WorktreeSummary` wire type already carries git state | Reuse the existing announcement; no protocol change needed for M1-M2 |
| Session grouping by base repo (not worktree path) | The `session.project` marker / `projectPath` must resolve to the base repo, not the worktree path |

### Boundaries

```
apps/agent-host/src/worktrees/  (existing, extended)
  registry.ts    - records + path layout (add: "merged" status)
  manager.ts     - lifecycle (add: merged detection, base-repo resolution for sessions)
  git.ts         - git commands (add: branch --merged check)

apps/web/src/sidebar/  (extended)
  project-sidebar.tsx      - SessionRow gets FolderGit2 badge + tooltip
  project-sidebar-model.ts - join WorktreeSummary into SessionRow's view model
  worktree-badge.tsx       (new) - the badge + rich tooltip component

packages/session/src/protocol/events.ts  (extended)
  WorktreeSummary  - add: merged?: boolean, baseRepoPath?: string
```

### Observability

No new runtime observability surfaces needed. The worktree state is already announced via
`host.online` worktrees; this plan only changes how the browser renders it.

---

## 2. Phases

### Phase 1: Session-Level Worktree Surface (the badge + tooltip)

**Goal:** A session in a managed worktree shows a `FolderGit2` badge with a rich tooltip; sessions
group under their base-repo project entry instead of a separate worktree-path project.

**Gate from previous:** plan 58 merged (sidebar is live).

#### M1: Base-repo grouping for worktree sessions

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a model test proving a session whose `projectPath` is a managed worktree path is
     grouped under its **base repo** (not the worktree path), using the worktree registry to
     resolve base repo.
  2. GREEN: Extend `buildProjectSidebar` to accept an optional `worktrees` parameter (the
     `WorktreeSummary[]` from `host.online`). When a session's `projectPath` matches a known
     worktree's `worktreePath`, remap it to the worktree's `baseRepo` so it groups under the
     parent project.
  3. RED: Add a test proving a worktree session that has NO host announcement (host offline)
     still groups correctly via the durable `session.project` marker (which should already carry
     the base repo path).
  4. GREEN: Verify the host publishes `session.project` with the **base repo** path (not the
     worktree path) when launching a worktree session. Fix the launch path if needed.
  5. REFACTOR: Centralize the worktree-path-to-base-repo resolution so the sidebar model and the
     inventory don't each rebuild it.

#### M2: Worktree badge on session rows

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a test proving a `SessionRow` whose session is in a known worktree renders a
     `FolderGit2` icon (aria-label "worktree") after the title.
  2. GREEN: Add a `worktree` field to the session row's view model (the `WorktreeSummary` or
     null). Render the `FolderGit2` icon from lucide when present.
  3. RED: Add a test proving hovering the badge opens a Radix `Tooltip` showing the branch name,
     the abbreviated worktree path, and git state (dirty/ahead/behind).
  4. GREEN: Build `WorktreeBadge` component: a `FolderGit2` icon wrapped in the existing Radix
     `Tooltip`/`TooltipContent`, showing branch, path (abbreviated), and a git-state line
     (`clean` / `3 ahead, 1 behind` / `dirty` / `conflict`).
  5. REFACTOR: Extract the tooltip into its own module so it's reusable.

### Gate 1→2

- [ ] Worktree sessions group under their base-repo project entry.
- [ ] Session rows show the `FolderGit2` badge with a rich tooltip.
- [ ] The badge is absent for non-worktree sessions.

### Phase 2: Merged Detection and Disabled State

**Goal:** When a worktree's branch is merged into the default branch, the session row becomes
disabled (dimmed) and the user can archive it.

#### M3: Host-side merged detection

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add a test proving the `WorktreeManager.summaries` marks a worktree as `merged: true`
     when its branch appears in `git branch --merged <default-branch>`.
  2. GREEN: Add a `branchMerged` check to `git.ts` that runs `git branch --merged <ref>` and
     returns whether the given branch is in the list. Call it from the manager's `summaries()`
     to annotate each worktree with `merged`.
  3. RED: Add a test proving the default branch is resolved correctly (the repo's `main` /
     `master` / configured default), not hardcoded.
  4. GREEN: Resolve the default branch via `git symbolic-ref refs/remotes/origin/HEAD` (falling
     back to `main`, then `master`).
  5. REFACTOR: Gate the merged check behind a config flag (run on `host.online` + periodically)
     so it's not called on every render.

#### M4: Disabled session row for merged worktrees

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add a test proving a session row whose worktree is `merged` renders with reduced
     opacity and a "merged" label replacing the timestamp.
  2. GREEN: When the worktree summary's `merged` is true, render the session row dimmed
     (`opacity-50`), show "merged" instead of the relative time, and make the row non-clickable
     (or navigate but show a "merged" state).
  3. RED: Add a test proving the hover archive action still works on a merged session row.
  4. GREEN: Keep the archive hover action functional on merged rows (the user archives to clean
     up; archiving hides from the active list, the session log is retained).

### Gate 2→3

- [ ] Merged worktrees are detected by the host and announced via `host.online`.
- [ ] Merged session rows are dimmed with a "merged" label.
- [ ] Archive still works on merged rows.

### Phase 3: Orphan Detection and Polish

**Goal:** Worktrees whose folder is deleted (externally pruned) are detected and cleaned up.

#### M5: Orphan detection and registry cleanup

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add a test proving a worktree whose `worktreePath` no longer exists is flagged
     `missing: true` in the summary (this already exists in `listWorktrees`; verify it flows
     through to the browser).
  2. GREEN: Verify the existing `missing` flag on `WorktreeSummary` flows from the host's
     `host.online` worktrees to the browser's session row view model. Render missing worktrees
     as disabled with an "orphaned" label.
  3. RED: Add a test proving the host's reconcile command (`/worktree-reconcile`) drops orphaned
     registry entries and the sidebar updates.
  4. GREEN: Wire the sidebar to re-fetch worktree state when the host announces updated
     worktrees (the existing `host.online` already carries worktrees; verify the sidebar consumes
     the update).
  5. REFACTOR: Consolidate the merged/orphaned/active states into a single `worktreeStatus`
     derived field on the session row view model.

#### M6: Tooltip richness and final polish

- **Dependencies:** M4, M5
- **Effort:** S
- **Tasks:**
  1. RED: Add a test proving the tooltip shows last-commit info when available (short hash +
     message) alongside the branch and path.
  2. GREEN: Extend `WorktreeSummary` to optionally carry `lastCommit` (short hash + subject). The
     host already reads HEAD; include it in the announcement.
  3. RED: Add a visual regression test (or Storybook story) for the three session row states:
     normal, worktree-active (badge + tooltip), worktree-merged (dimmed + "merged").
  4. GREEN: Add the Storybook stories and verify the badge, tooltip, and merged states render
     correctly.
  5. REFACTOR: Clean up any dead code from the old per-worktree-project grouping.

### Gate 3->done

- [ ] Worktree sessions group under their base-repo project.
- [ ] `FolderGit2` badge with rich tooltip on worktree sessions.
- [ ] Merged detection (host-side `git branch --merged`).
- [ ] Merged rows are dimmed with "merged" label; archive works.
- [ ] Orphaned worktrees (deleted folder) show as disabled with "orphaned".
- [ ] Storybook stories cover all three states.
- [ ] Lint, typecheck, web tests, and agent-host tests pass.

---

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| `git branch --merged` is slow on large repos | low | low | Run on `host.online` + periodic (5 min), not on every render | host |
| Default branch detection fails (no origin, detached HEAD) | medium | medium | Fallback chain: `origin/HEAD` -> `main` -> `master` -> skip merged check | host |
| Worktree session's `session.project` marker carries worktree path, not base repo | medium | medium | M1 task 4 verifies and fixes the launch path | host |
| Host offline: no `WorktreeSummary` available | low | high | Badge is absent when no worktree data; session still shows under its project via `projectPath` | web |

---

## 4. Escape Hatches

1. **If base-repo grouping proves fragile:** fall back to showing worktree sessions as a nested
   sub-group within the project (indented under the base repo), using the worktree branch as the
   sub-group label. This avoids the `session.project` remapping complexity at the cost of a
   two-level nesting.

2. **If merged detection is unreliable on non-standard repos:** ship M1+M2 (badge + tooltip) without
   merged detection. The badge + tooltip alone communicate the worktree relationship; merged
   detection becomes a follow-up.

3. **If the tooltip is too heavy for the sidebar:** ship a simple inline branch label
   (`🌿 feat/sidebar`) instead of a hover tooltip. Less info, but always visible.

---

## Decisions

Canonical decisions are in the plan database (`.plans/58.2-worktree-sidebar-surface/plan.db`).

# Worktree Sidebar Surface - Implementation Plan

## 0. Hard Dependencies

- [x] `.plans/58-project-sidebar-sessions` - **merged** (the project sidebar is live): `buildProjectSidebar`
  groups sessions under projects, `SessionRow` renders the session with hover actions, the
  `WorktreeManager` + registry already exist under `apps/agent-host/src/worktrees/`. This plan is a
  pure delta on top of the sidebar and the existing worktree infrastructure.
- [x] `.plans/01-managed-worktree-hardening` - **merged**: `WorktreeManager`, `WorktreeRecord` registry,
  cwd-path advisory lock, managed-worktree path layout (`<state-home>/.worktrees/<repo-hash>/<branch-slug>-<id>`).
- [x] Downstream accommodation - none. No plan numbered higher than 58.2 exists; plan 58.1 is on `main`
  (compact exemption, unrelated). <!-- D-004 -->

## 1. Architecture

Worktrees are currently invisible in the sidebar. A worktree session appears as a session under its
worktree path (treated as a separate project), with no indication it belongs to a branch of a larger
repo. This plan surfaces the worktree relationship at the **session row level**: a `FolderGit2` badge
on sessions that live in a managed worktree, with a rich Radix tooltip showing the branch, the
abbreviated worktree path, and git state (dirty/ahead/behind/conflict). <!-- D-003 --> Merged worktrees are detected
and shown as disabled; the user archives them when ready.

The design principle: **worktrees are a property of the session, not a separate project.** Worktree
sessions group under their parent repo's project entry, not a separate folder. The sidebar already
groups by `projectPath`; a worktree session's `projectPath` resolves to the **base repo** (the main
checkout), so it appears under the same project as non-worktree sessions. <!-- D-001 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Worktree path is never user-visible in the sidebar (only in the tooltip, abbreviated) | The session row shows the session title + badge; the path is tooltip-only |
| Merged detection must be reliable and host-driven | The host runs `git branch --merged`; the browser cannot. The host publishes worktree state via `host.online` worktrees <!-- D-002 --> |
| Existing `WorktreeSummary` wire type already carries git state | Reuse the existing announcement; no protocol change needed for M1-M3 (M4 `merged` and M7 `lastCommit` extend it) |
| Session grouping by base repo (not worktree path) | The `session.project` marker must be **stamped with the base repo** (M1 extends the existing marker mechanism to the worktree-switch path; today only browser project launches stamp it via the supervisor); `projectPath` then resolves to the base repo, not the worktree path |

### Boundaries

```
apps/agent-host/src/worktrees/  (existing, extended)
  registry.ts    - records + path layout (unchanged; no "merged" status lives here)
  manager.ts     - lifecycle (add: merged detection via summaryRow; base-repo resolution seam for
                   session-switch stamping)
  git.ts         - git commands (add: branch --merged check [M4], headCommitInfo for subject [M7])
apps/agent-host/src/session/session-switch.ts  (extended)
  switchToWorkspace - emit session.project with the base repo for reason === "worktree"
  SessionSwitchDeps - widen `transport` to Pick<SessionTransport, "ensureSession" | "publishEvent">,
                      add `baseRepoFor(cwd): string | null` seam (publishEvent is needed because the
                      marker must land on the TARGET session, and the existing `emit` dep writes to
                      SESSION_ID only)

apps/web/src/sidebar/  (extended)
  project-sidebar.tsx      - SessionRow gets FolderGit2 badge + tooltip
  project-sidebar-model.ts - join WorktreeSummary into SessionRow's view model (key on sessionId; group by baseRepo via M1 marker)
  worktree-badge.tsx       (new) - the badge + rich tooltip component

packages/session/src/protocol/  (extended, M4/M7 only)
  events.ts - WorktreeSummary: add merged?: boolean (M4), lastCommit?: {...} (M7)
  decode.ts - coerceWorktrees: read the new fields in lockstep (permissive decode drops them otherwise)
```

**Protocol change scope:** M1-M3 require NO wire change (they reuse existing `baseRepo`, `branch`,
`dirty/ahead/behind/conflict`, `missing`). Only M4 (`merged`) and M7 (`lastCommit`) extend
`WorktreeSummary`, and each such extension MUST update three sites in lockstep:
`events.ts` (type), `decode.ts` (`coerceWorktrees`), and `manager.ts` (`summaryRow`).

### Observability

No new runtime observability surfaces needed. The worktree state is already announced via
`host.online` worktrees; this plan only changes how the browser renders it.

---

## 2. Phases

### Phase 1: Session-Level Worktree Surface (the badge + tooltip)

**Goal:** A session in a managed worktree shows a `FolderGit2` badge with a rich tooltip; sessions
group under their base-repo project entry instead of a separate worktree-path project.

**Gate from previous:** plan 58 merged (sidebar is live).

#### M1: Host stamps `session.project` with the base repo for worktree sessions

- **Dependencies:** none
- **Effort:** M
- **Rationale:** Today no code emits `events.sessionProject` **on the worktree-switch path**. The
  event type exists, the inventory fold reads it (`packages/session/src/inventory.ts`), and the
  **supervisor** already publishes it for browser-initiated project launches
  (`apps/supervisor/src/dispatch.ts`: `publishToSession(sessionId, events.sessionProject(...))`,
  gated on `projectPath` in `session.launch.requested`). But `/worktree-switch` and `/worktree-new`
  run **inside the host** (`worktrees/commands.ts`), never through the supervisor's launch path, so
  the marker is never stamped for them. `SessionSummary.projectPath` then falls through to
  `workspace ?? cwd`; for a worktree session `switchToWorkspace` is called with `workspace` = the
  **worktree path** (`worktrees/commands.ts`), so it resolves to the worktree path, not the base repo.
  This milestone extends the existing marker mechanism to the worktree-switch path so a worktree
  session's `projectPath` is the **base repo**, both online (via the marker) and offline (the marker
  survives host death). Without it, M2's offline-grouping test is impossible.
- **Tasks:**
  1. RED: Add a host test proving that after `switchToWorkspace` for a worktree target (cwd =
     worktree path, workspace = worktree path, reason = "worktree"), the session log carries a
     `session.project` event whose `path` is the **base repo** (resolved via
     `WorktreeManager.contextFor(cwd).baseRepo`), NOT the worktree path.
  2. GREEN: In `switchToWorkspace`, when `reason === "worktree"`, resolve the base repo from the
     target cwd via the `WorktreeManager` and emit `events.sessionProject({ path: baseRepo })` on
     the **target session** (`opts.sessionId`) BEFORE `announceSwitchAndRetire`. Two deps must be
     added to `SessionSwitchDeps`, because the existing `emit` dep is NOT sufficient on its own:
     - **Resolution:** add a `baseRepoFor(cwd): string | null` seam (backed by
       `WorktreeManager.contextFor(cwd)?.baseRepo`) so the switch mechanic doesn't import the
       worktree subsystem directly.
     - **Cross-session publish:** `SessionSwitchDeps.emit` is `EmitEvent`
       (`(event) => Promise<void>`), which publishes to `SESSION_ID` (the *current* host's session)
       via `transport.publishEvent(SESSION_ID, ...)` (`main.ts`). It has **no sessionId parameter**,
       so it writes to the *retiring* host's log, not the target worktree session's log. Widen
       `SessionSwitchDeps.transport` from `Pick<SessionTransport, "ensureSession">` to
       `Pick<SessionTransport, "ensureSession" | "publishEvent">`, and publish the marker via
       `transport.publishEvent(opts.sessionId, toPublishInput(events.sessionProject({ path: baseRepo }), PRODUCER_ID))`.
       This mirrors the supervisor's proven `publishToSession(sessionId, event)` pattern
       (`dispatch.ts`), which already stamps this exact marker on project launches. The marker is
     emitted once per worktree session; `ensureSession` already ran, so the event lands on the
     right log.
  3. RED: Add a host test proving `/worktree-new` stamps the base repo too (it routes through the
     same `switchToWorkspace`), so the durable grouping is consistent across switch and create.
  4. REFACTOR: Centralize the base-repo resolution so both `worktrees/commands.ts` and
     `session/session-switch.ts` ask the manager once (`manager.contextFor(cwd)?.baseRepo`) rather
     than re-deriving it.

#### M2: Sidebar base-repo grouping (online + offline)

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a model test proving a worktree session whose `projectPath` is the **base repo**
     (the marker M1 now stamps) groups under the base-repo project, not a separate worktree-path
     project, with no host online (offline path via the durable marker).
  2. RED: Add a model test proving the worktree **join** (identifying which sessions live in a
     managed worktree, for badge + status rendering) keys on **`sessionId`**: a session whose
     `sessionId` equals a `WorktreeSummary.sessionId` (excluding the **baseline** row; see below)
     is a worktree session. This is exact and offline-safe (the sessionId is durable), and avoids
     the abbreviation mismatch between `WorktreeSummary.path` (home-abbreviated via `abbrevHome`)
     and `SessionSummary.projectPath` (absolute) that makes a path-based join impossible on the
     browser side. **The test must also assert the negative case**: the baseline row's `sessionId`
     (`projectSessionId(baseRepo)`) equals the main-checkout session's id (`projectSessionId(root)`
     in `dispatch.ts`), so a join that does NOT exclude `baseline === true` would wrongly attach a
     worktree badge to the main checkout. The RED test asserts the join excludes baseline rows, so
     the GREEN must implement the filter to make it pass. (See D-005 + D-006.)
  3. GREEN: Extend `buildProjectSidebar` to accept an optional `worktrees` parameter (the
     `WorktreeSummary[]` from `host.online`). Join sessions to worktrees by `sessionId` (not by
     path) so the row view model carries its `WorktreeSummary` when present. Project *grouping*
     still uses the durable marker (M1) as the primary source; the `sessionId` join is how the
     badge/status fields attach to a row, and it works for pre-M1 sessions too (the worktree
     summary carries the session id regardless of whether the marker was stamped).
  4. REFACTOR: Pull the session-to-worktree join (by `sessionId`) into a single pure
     `Map<sessionId, WorktreeSummary>` helper used by the sidebar model. **Exclude the baseline row
     (`baseline === true`) when building the map**: the baseline's `sessionId`
     (`projectSessionId(baseRepo)`) equals the main-checkout session's id (`projectSessionId(root)` in
     `dispatch.ts`), so an unfiltered join would attach a worktree badge to the main checkout. The
     main checkout is not a managed worktree; only managed (non-baseline) summaries are joinable.

#### M3: Worktree badge on session rows

- **Dependencies:** M2 (the join that identifies worktree sessions)
- **Effort:** S
- **Tasks:**
  1. RED: Add a test proving a `SessionRow` whose session is in a known worktree renders a
     `FolderGit2` icon (aria-label "worktree") after the title. Exclude the `baseline: true` row
     (the main checkout is not a worktree; its `path` is `basePath`, never a `worktreePath`).
  2. GREEN: Add a `worktree` field to the session row's view model (the `WorktreeSummary` or
     null). Render the `FolderGit2` icon from lucide when present. The join (from M2) excludes
     baseline rows by construction: the M2 join map is built from `worktrees.filter(w => !w.baseline)`,
     so a baseline `WorktreeSummary` never enters the map and its (matching) sessionId never attaches
     a badge to the main-checkout row.
  3. RED: Add a test proving hovering the badge opens a Radix `Tooltip` showing the branch name,
     the abbreviated worktree path, and git state (dirty/ahead/behind).
  4. GREEN: Build `WorktreeBadge` component: a `FolderGit2` icon wrapped in the existing Radix
     `Tooltip`/`TooltipContent`, showing branch, path (abbreviated), and a git-state line
     (`clean` / `3 ahead, 1 behind` / `dirty` / `conflict`).
  5. REFACTOR: Extract the tooltip into its own module so it's reusable.

### Gate 1→2

- [ ] Worktree sessions group under their base-repo project entry (online via the marker, offline
      via the durable marker; the session-to-worktree join keys on `sessionId`).
- [ ] Session rows show the `FolderGit2` badge with a rich tooltip.
- [ ] The badge is absent for non-worktree sessions AND for the baseline checkout row.

### Phase 2: Merged Detection and Disabled State

**Goal:** When a worktree's branch is merged into the default branch, the session row becomes
disabled (dimmed) and the user can archive it.

#### M4: Host-side merged detection

- **Dependencies:** M3
- **Effort:** M
- **Note:** This milestone **does** require a protocol change (adds `merged` to `WorktreeSummary`),
  unlike M1-M3 which reuse the existing wire type. The type (`packages/session/src/protocol/events.ts`),
  the decoder (`decode.ts: coerceWorktrees`), AND the constructor (`manager.ts: summaryRow`) must all be
  updated in lockstep, or the browser silently drops the field (permissive decoding yields `false`).
- **Tasks:**
  1. RED: Add a test proving the `WorktreeManager.summaries` marks a worktree as `merged: true`
     when its branch appears in `git branch --merged <default-branch>`.
  2. GREEN: Add `merged: boolean` to `WorktreeSummary` (`events.ts`). Update `coerceWorktrees`
     (`decode.ts`) to read `merged: w.merged === true` AND `summaryRow` (`manager.ts`) to populate
     it. Add a `branchMerged` check to `git.ts` that runs `git branch --merged <ref>` and returns
     whether the given branch is in the list; call it from `summaries()` to annotate each worktree.
  3. RED: Add a test proving the default branch is resolved correctly (the repo's `main` /
     `master` / configured default), not hardcoded.
  4. GREEN: Resolve the default branch via `git symbolic-ref refs/remotes/origin/HEAD` (falling
     back to `main`, then `master`).
  5. REFACTOR: Gate the merged check behind a config flag (run on `host.online` + periodically)
     so it's not called on every render.

**Merged-detection semantics:** `git branch --merged <ref>` lists branches whose tips are
reachable from `<ref>`. A branch that was merged and then received new commits is NOT listed (it
stays non-merged, which is correct). When the default branch cannot be resolved (no origin,
detached HEAD), the check is skipped and `merged` stays `false` (best-effort, not exhaustive);
M5 has no test that such a worktree ever dims.

#### M5: Disabled session row for merged worktrees

- **Dependencies:** M4
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

#### M6: Orphan detection and registry cleanup

- **Dependencies:** M2, M3 (the sidebar must render worktree state before orphaned rows can show)
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

#### M7: Tooltip richness and final polish

- **Dependencies:** M5, M6
- **Effort:** S
- **Note:** Like M4, this adds a field (`lastCommit`) to `WorktreeSummary` and requires the
  type + `coerceWorktrees` + `summaryRow` lockstep update.
- **Tasks:**
  1. RED: Add a test proving the tooltip shows last-commit info when available (short hash +
     message) alongside the branch and path.
  2. GREEN: Add `lastCommit?: { hash: string; subject: string }` to `WorktreeSummary`
     (`events.ts`); update `coerceWorktrees` (`decode.ts`) and `summaryRow` (`manager.ts`). NOTE:
     the existing `headCommit` (`git.ts`) returns only the **sha** (`git rev-parse HEAD`); it does
     NOT read the subject. Add a new `headCommitInfo` (or extend `headCommit`) to run
     `git log -1 --format=%H%x09%s` and return `{ hash, subject }`, and call it from `summaries()`
     to populate `lastCommit`. This parallels M4's new `branchMerged` command.
  3. RED: Add a visual regression test (or Storybook story) for the three session row states:
     normal, worktree-active (badge + tooltip), worktree-merged (dimmed + "merged").
  4. GREEN: Add the Storybook stories and verify the badge, tooltip, and merged states render
     correctly.
  5. REFACTOR: Clean up any dead code from the old per-worktree-project grouping.

### Gate 3→done

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
| Default branch detection fails (no origin, detached HEAD) | medium | medium | Fallback chain: `origin/HEAD` → `main` → `master` → skip merged check (best-effort; such a worktree never dims) | host |
| `session.project` marker never emitted on the worktree-switch path (worktree sessions group by worktree path) | high | high (confirmed) | M1 widens `SessionSwitchDeps` (publishEvent + baseRepoFor seam) to stamp the marker on the **target** session inside `switchToWorkspace`; the supervisor's `publishToSession` is the proven precedent for this exact cross-session marker stamp | host |
| Protocol field added but decode/constructor not updated in lockstep → browser silently drops it | high | medium | Each `WorktreeSummary` extension updates `events.ts` + `decode.ts: coerceWorktrees` + `manager.ts: summaryRow` together; M4/M7 tasks name all three sites | host |
| Host offline: no `WorktreeSummary` available | low | high | Badge is absent when no worktree data; session still groups under its base repo via the durable `session.project` marker (M1) | web |

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

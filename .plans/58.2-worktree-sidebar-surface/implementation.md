# Worktree Sidebar Surface - Implementation Plan

## 0. Hard Dependencies

- [x] `.plans/58-project-sidebar-sessions` - merged. The project sidebar is live:
  `buildProjectSidebar` groups sessions under projects, `SessionRow` renders session hover actions,
  and the project registry is under `TREVOR_STATE_HOME`.
- [x] `.plans/01-managed-worktree-hardening` - merged. `WorktreeManager`, the managed worktree
  registry, cwd-path advisory locks, and the managed worktree path layout already exist.
- [x] Downstream accommodation - none. No plan numbered higher than 58.2 exists; plan 58.1 is on
  `main` and unrelated.

## 1. Architecture

### Current Cutoff

The current implementation cutoff is the durable session-level worktree surface:

- A worktree session created or switched through `/worktree-*` is durably grouped under its base repo
  by stamping `session.project` with the base repo path before the replacement host starts.
- The sidebar can attach a `FolderGit2` badge and tooltip to sessions whose `sessionId` appears in
  the current host's announced `WorktreeSummary[]`, excluding the baseline row.
- The sidebar does not infer worktree identity from paths. `WorktreeSummary.path` is display-only and
  home-abbreviated; `SessionSummary.projectPath` is an identity path. `sessionId` is the only join key
  for badge/status attachment.

This cutoff does not promise an all-project worktree index. The left sidebar lists all projects, but
today the web read model only has `readModel.worktrees` from the viewed session's latest
`host.online`, and the host announces worktrees for its current base repo only. Therefore badges are
best-effort for rows covered by the currently viewed host's worktree snapshot. Grouping is durable and
offline because it comes from `session.project`; badge attachment is online/snapshot-scoped.

### Deferred Follow-Up

These items are accepted follow-up work, not blockers for the current cutoff:

- An all-project worktree metadata source for badges/status across every project in the sidebar.
- Merged detection and disabled "merged" rows.
- Orphaned/missing disabled rows and reconcile-driven sidebar refresh polish.
- Last-commit tooltip enrichment.

Those follow-ups need their own data-source and cadence decisions before implementation. In
particular, merged/orphan status across all sidebar projects cannot be made reliable from only the
currently viewed host's `host.online` snapshot.

### Boundaries

```
apps/agent-host/src/session/session-switch.ts
  switchToWorkspace - for reason === "worktree", publish session.project to the target session before
                      spawning the replacement host or emitting session.switch.
  SessionSwitchDeps - add baseRepoFor(cwd), publishToSession(sessionId, event), and an injectable
                      spawn seam for deterministic unit tests.

apps/agent-host/src/worktrees/
  manager.ts        - existing contextFor(cwd).baseRepo backs baseRepoFor; no registry schema change.
  commands.ts       - /worktree-switch and /worktree-new keep routing through switchToWorkspace with
                      reason === "worktree".

apps/web/src/sidebar/
  project-sidebar-model.ts - introduce a row view model carrying { summary, worktree }; group by
                             sessionProjectPath(summary), join worktree by sessionId.
  project-sidebar.tsx      - render WorktreeBadge beside the session title without colliding with the
                             existing right-side timestamp/actions slot.
  worktree-badge.tsx       - new badge + Radix tooltip component.
```

No protocol change is required for the current cutoff. It reuses existing `WorktreeSummary` fields:
`baseRepo`, `branch`, `path`, `sessionId`, `dirty`, `ahead`, `behind`, `conflict`, `detached`,
`current`, `baseline`, and `missing`.

### Observability

The current cutoff is observable through existing surfaces:

- The target session log contains the `session.project` marker before the replacement host's
  `host.online`.
- The source session log contains the existing command result and `session.switch`.
- If base-repo resolution fails for a worktree switch, the switch fails before spawning a replacement
  host and surfaces the existing command failure path instead of silently creating an incorrectly
  grouped session.

Tests must pin the order of the target marker relative to spawn and `session.switch`; this replaces a
new runtime diagnostics surface.

---

## 2. Current-Cutoff Milestones

### M1: Host stamps `session.project` with the base repo before worktree spawn

- **Dependencies:** none
- **Effort:** M
- **Rationale:** `/worktree-switch` and `/worktree-new` run inside the host, not through the
  supervisor launch path. Today `switchToWorkspace` is called with `workspace` equal to the worktree
  path, so an unstamped session falls back to grouping by that worktree path. The target session needs
  a durable base-repo marker before its replacement host starts, matching the supervisor's
  project-launch ordering.
- **Tasks:**
  1. RED: Add a host unit test for `switchToWorkspace({ reason: "worktree" })` using an injected
     spawn seam and recording deps. Assert call order:
     `ensureSession(target)` -> `publishToSession(target, session.project(baseRepo))` ->
     `spawnReplacementHost(target)` -> `emit(session.switch(target, "worktree"))`.
  2. RED: Add a failure test proving a worktree switch with no `baseRepoFor(cwd)` fails before spawn
     and does not emit `session.switch`.
  3. GREEN: Add `baseRepoFor(cwd): string | null`, `publishToSession(sessionId, event)`, and an
     injectable `spawnReplacementHost` seam to `SessionSwitchDeps`. For `reason === "worktree"`,
     resolve the base repo and publish `events.sessionProject({ path: baseRepo })` to
     `opts.sessionId` before spawn. Do not use `emit` for this marker, because `emit` writes to the
     current retiring session.
  4. GREEN: Wire `main.ts` with `baseRepoFor: (cwd) => worktrees.contextFor(cwd)?.baseRepo ?? null`
     and `publishToSession` backed by `transport.publishEvent(sessionId, toPublishInput(event,
     PRODUCER_ID))`.
  5. REFACTOR: Keep worktree base-repo resolution centralized on `WorktreeManager.contextFor`; do not
     re-derive the base repo from paths in `commands.ts` or `session-switch.ts`.

### M2: Sidebar grouping and scoped sessionId worktree join

- **Dependencies:** M1
- **Effort:** M
- **Rationale:** Project grouping and worktree badge attachment are separate joins. Grouping uses the
  durable project path already folded into `SessionSummary.projectPath`. Badge attachment uses only
  `WorktreeSummary.sessionId` from the current host's worktree snapshot.
- **Tasks:**
  1. RED: Add a model test proving a worktree session with `projectPath` equal to the base repo groups
     under the base repo project with no host online.
  2. RED: Add a model test proving `buildWorktreeSessionMap(worktrees)` attaches a non-baseline
     `WorktreeSummary` by `sessionId` and excludes `baseline === true`, so the main checkout session
     is never badged by the baseline row.
  3. RED: Add a model test proving no path inference occurs: a session whose paths look like a managed
     worktree but whose `sessionId` is absent from the supplied worktree snapshot receives no badge.
  4. GREEN: Introduce a sidebar row view model, e.g. `ProjectSessionRow { summary, worktree }`, and
     change `ProjectGroup.sessions` from `SessionSummary[]` to `ProjectSessionRow[]`. Keep project
     grouping keyed by `sessionProjectPath(summary)`.
  5. GREEN: Extend `buildProjectSidebar(projects, sessions, worktrees?)` and `useProjectSidebar` so
     `app.tsx` passes the current `readModel.worktrees`. Document and test that this is a
     current-host-scoped snapshot, not an all-project worktree index.

### M3: Worktree badge and tooltip on joined session rows

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add a web component test proving a session row with `row.worktree` renders a `FolderGit2`
     badge with accessible label `worktree`, and a row without `row.worktree` does not.
  2. GREEN: Add `worktree-badge.tsx`, using the existing Radix tooltip primitives and lucide
     `FolderGit2`.
  3. GREEN: Update `SessionRow` layout so the title, badge, and truncation share the left content area
     while the existing absolute right timestamp/actions slot remains stable.
  4. RED: Add tooltip tests for hover/focus content: branch, abbreviated worktree path, and git state
     (`clean`, `dirty`, `3 ahead`, `1 behind`, `conflict`, or `missing`).
  5. GREEN: Add Storybook stories for normal row, worktree row, long-title worktree row, and baseline
     no-badge regression.

### Current Cutoff Gate

- [ ] Worktree sessions created or switched through `/worktree-*` get a target-session
      `session.project` marker for the base repo before replacement-host spawn.
- [ ] Worktree sessions with the durable marker group under the base repo project offline.
- [ ] The sidebar badge join keys only on `sessionId`, excludes baseline rows, and never infers from
      paths.
- [ ] Joined worktree rows show a `FolderGit2` badge with a tooltip.
- [ ] Non-worktree rows and baseline checkout rows are not badged.
- [ ] Lint, typecheck, web tests, agent-host tests, and the hermetic e2e lane pass.

---

## 3. Accepted/Deferred Follow-Up

### FP1: All-project worktree metadata source

- Define one host/supervisor-owned source for worktree metadata across all sidebar projects. Candidate
  approaches: extend session inventory with decoded latest-host worktrees per session, or expose a
  supervisor/launcher worktree registry read. The browser must not scan local state directly.
- Decide staleness and privacy rules. A stale host snapshot may still be useful for a badge, but live
  dirty/ahead/behind state must be labeled as stale or omitted.
- Add tests proving badges/status can attach to sessions outside the currently viewed host's base repo.

### FP2: Merged and orphaned disabled states

- Add `merged` only after FP1 or an equivalent data source exists. Otherwise merged rows would only be
  correct for the current base repo.
- Specify the merged-check owner and cadence before implementation. The check must not run on every
  incidental `announceOnline`; use a cache with explicit invalidation or a bounded periodic refresh.
- Resolve default branch with `refs/remotes/origin/HEAD`, then fallback to `main`, `master`, or skip.
- Define branch identity. Future merged detection should check the managed registry branch unless the
  plan explicitly supports retargeted/detached worktrees.
- Add protocol tests in lockstep for each new field: `events.ts`, `decode.ts`, `manager.ts`, and the
  `host.online` round trip/defaulting tests.

### FP3: Last-commit tooltip enrichment

- Add `lastCommit?: { hash: string; subject: string }` only after the data-source scope is settled.
- Add a `headCommitInfo` git helper or extend `headCommit`; the existing helper returns only the sha.
- Keep tooltip text bounded so long subjects cannot resize or overlap sidebar rows.

---

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Target marker lands after host spawn, so inventory temporarily groups by worktree path | high | medium | M1 pins publish-before-spawn ordering with a recording unit test | host |
| Sidebar badges appear only for the currently viewed host's base repo | medium | high | Explicit current-cutoff scope; FP1 owns an all-project metadata source | web |
| A path-based join accidentally badges the wrong row | high | medium | M2 adds a negative test and a single `sessionId` map helper that filters baseline rows | web |
| Pre-M1 worktree sessions remain grouped by worktree path | medium | medium | Current cutoff does not claim migration; they can be badged only when covered by a supplied snapshot until touched/restamped | host/web |
| Badge layout overlaps timestamps/actions on narrow sidebars or long titles | medium | medium | M3 requires stable left-content layout and long-title Storybook coverage | web |
| Future merged/orphan status is stale or current-repo-only | high | medium | Deferred until FP1 data source and cadence are decided | host/web |

---

## 5. Escape Hatches

1. **If target-session stamping is too invasive:** keep grouping unchanged and ship only the scoped
   badge for current-host worktree rows. This preserves visibility without changing durable project
   binding, but leaves worktree sessions under their worktree-path project.

2. **If the badge crowds the row:** show only the `FolderGit2` icon with tooltip and no inline branch
   text. The path remains tooltip-only.

3. **If current-host-scoped badges are confusing:** ship M1 grouping first, hide badges behind FP1, and
   add the all-project metadata source before rendering any badge.

---

## Decisions

Canonical decisions are in the plan database (`.plans/58.2-worktree-sidebar-surface/plan.db`).

### Decision Reconciliation

- D-007 narrows the active implementation cutoff. D-002's merged-detection direction is retained only
  for deferred FP2, not for the current cutoff.
- D-008 supersedes the raw `SessionSwitchDeps.transport` widening detail in D-001. The current plan
  uses a `publishToSession(sessionId, event)` seam so producer stamping remains in `main.ts`.
- D-009 narrows D-006's badge join claim to the worktree summaries actually supplied to the sidebar.
  The `sessionId` join is still the only valid badge join, but it is current-host-scoped until FP1.

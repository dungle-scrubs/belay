# Missing Project Root Handling - Implementation Plan

## 0. Hard Dependencies

- [x] `58-project-sidebar-sessions` (merged) - the shared project registry, `projects.list` over the
  supervisor control channel, and the project sidebar this plan decorates.
- [x] `44.1` supervisor foundation (merged) - `session.launch.requested` / `session.launch.result`
  and the `@trevor/launcher` extraction (`launch.ts`, `platform.ts`, `project-registry.ts`).
- [x] Downstream accommodation: none required. `projects.list.result` gains an additive `missing`
  field; the failed-launch result already exists in the protocol and merely starts firing where the
  supervisor previously crashed. Plans 46/48/49/57/58.6 were read and skipped - no contract they
  depend on changes shape. <!-- D-002 -->

## 1. Problem

Deleting a project's folder (typically a worktree) leaves its registry record behind. A launch into
that record today reaches `spawnHost` (`packages/launcher/src/platform.ts`), whose `spawn(...,
{ cwd: root })` emits an asynchronous `ENOENT` `error` event with no listener attached: the
supervisor process dies from the unhandled event BEFORE `handleLaunch`
(`apps/supervisor/src/dispatch.ts`) can publish any `session.launch.result`. The web launch machine
(`apps/web/src/new-session/use-launch.ts`) has no timeout on the result wait itself - its 30s
`HOST_ONLINE_TIMEOUT_MS` only arms after a `launched` result - so the UI shows "Starting host..."
forever. Evidence: `hosts.json` records `pid: -1` for the failed session, a 0-byte host log, and the
verbatim unhandled-`error` ENOENT crash in `supervisor.log` (2026-07-10, session `4d4e3870-...`).

## 2. Architecture

Three layers, all on existing seams; no new services, no scheduler. <!-- D-002 -->

1. **Launcher guard (fail, never crash).** `launchInner` pre-checks that the resolved root exists
   before spawning, and `spawnHost` attaches an `error` listener to the child so a root deleted
   between check and spawn still surfaces as a rejection of the `launch()` promise (typed
   `missing-root` error carrying the path), never as an uncaught exception. <!-- D-003 -->
2. **Supervisor surfacing.** `handleLaunch`'s existing catch turns that rejection into
   `session.launch.result { status: "failed", reason: "project folder no longer exists: <path>" }`.
   Serving `projects.list` stats each registry record's path and adds `missing: boolean` to the
   result payload - the passive signal rides a read the sidebar already performs. Records are NEVER
   auto-pruned; removal stays the user's explicit Remove action. <!-- D-001 -->
3. **Web surfacing.** `useLaunch` gains a result-wait timeout folding into the existing `failed`
   phase (Retry affordance), so a lost result can never hang the launch UI. <!-- D-004 --> The
   sidebar threads `missing` through `ProjectSidebarRecord` into a red project name label with a
   tooltip naming the dead path; New-session on a missing project is blocked with the same message;
   the project's sessions stay listed, readable, renamable, and archivable (durable logs do not
   depend on the folder). Resume attempts into a missing root surface the M2 failed result through
   the normal resume-row error path. <!-- D-005 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Browser has no filesystem access | Every existence check lives supervisor-side; the web only renders flags and results. <!-- D-002 --> |
| Supervisor must survive any launch failure | The guard is in the launcher package so every caller (CLI, supervisor, fleet) inherits it. |
| No auto-pruning | The owner keeps two dead records (absolute + corrupt tilde-keyed `58-project-sidebar-sessions`) as standing test fixtures; the plan must work against them, not delete them. <!-- D-001 --> |
| `projects.list.result` change is additive | Older consumers ignore `missing`; no downstream plan edits needed. |

### Observability

The failed launch is itself the observability surface: the typed `missing-root` rejection carries
the offending path, the supervisor log records the failed dispatch (today it records a crash), and
the published failed result makes the reason user-visible in the launch UI and resume row.

## 3. Phase 1: fail closed, surface everywhere

**Goal:** a launch into a deleted folder produces a visible, retryable failure and a red sidebar
label - and can no longer kill the supervisor.

#### M1: Launcher missing-root guard

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `launch()` from `packages/launcher/src/launch.ts`; `spawnHost` error path.
  2. RED: launching with a nonexistent root rejects with a typed `missing-root` error naming the
     path (no process crash, no `hosts.json` `pid: -1` record).
  3. GREEN: pre-check the root in `launchInner` before `spawnHost`.
  4. RED: a spawn whose child emits `error` (root vanishes between check and spawn / bad
     executable) rejects the `launch()` promise instead of throwing an uncaught event.
  5. GREEN: attach the child `error` listener in `spawnHost` and route it into the launch failure
     path; do not record a host on a failed spawn.
  6. REFACTOR: consolidate the launcher's failure taxonomy so CLI and supervisor callers share one
     typed error surface.

#### M2: Supervisor failed result + `missing` flag on projects.list

- **Dependencies:** M1
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `handleLaunch` / `handleProjectsList` in `apps/supervisor/src/dispatch.ts`.
  2. RED: a `session.launch.requested` whose root does not exist yields
     `session.launch.result { status: "failed" }` with the missing-folder reason, and the
     supervisor keeps serving subsequent requests.
  3. GREEN: map the M1 typed error into the failed result's reason string.
  4. RED: `projects.list.result` marks a record whose path does not exist with `missing: true`
     (and `false` for a live one); the record itself is not removed. <!-- D-001 -->
  5. GREEN: stat each record while serving the list; extend the result type additively.
  6. REFACTOR: single owner for the path-existence check shared by launch gate and list marking.

#### M3: Web result-wait timeout

- **Dependencies:** M2
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `useLaunch` (`apps/web/src/new-session/use-launch.ts`) via its existing
     deterministic hook tests.
  2. RED: a launch whose `session.launch.result` never arrives folds to the `failed` phase with a
     timeout message after the result-wait deadline; Retry re-enters `starting`. <!-- D-004 -->
  3. GREEN: arm a result-wait timer at publish time, cleared by any result; reuse the guard-token
     reset semantics so a superseded launch's timer never fires late.
  4. RED: a `failed` result with the missing-folder reason renders that reason in the launch UI
     and resume row (no generic "something went wrong").
  5. GREEN: thread the reason string through the existing failed-state surfaces.
  6. REFACTOR: name the two timeouts (`result-wait`, `host-online`) so the machine reads as two
     explicit phases.

#### M4: Sidebar missing-project treatment

- **Dependencies:** M2
- **Effort:** S
- **Testing:** test-after (storybook-first presentational UI; behavioral assertions land as jsdom
  tests after wiring)
- **Tasks:**
  1. Thread `missing` through the supervisor projects mapping into `ProjectSidebarRecord` and
     `ProjectGroup` (`apps/web/src/sidebar/project-sidebar-model.ts`).
  2. Storybook story: a missing project renders its name label red with a tooltip naming the dead
     path; sessions still listed beneath it. <!-- D-005 -->
  3. Wire production rendering in `project-sidebar.tsx` (`ProjectLabel` treatment; fixed row
     heights unchanged).
  4. Block New-session on a missing project (hover button and context menu) with the
     missing-folder message; Remove stays available; Archive/rename on its sessions untouched.
  5. Verify: jsdom tests for red-label presence, blocked new-session, and untouched
     archive/rename; manual pass against the owner's two standing dead records.

### Gate

- [ ] With the two dead registry records still present: supervisor stays alive across repeated
  launch attempts, the web shows the failed reason with Retry, the sidebar shows both records with
  red labels, and their sessions remain readable and archivable.

## 4. Non-Goals

- Auto-pruning or repairing registry records (including the corrupt tilde-keyed duplicate) - manual
  Remove only. <!-- D-001 -->
- Scheduled or filesystem-watch revalidation - the two supervisor seams are the only check sites.
  <!-- D-002 -->
- Desktop-shell (plan 48) specifics - it inherits all of this through the shared web UI and
  `@trevor/launcher`.
- A general supervisor `uncaughtException` policy - worth its own discussion; this plan removes the
  known crash source at the seam that owns it.

## 5. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Stat-per-record slows `projects.list` on large registries | low | low | It is one `existsSync` per project on a local disk; registries are user-scale (tens). |
| TOCTOU: folder deleted between pre-check and spawn | low | medium | M1's second RED covers it - the child `error` listener makes the window safe. |
| Red label read as "error in sessions" rather than "folder gone" | low | medium | Tooltip names the missing path; blocked New-session repeats the message. |

## 6. Validation Commands

```bash
pnpm vitest run --project unit packages/launcher
pnpm vitest run --project integration apps/supervisor
pnpm vitest run --project web src/new-session src/sidebar
```

## 7. Decisions

Canonical decisions live in `.plans/58.8-missing-project-root/plan.db` (D-001..D-005), all
`decided-by human` (owner conversation, 2026-07-10). Query with `plan-db query-decisions --plan
"58.8-missing-project-root"`.

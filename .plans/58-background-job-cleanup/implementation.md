# Background Job Cleanup - Implementation Plan

## 0. Hard Dependencies

None. The plan extends the shipped process supervisor, command registry, process tool, and support panel.

## 1. Architecture

Trevor already promotes long-running shell/process work into host-owned `JobSnapshot`s announced on `host.online`. The current registry changes a finished child to `status: "exited"` but keeps the job in memory, so the web continues to render a `done` row. This plan adds explicit cleanup semantics for those terminal jobs without hiding live work or forking browser-local state.

Cleanup is host-owned: `ProcessRegistry` deletes terminal jobs from its in-memory map, then the existing `supervisor.onChange = announceOnline` path publishes a fresh `host.online` without the removed snapshots. Running jobs cannot be dismissed; they must be stopped first through the existing kill path. <!-- D-001 -->

The cleanup surface is intentionally three-layered. Slash commands give the user a textual path, process tool actions give the model a way to clean up after promoted commands, and the web gives direct dismiss affordances for terminal rows/detail panels. No layer invents its own hidden state; every surface calls back to the same host registry operation. <!-- D-002 -->

Auto-prune is a later behavior in this plan, not the foundation. Manual dismissal ships first. Then successful exited jobs may disappear after a short grace period; failed and killed jobs remain until explicitly dismissed in the first cut because their tails are diagnostic evidence. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Host owns job truth | Browser state never locally hides jobs; cleanup mutates the supervisor snapshot and re-announces `host.online`. |
| Running jobs are not dismissible | Cleanup cannot become a disguised kill. Running rows continue to use stop/kill. |
| Terminal output remains inspectable until cleanup | Manual dismissal is explicit; auto-prune starts only with successful exits and after a grace period. |
| Model and user both need access | Add process tool actions and slash/UI surfaces rather than making either actor responsible alone. |
| No durable job log in this cut | Jobs stay in the existing host-memory model; this plan does not add persisted process history. |

### Boundaries

- `apps/agent-host/src/processes/process-registry.ts` owns `dismiss(id)`, `clearCompleted()`, and any auto-prune timer bookkeeping.
- `apps/agent-host/src/processes/processes.ts` owns the process tool schema/actions for `dismiss` and `clear_completed`.
- `apps/agent-host/src/commands/commands.ts` owns `/jobs-dismiss <id>` and `/jobs-clear-completed`.
- `apps/web/src/support-panel/` owns the job row/detail cleanup presentation model.
- `apps/web/src/app.tsx` dispatches cleanup commands from UI actions and keeps the detail panel coherent when its job disappears.
- `packages/session/src/protocol/events.ts` does not need a new durable event unless implementation discovers a real cross-host need; the current contract remains `host.online.jobs`.

### Observability

Cleanup is visible through existing surfaces:

- `/jobs` reflects dismissed jobs because `supervisor.list()` no longer includes them.
- `host.online.jobs` changes after every cleanup and remains the web's source of truth.
- Failed cleanup attempts return explicit command/tool errors, especially unknown ids and attempts to dismiss a running job.
- Tests should assert `onChange` fires for successful terminal cleanup and does not fire for refused cleanup.

## 2. Relationship to Existing Plans

This is an independent plan at `58-background-job-cleanup`. There is no active implementation plan to decimal off, and no existing plan owns completed background job cleanup. <!-- D-004 -->

Relevant later-plan interactions were considered:

- `46-worktree-fleet` uses durable background runs and workflow lifecycle, not the process supervisor's promoted shell jobs. No accommodation needed.
- `48-desktop-shell-tauri` may later supervise host/process lifecycle, but it should consume the same host job semantics. No plan edit needed because this plan does not change desktop's supervision boundary.
- `50-cli-headless-agent-surface` leaves hosts running after headless prompts; cleaner job snapshots help that surface, but plan 50 does not render or own background job cleanup. No accommodation needed.
- `57-claude-agent-sdk-source` concerns provider integration, not process job cleanup. No accommodation needed.

## 3. Phases

### Phase 1: Host Cleanup Contract

**Goal:** The host can remove terminal jobs from the supervisor snapshot, while refusing to dismiss running work.

**Gate from previous:** none.

#### M1: Registry Cleanup Primitives

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add `ProcessRegistry` tests showing `dismiss(id)` removes an exited job and triggers `onChange`.
  2. GREEN: Implement `dismiss(id)` for terminal jobs.
  3. RED: Add tests showing `dismiss(id)` refuses unknown ids and running jobs without removing them.
  4. GREEN: Return typed/structured errors for unknown and running-job dismissal.
  5. RED: Add tests showing `clearCompleted()` removes exited/killed jobs, keeps running jobs, and triggers one visible change.
  6. GREEN: Implement `clearCompleted()`.
  7. REFACTOR: Keep terminal detection in one helper shared by dismiss, clear, and later auto-prune.

### Gate 1 to 2

- [ ] Registry cleanup tests pass.
- [ ] Existing promotion/list/poll/kill behavior remains unchanged.
- [ ] `snapshots()` only omits jobs after a successful cleanup operation.

### Phase 2: Command and Tool Surfaces

**Goal:** Users and the model can clean up completed jobs through existing host interaction surfaces.

**Gate from previous:** Phase 1 complete.

#### M2: Slash Commands

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add command tests for `/jobs-dismiss <id>` against completed, running, and unknown jobs.
  2. GREEN: Add `/jobs-dismiss <id>` wired to `supervisor.dismiss`.
  3. RED: Add command tests for `/jobs-clear-completed` with mixed running/terminal jobs.
  4. GREEN: Add `/jobs-clear-completed` returning a concise count summary.
  5. REFACTOR: Share result text helpers so command output stays consistent with `/jobs-stop`.

#### M3: Process Tool Actions

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add process tool tests for `action: "dismiss"` and `action: "clear_completed"`.
  2. GREEN: Extend the process tool schema and executor with the cleanup actions.
  3. RED: Add tests proving running-job dismissal returns a tool error and does not kill the child.
  4. GREEN: Preserve the existing kill-only path for stopping live jobs.
  5. REFACTOR: Update the tool description so the model distinguishes stop, dismiss, and clear-completed.

### Gate 2 to 3

- [ ] Slash command tests pass.
- [ ] Process tool tests pass.
- [ ] The model-facing tool description clearly says dismissal is terminal-only.

### Phase 3: Web Dismiss Affordance

**Goal:** Terminal job rows/details can be dismissed directly from the UI without hiding host truth locally.

**Gate from previous:** Phase 2 complete.

#### M4: Support Panel and Detail Actions

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add support-panel projection tests showing terminal jobs expose a dismiss affordance and running jobs do not.
  2. GREEN: Extend the support-panel row model with a terminal cleanup action.
  3. RED: Add web tests showing a terminal job detail can dispatch cleanup and closes or clears when the job disappears.
  4. GREEN: Wire the UI action through the existing command dispatch path to `/jobs-dismiss <id>`.
  5. RED: Add accessibility/label tests for the dismiss control.
  6. GREEN: Render the dismiss control with an icon button and tooltip on terminal job rows/details.
  7. REFACTOR: Keep job stop and job dismiss action naming separate in the component props.

### Gate 3 to 4

- [ ] Web tests pass in the `web` Vitest project.
- [ ] Terminal jobs can be dismissed without a full page refresh.
- [ ] Running jobs still show stop behavior, not dismiss behavior.

### Phase 4: Conservative Auto-Prune

**Goal:** Successful completed jobs clean themselves up after a short visible grace period, while failures remain inspectable.

**Gate from previous:** Phase 3 complete.

#### M5: Successful Exit Auto-Prune

- **Dependencies:** M1, M4
- **Effort:** M
- **Tasks:**
  1. RED: Add registry tests with fake timers showing successful exited jobs are pruned after the configured grace period.
  2. GREEN: Schedule auto-prune for `status: "exited"` with `exitCode === 0`.
  3. RED: Add tests showing failed, killed, and running jobs are not auto-pruned.
  4. GREEN: Limit auto-prune to clean exits only.
  5. RED: Add tests proving manual dismiss cancels any pending prune timer and `killAll()` does not leak timers.
  6. GREEN: Clear prune timers on dismiss, clear-completed, kill, and teardown.
  7. REFACTOR: Isolate timer policy constants and keep them test-controllable.

### Gate 4 to Ready

- [ ] Auto-prune tests pass with deterministic timers.
- [ ] Failed/killed output remains visible until manual dismissal.
- [ ] `host.online` re-announces exactly when a job is pruned.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Lost diagnostic output after cleanup | Medium | Medium | Manual cleanup first; auto-prune only successful exits and after a grace period. | Host/UI |
| Cleanup accidentally kills running work | High | Low | Refuse running dismissals and test that child status remains running. | Host |
| Browser hides stale jobs locally | Medium | Low | UI dispatches host command only; render remains derived from `host.online.jobs`. | Web |
| Tool schema change confuses model behavior | Medium | Medium | Explicit tool description and tests for stop vs dismiss semantics. | Host |
| Timer leaks from auto-prune | Medium | Medium | Timer cleanup tests and a small registry-owned timer map. | Host |

## Escape Hatches

1. **If UI row affordances make the support panel too busy:** ship detail-only dismiss plus slash/tool cleanup, then revisit row-level controls.
2. **If auto-prune causes unwanted loss of output:** keep M5 unimplemented or feature-flagged; manual dismissal remains complete.
3. **If process tool schema churn is risky for current models:** ship slash/UI cleanup first, then add process tool actions after additional model-prompt testing.

## Progress Report Accounting

The progress report is the implementation resume state. Current-cutoff blockers count only unchecked active work. Auto-prune is part of this plan but sequenced after manual dismissal; if it is deferred during implementation, move Phase 4 under accepted/deferred follow-up and update the summary counts.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58-background-job-cleanup"
```

## Validation Commands

```bash
pnpm --filter @trevor/agent-host test
pnpm --filter @trevor/web test -- --project web
pnpm test -- --project unit --project web
pnpm lint
pnpm typecheck
```

## Decisions

Canonical decisions are in `.plans/58-background-job-cleanup/plan.db`.

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "58-background-job-cleanup"
```

Key decisions referenced in this document use `<!-- D-### -->` markers.

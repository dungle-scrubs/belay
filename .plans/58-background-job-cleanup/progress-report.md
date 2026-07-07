# Background Job Cleanup - Progress Report

Current focus: Phase 4 M5 - Successful Exit Auto-Prune

## Summary

- **Current cutoff blockers:** 15
- **Completed current cutoff:** 33
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## Phase 1: Host Cleanup Contract

### M1: Registry Cleanup Primitives

- [x] RED: Add `ProcessRegistry` tests showing `dismiss(id)` removes an exited job and triggers `onChange`.
- [x] GREEN: Implement `dismiss(id)` for terminal jobs.
- [x] RED: Add tests showing `dismiss(id)` refuses unknown ids and running jobs without removing them.
- [x] GREEN: Return typed/structured errors for unknown and running-job dismissal.
- [x] RED: Add tests showing `clearCompleted()` removes exited/killed jobs, keeps running jobs, and triggers one visible change.
- [x] GREEN: Implement `clearCompleted()`.
- [x] REFACTOR: Keep terminal detection in one helper shared by dismiss, clear, and later auto-prune.

### Gate 1 to 2

- [x] Registry cleanup tests pass.
- [x] Existing promotion/list/poll/kill behavior remains unchanged.
- [x] `snapshots()` only omits jobs after a successful cleanup operation.

## Phase 2: Command and Tool Surfaces

### M2: Slash Commands

- [x] RED: Add command tests for `/jobs-dismiss <id>` against completed, running, and unknown jobs.
- [x] GREEN: Add `/jobs-dismiss <id>` wired to `supervisor.dismiss`.
- [x] RED: Add command tests for `/jobs-clear-completed` with mixed running/terminal jobs.
- [x] GREEN: Add `/jobs-clear-completed` returning a concise count summary.
- [x] REFACTOR: Share result text helpers so command output stays consistent with `/jobs-stop`.

### M3: Process Tool Actions

- [x] RED: Add process tool tests for `action: "dismiss"` and `action: "clear_completed"`.
- [x] GREEN: Extend the process tool schema and executor with the cleanup actions.
- [x] RED: Add tests proving running-job dismissal returns a tool error and does not kill the child.
- [x] GREEN: Preserve the existing kill-only path for stopping live jobs.
- [x] REFACTOR: Update the tool description so the model distinguishes stop, dismiss, and clear-completed.

### Gate 2 to 3

- [x] Slash command tests pass.
- [x] Process tool tests pass.
- [x] The model-facing tool description clearly says dismissal is terminal-only.

## Phase 3: Web Dismiss Affordance

### M4: Support Panel and Detail Actions

- [x] RED: Add support-panel projection tests showing terminal jobs expose a dismiss affordance and running jobs do not.
- [x] GREEN: Extend the support-panel row model with a terminal cleanup action.
- [x] RED: Add web tests showing a terminal job detail can dispatch cleanup and closes or clears when the job disappears.
- [x] GREEN: Wire the UI action through the existing command dispatch path to `/jobs-dismiss <id>`.
- [x] RED: Add accessibility/label tests for the dismiss control.
- [x] GREEN: Render the dismiss control with an icon button and tooltip on terminal job rows/details.
- [x] REFACTOR: Keep job stop and job dismiss action naming separate in the component props.

### Gate 3 to 4

- [x] Web tests pass in the `web` Vitest project.
- [x] Terminal jobs can be dismissed without a full page refresh.
- [x] Running jobs still show stop behavior, not dismiss behavior.

## Phase 4: Conservative Auto-Prune

### M5: Successful Exit Auto-Prune

- [ ] RED: Add registry tests with fake timers showing successful exited jobs are pruned after the configured grace period.
- [ ] GREEN: Schedule auto-prune for `status: "exited"` with `exitCode === 0`.
- [ ] RED: Add tests showing failed, killed, and running jobs are not auto-pruned.
- [ ] GREEN: Limit auto-prune to clean exits only.
- [ ] RED: Add tests proving manual dismiss cancels any pending prune timer and `killAll()` does not leak timers.
- [ ] GREEN: Clear prune timers on dismiss, clear-completed, kill, and teardown.
- [ ] REFACTOR: Isolate timer policy constants and keep them test-controllable.

### Gate 4 to Ready

- [ ] Auto-prune tests pass with deterministic timers.
- [ ] Failed/killed output remains visible until manual dismissal.
- [ ] `host.online` re-announces exactly when a job is pruned.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

## Verification

- [ ] `pnpm --filter @trevor/agent-host test`
- [ ] `pnpm --filter @trevor/web test -- --project web`
- [ ] `pnpm test -- --project unit --project web`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`

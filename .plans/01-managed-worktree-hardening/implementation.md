# Managed Worktree Hardening - Implementation Plan

## 0. Hard Dependencies

- [x] D-091 managed worktree registry/storage is complete in `.plans/trevor-v2/progress-report-done.md`.
- [x] D-089 shared command modal foundation is complete and already used by the worktree switcher.
- [x] D-091 create/open/switch flow is complete through `WorktreeManager` and host worktree commands.
- [x] D-091 safety/isolation is complete for active-run blocking, per-session lock reuse, prompt/context reset, and no transcript leakage.
- [x] D-091 diff/merge/delete/reconcile host commands are complete.
- [x] Existing per-session host locking from D-085 serializes duplicate hosts for the same deterministic worktree session id.

## Scope

This is not a rebuild of D-091. The main managed-worktree feature is already implemented and archived. This plan owns the remaining hardening extracted from the D-091 carry-forward rows:

- a dedicated cwd-path advisory lock beyond the existing per-session lock
- a live two-host worktree smoke that proves real process behavior under contention

The plan may add small diagnostics or `/doctor` visibility only where needed to make those two hardening goals inspectable. It does not reopen the completed worktree registry, switcher, create/switch flow, merge/delete/reconcile commands, or command modal UX.

## Architecture

The current implementation protects a managed worktree primarily by mapping each worktree to a deterministic durable session id and using the existing per-session lock. That works for Trevor-owned worktrees opened through the normal path, but it does not explicitly protect the cwd path as a resource. A dedicated cwd-path advisory lock should make the safety boundary visible and enforceable even if two host/session identities attempt to target the same directory.

The live smoke should exercise the actual host/launcher/switch behavior, not just unit-level helpers, because the risk is cross-process contention.

### Key Constraints

| Constraint | Impact |
|---|---|
| Do not duplicate completed D-091 work | This plan only hardens lock semantics and live verification. |
| Cwd lock is advisory | It should block Trevor-owned mutating host ownership conflicts without pretending to control arbitrary external processes. |
| Locks must be stale-safe | Crash/restart behavior needs owner metadata, heartbeat or mtime policy, and clear repair guidance. |
| Worktree operations remain explicit | Locking should not create implicit session resume, transcript merge, or hidden workspace switching. |
| Smoke must be real-process enough | Unit tests are not sufficient for the extracted live two-host concern. |

### Boundaries

- Lock ownership belongs in host/launcher workspace ownership code, not in the web UI.
- Worktree registry remains responsible for worktree records, not process ownership.
- `/doctor` or debug diagnostics may summarize cwd lock state, but should not repair or mutate locks by default.
- The smoke harness owns multi-host lifecycle setup/teardown and must use temporary repos/worktrees.

### Observability

The hardening must make contention explainable:

- cwd path, normalized/realpath identity, owning session id, owning host id, pid when available, and last heartbeat/mtime
- blocked acquisition reason and recommended next action
- stale lock classification with a clear non-mutating diagnostic path
- smoke artifacts/logs for two-host contention, switch-back behavior, and cleanup

## Phases

### Phase 1: Cwd Advisory Lock Contract

**Goal:** Define and test the explicit cwd-path lock semantics without changing completed worktree behavior.

**Gate from previous:** Hard dependencies are complete.

#### M1: Contract and Placement

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add tests or a design checklist for normalized cwd identity, owner metadata, stale behavior, and conflict messages.
  2. GREEN: Define where the cwd lock lives under `TREVOR_HOME` and how it differs from existing per-session locks.
  3. RED: Add tests proving non-worktree cwd and managed-worktree cwd use the same path-ownership rules where appropriate.
  4. GREEN: Specify acquisition/release points for host launch, workspace switch, worktree switch, and shutdown.
  5. REFACTOR: Keep lock policy separate from worktree registry persistence.

#### M2: Lock Acquisition and Diagnostics

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for two different session ids targeting the same real cwd.
  2. GREEN: Implement advisory lock acquisition that blocks conflicting Trevor-owned mutating hosts.
  3. RED: Add stale lock and owner-missing tests.
  4. GREEN: Add safe stale handling and user-visible diagnostics without automatic destructive cleanup.
  5. REFACTOR: Surface lock failures as typed errors reused by worktree switch/open paths.

### Gate 1-2

- [ ] Cwd-path lock identity is normalized and tested.
- [ ] Conflicting Trevor-owned mutating hosts are blocked before workspace mutation.
- [ ] Stale lock behavior is observable and safe.
- [ ] Completed D-091 create/switch/merge behavior does not regress.

### Phase 2: Live Two-Host Worktree Smoke

**Goal:** Verify real multi-host/worktree behavior under contention and normal switch flows.

#### M3: Smoke Harness

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add a gated smoke scenario for temp repo setup, managed worktree creation, and host launch.
  2. GREEN: Boot two host processes against the same worktree target and assert one is blocked or reuses safely.
  3. RED: Add smoke coverage for create, switch to worktree, switch back to baseline, dirty display, and blocked switching while running.
  4. GREEN: Capture logs/artifacts that make failures diagnosable.
  5. REFACTOR: Keep the smoke gated so it does not destabilize default CI.

#### M4: Operator-Facing Verification

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add documentation or a runbook for manually reproducing two-host worktree contention.
  2. GREEN: Document expected `/doctor` or debug output for cwd lock/worktree ownership.
  3. RED: Add a regression checklist for cleanup after failed smoke runs.
  4. GREEN: Ensure temp repos, worktrees, locks, and host processes are cleaned up reliably.

### Done Gate

- [ ] Dedicated cwd-path advisory lock is implemented or explicitly rejected with recorded rationale.
- [ ] Live two-host worktree smoke exists and is gated with clear skip/failure reasons.
- [ ] Worktree create/switch/merge/delete/reconcile behavior remains unchanged except for safer contention handling.
- [ ] Diagnostics explain owner, cwd, session, and stale lock states.
- [ ] The umbrella progress report no longer owns D-091 carry-forward rows.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Cwd lock conflicts with legitimate multi-view read-only use | high | medium | Scope lock to mutating host ownership, not passive browser/observer clients. | host |
| Stale lock blocks normal startup | high | medium | Owner metadata, stale classification, and explicit repair guidance. | host |
| Smoke becomes flaky | medium | medium | Gate it, isolate temp repos, capture logs, and skip with stated prerequisites. | e2e |
| Lock duplicates per-session lock logic | medium | medium | Keep cwd lock as path ownership, per-session lock as process/session ownership. | host |

## Escape Hatches

1. **If dedicated cwd locks add more failure modes than safety:** keep per-session locking as the accepted model, record the rationale, and retain only the two-host smoke.
2. **If full two-host smoke is too expensive for CI:** make it a local/nightly gated lane with deterministic temp repo setup.

## Progress Report Accounting

This plan owns only the extracted D-091 hardening rows. Completed D-091 implementation remains archived in `.plans/trevor-v2/progress-report-done.md` and is counted here only as hard-dependency context.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "01-managed-worktree-hardening"
```

## Validation Commands

```bash
pnpm test -- --project unit --run apps/agent-host/src/worktrees
pnpm test -- --project integration --run apps/agent-host
pnpm test -- --project e2e --run e2e
```

## Decisions

Canonical decisions are in `.plans/01-managed-worktree-hardening/plan.db`.

# Managed Worktree Hardening - Progress Report

## Summary

- **Current cutoff blockers:** 28
- **Completed current work:** 6
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Contract and Placement

## Completed Current State / Hard Dependencies

- [x] D-091 managed worktree registry/storage is complete in `.plans/trevor-v2/progress-report-done.md`.
- [x] D-089 shared command modal foundation is complete and already used by the worktree switcher.
- [x] D-091 create/open/switch flow is complete through `WorktreeManager` and host worktree commands.
- [x] D-091 safety/isolation is complete for active-run blocking, per-session lock reuse, prompt/context reset, and no transcript leakage.
- [x] D-091 diff/merge/delete/reconcile host commands are complete.
- [x] Existing per-session host locking from D-085 serializes duplicate hosts for the same deterministic worktree session id.

## Current Cutoff Blockers

### M1 - Contract and Placement

- [ ] RED: Add tests or a design checklist for normalized cwd identity, owner metadata, stale behavior, and conflict messages.
- [ ] GREEN: Define where the cwd lock lives under `TREVOR_HOME` and how it differs from existing per-session locks.
- [ ] RED: Add tests proving non-worktree cwd and managed-worktree cwd use the same path-ownership rules where appropriate.
- [ ] GREEN: Specify acquisition/release points for host launch, workspace switch, worktree switch, and shutdown.
- [ ] REFACTOR: Keep lock policy separate from worktree registry persistence.

### M2 - Lock Acquisition and Diagnostics

- [ ] RED: Add tests for two different session ids targeting the same real cwd.
- [ ] GREEN: Implement advisory lock acquisition that blocks conflicting Trevor-owned mutating hosts.
- [ ] RED: Add stale lock and owner-missing tests.
- [ ] GREEN: Add safe stale handling and user-visible diagnostics without automatic destructive cleanup.
- [ ] REFACTOR: Surface lock failures as typed errors reused by worktree switch/open paths.

### Gate 1-2

- [ ] Cwd-path lock identity is normalized and tested.
- [ ] Conflicting Trevor-owned mutating hosts are blocked before workspace mutation.
- [ ] Stale lock behavior is observable and safe.
- [ ] Completed D-091 create/switch/merge behavior does not regress.

### M3 - Smoke Harness

- [ ] RED: Add a gated smoke scenario for temp repo setup, managed worktree creation, and host launch.
- [ ] GREEN: Boot two host processes against the same worktree target and assert one is blocked or reuses safely.
- [ ] RED: Add smoke coverage for create, switch to worktree, switch back to baseline, dirty display, and blocked switching while running.
- [ ] GREEN: Capture logs/artifacts that make failures diagnosable.
- [ ] REFACTOR: Keep the smoke gated so it does not destabilize default CI.

### M4 - Operator-Facing Verification

- [ ] RED: Add documentation or a runbook for manually reproducing two-host worktree contention.
- [ ] GREEN: Document expected `/doctor` or debug output for cwd lock/worktree ownership.
- [ ] RED: Add a regression checklist for cleanup after failed smoke runs.
- [ ] GREEN: Ensure temp repos, worktrees, locks, and host processes are cleaned up reliably.

### Done Gate

- [ ] Dedicated cwd-path advisory lock is implemented or explicitly rejected with recorded rationale.
- [ ] Live two-host worktree smoke exists and is gated with clear skip/failure reasons.
- [ ] Worktree create/switch/merge/delete/reconcile behavior remains unchanged except for safer contention handling.
- [ ] Diagnostics explain owner, cwd, session, and stale lock states.
- [ ] The umbrella progress report no longer owns D-091 carry-forward rows.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

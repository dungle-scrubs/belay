# Managed Worktree Hardening - Progress Report

## Summary

- **Current cutoff blockers:** 14
- **Completed current work:** 20
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M3 - Smoke Harness

## Completed Current State / Hard Dependencies

- [x] D-091 managed worktree registry/storage is complete in `.plans/trevor-v2/progress-report-done.md`.
- [x] D-089 shared command modal foundation is complete and already used by the worktree switcher.
- [x] D-091 create/open/switch flow is complete through `WorktreeManager` and host worktree commands.
- [x] D-091 safety/isolation is complete for active-run blocking, per-session lock reuse, prompt/context reset, and no transcript leakage.
- [x] D-091 diff/merge/delete/reconcile host commands are complete.
- [x] Existing per-session host locking from D-085 serializes duplicate hosts for the same deterministic worktree session id.

## Current Cutoff Blockers

### M1 - Contract and Placement

- [x] RED: Add tests or a design checklist for normalized cwd identity, owner metadata, stale behavior, and conflict messages. (`apps/agent-host/src/cwd-lock.test.ts` + `artifacts/cwd-lock-design.md`)
- [x] GREEN: Define where the cwd lock lives under `TREVOR_HOME` and how it differs from existing per-session locks. (state-home `cwd-locks/` inventory entry; not config home - see design doc; differs from per-session `locks/` by being keyed on realpath and held for the leader's lifetime)
- [x] RED: Add tests proving non-worktree cwd and managed-worktree cwd use the same path-ownership rules where appropriate. (`cwd-lock.test.ts` "a managed-worktree cwd and a non-worktree cwd obey the SAME path-ownership rule")
- [x] GREEN: Specify acquisition/release points for host launch, workspace switch, worktree switch, and shutdown. (`artifacts/cwd-lock-design.md` acquisition/release table)
- [x] REFACTOR: Keep lock policy separate from worktree registry persistence. (`cwd-lock.ts` standalone; imports nothing from `worktrees/`)

### M2 - Lock Acquisition and Diagnostics

- [x] RED: Add tests for two different session ids targeting the same real cwd. (`cwd-lock.test.ts` conflict + switch-gate suites)
- [x] GREEN: Implement advisory lock acquisition that blocks conflicting Trevor-owned mutating hosts. (`main.ts` `onBecomeLeader` acquires; `worktreeSwitch` blocks via `cwdSwitchConflict`)
- [x] RED: Add stale lock and owner-missing tests. (`cwd-lock.test.ts` stale-takeover + malformed/missing suites)
- [x] GREEN: Add safe stale handling and user-visible diagnostics without automatic destructive cleanup. (stale reclaimed only on next acquire; `/doctor` Workspace cwd-lock fact + finding, structured + plaintext; inspect is read-only)
- [x] REFACTOR: Surface lock failures as typed errors reused by worktree switch/open paths. (`CwdLockConflict` surfaced from the worktree-switch gate)

### Gate 1-2

- [x] Cwd-path lock identity is normalized and tested. (realpath identity; `cwd-lock.test.ts` aliasing + worktree/non-worktree parity)
- [x] Conflicting Trevor-owned mutating hosts are blocked before workspace mutation. (worktree-switch pre-check + leader-acquire conflict surfacing)
- [x] Stale lock behavior is observable and safe. (dead-pid + heartbeat-window staleness, `/doctor` stale finding, no auto-destructive cleanup)
- [x] Completed D-091 create/switch/merge behavior does not regress. (full agent-host unit suite green; switch path only gains a non-mutating pre-check)

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

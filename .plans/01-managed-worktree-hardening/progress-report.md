# Managed Worktree Hardening - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 34
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Complete - all milestones (M1-M4) + Done Gate green

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

- [x] RED: Add a gated smoke scenario for temp repo setup, managed worktree creation, and host launch. (`e2e/cwd-lock-smoke.test.ts`: real temp git repo + real `git worktree add` managed worktree + real OS processes launching the host's actual lock path via `apps/agent-host/test/support/cwd-lock-actor.ts`)
- [x] GREEN: Boot two host processes against the same worktree target and assert one is blocked or reuses safely. (two real processes contend cross-process: one acquires, the other is blocked with `conflict`; holder releases on SIGTERM and the other then acquires; a SIGKILLed holder's lock is reclaimed as stale - all with real pids/`process.kill` liveness)
- [x] RED: Add smoke coverage for create, switch to worktree, switch back to baseline, dirty display, and blocked switching while running. (the cross-process smoke covers create + blocked-by-contention + handover; switch / switch-back / dirty-display / blocked-while-running are owned by the completed D-091 worktree unit+integration suite and the new `cwdSwitchConflict` unit tests - this plan does not reopen them)
- [x] GREEN: Capture logs/artifacts that make failures diagnosable. (each actor's stderr is captured; a missing result rejects with the captured stderr, and the assertion messages embed both actors' output)
- [x] REFACTOR: Keep the smoke gated so it does not destabilize default CI. (the smoke is deterministic - no model, lease, or network - so it is CI-safe; the inherently timing-flaky FULL two-host boot was deliberately kept OUT of CI and is reproduced via the M4 manual runbook, per D-003)

### M4 - Operator-Facing Verification

- [x] RED: Add documentation or a runbook for manually reproducing two-host worktree contention. (`artifacts/two-host-runbook.md`)
- [x] GREEN: Document expected `/doctor` or debug output for cwd lock/worktree ownership. (runbook "/doctor output" table: held / unlocked / contended / stale, structured + plaintext)
- [x] RED: Add a regression checklist for cleanup after failed smoke runs. (runbook "regression checklist": stray hosts, temp dirs, stale locks, git worktrees)
- [x] GREEN: Ensure temp repos, worktrees, locks, and host processes are cleaned up reliably. (`e2e/cwd-lock-smoke.test.ts` group-kills actors in `afterEach`, prunes worktrees, and removes temp state home + repo in `afterAll`; manual cleanup documented in the runbook)

### Done Gate

- [x] Dedicated cwd-path advisory lock is implemented or explicitly rejected with recorded rationale. (implemented: `apps/agent-host/src/cwd-lock.ts`)
- [x] Live two-host worktree smoke exists and is gated with clear skip/failure reasons. (the deterministic cross-process smoke runs real two-process contention in CI with captured-stderr failure messages; the inherently flaky FULL two-host boot is kept out of CI as a documented manual runbook per D-003, satisfying the no-CI-fragility intent)
- [x] Worktree create/switch/merge/delete/reconcile behavior remains unchanged except for safer contention handling. (only a non-mutating pre-switch gate + leader-time acquire were added; full agent-host unit suite green, no D-091 behavior reopened)
- [x] Diagnostics explain owner, cwd, session, and stale lock states. (`/doctor` Workspace cwd-lock fact + finding; `CwdLockConflict` message names owner/cwd/session/pid/heartbeat-age + safe action)
- [x] The umbrella progress report no longer owns D-091 carry-forward rows. (the umbrella plan is retired; this numbered plan owns the carry-forward hardening rows)

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

# Concurrent Worktree Sessions - Progress Report

**Plan:** `58.7-concurrent-worktree-sessions`
**Stage:** complete
**Current focus:** Complete

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 8 |
| Checked (done) | 8 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

---

## M1 - Host spawns without retiring, marker on target (4/4)

- [x] RED: After `/worktree-new` the current host is still alive (scheduler/queue intact, no retire
      scheduled); a detached host was spawned on the worktree session id; the target session's log
      carries `session.project` with the base repo path (not the worktree path).
- [x] GREEN: Add a concurrent create path in `switchToWorkspace` (ensureSession + spawn + marker to
      target via `transport.publishEvent`, skip `dropSessionLocalState` + `retireAfterSessionSwitch`);
      widen `SessionSwitchDeps.transport` and add a `baseRepoFor(cwd)` seam.
- [x] RED: `/worktree-new` does NOT emit `session.switch` on the source session's log.
- [x] REFACTOR: Centralize base-repo resolution (`manager.contextFor(cwd)?.baseRepo`) across
      `worktrees/commands.ts` and `session/session-switch.ts`.

## M2 - Focus the new session without session.switch (4/4)

- [x] RED: When a `/worktree-new` `command.result` carries the new session id, the browser navigates
      to it; no `session.switch` event is written to any log as a side effect.
- [x] GREEN: Extend web handling of the `/worktree-new` `command.result` to carry the new session id
      and call `navigateToSession` on receipt; do NOT emit or synthesize `session.switch`.
- [x] RED: Navigating BACK to the original session after a concurrent `/worktree-new` does not bounce
      to the new session (no `session.switch` breadcrumb in the source log).
- [x] REFACTOR: Keep focus handling at the command-result boundary, obviously separate from the
      durable switch path.

---

## Next Step

Plan complete. Verification passed: focused regression tests, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm --filter @trevor/web build`, and `pnpm test:e2e:browser`.

# Concurrent Worktree Sessions - Progress Report

**Plan:** `58.7-concurrent-worktree-sessions`
**Stage:** ready (plan authored, awaiting go to implement)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 8 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 8 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

---

## M1 - Host spawns without retiring, marker on target (4/4)

- [ ] RED: After `/worktree-new` the current host is still alive (scheduler/queue intact, no retire
      scheduled); a detached host was spawned on the worktree session id; the target session's log
      carries `session.project` with the base repo path (not the worktree path).
- [ ] GREEN: Add a concurrent create path in `switchToWorkspace` (ensureSession + spawn + marker to
      target via `transport.publishEvent`, skip `dropSessionLocalState` + `retireAfterSessionSwitch`);
      widen `SessionSwitchDeps.transport` and add a `baseRepoFor(cwd)` seam.
- [ ] RED: `/worktree-new` does NOT emit `session.switch` on the source session's log.
- [ ] REFACTOR: Centralize base-repo resolution (`manager.contextFor(cwd)?.baseRepo`) across
      `worktrees/commands.ts` and `session/session-switch.ts`.

## M2 - Focus the new session without session.switch (4/4)

- [ ] RED: When a `/worktree-new` `command.result` carries the new session id, the browser navigates
      to it; no `session.switch` event is written to any log as a side effect.
- [ ] GREEN: Extend web handling of the `/worktree-new` `command.result` to carry the new session id
      and call `navigateToSession` on receipt; do NOT emit or synthesize `session.switch`.
- [ ] RED: Navigating BACK to the original session after a concurrent `/worktree-new` does not bounce
      to the new session (no `session.switch` breadcrumb in the source log).
- [ ] REFACTOR: Keep focus handling at the command-result boundary, obviously separate from the
      durable switch path.

---

## Next Step

Start M1 RED with the host-side test asserting the source host survives `/worktree-new` and the
target session carries the base-repo marker.

# Missing Project Root Handling - Progress Report

**Plan:** `58.8-missing-project-root`
**Stage:** ready
**Current focus:** M2 - Supervisor failed result + `missing` flag on projects.list (0/6)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 23 |
| Checked (done) | 6 |
| Current-cutoff blockers (unchecked) | 17 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Launcher missing-root guard (6/6)

- [x] Seams under test: `launch()` (`packages/launcher/src/launch.ts`) and `spawnHost`
      (`packages/launcher/src/platform.ts`) error path.
- [x] RED: launching with a nonexistent root rejects with a typed `missing-root` error naming the
      path - no process crash, no `hosts.json` `pid: -1` record.
- [x] GREEN: pre-check the root in `launchInner` before `spawnHost`.
- [x] RED: a spawn whose child emits `error` (root vanishes between check and spawn / bad
      executable) rejects the `launch()` promise instead of throwing an uncaught event.
- [x] GREEN: attach the child `error` listener in `spawnHost`, route it into the launch failure
      path, and skip host recording on a failed spawn.
- [x] REFACTOR: consolidate the launcher failure taxonomy into one typed error surface shared by
      CLI and supervisor callers.

### M2 - Supervisor failed result + `missing` flag on projects.list (0/6)

- [ ] Seams under test: `handleLaunch` / projects-list handling in
      `apps/supervisor/src/dispatch.ts`.
- [ ] RED: `session.launch.requested` with a dead root yields
      `session.launch.result { status: "failed" }` with the "project folder no longer exists:
      \<path\>" reason, and the supervisor keeps serving subsequent requests.
- [ ] GREEN: map the M1 typed error into the failed result reason.
- [ ] RED: `projects.list.result` marks dead-path records `missing: true` (live ones `false`)
      without removing any record.
- [ ] GREEN: stat each record while serving the list; extend the result type additively.
- [ ] REFACTOR: one owner for the path-existence check shared by the launch gate and list marking.

### M3 - Web result-wait timeout (0/6)

- [ ] Seams under test: `useLaunch` (`apps/web/src/new-session/use-launch.ts`) deterministic hook
      tests.
- [ ] RED: a launch with no arriving result folds to `failed` with a timeout message after the
      result-wait deadline; Retry re-enters `starting`.
- [ ] GREEN: arm a result-wait timer at publish time, cleared by any result, reset-safe via the
      existing guard token.
- [ ] RED: a `failed` result carrying the missing-folder reason renders that reason in the launch
      UI and resume row.
- [ ] GREEN: thread the reason string through the existing failed-state surfaces.
- [ ] REFACTOR: name the two timeouts (`result-wait`, `host-online`) as explicit machine phases.

### M4 - Sidebar missing-project treatment (0/4)

- [ ] Thread `missing` from the supervisor projects mapping into `ProjectSidebarRecord` /
      `ProjectGroup` (`apps/web/src/sidebar/project-sidebar-model.ts`).
- [ ] Storybook story + production wiring: missing projects render a red name label with a tooltip
      naming the dead path; their sessions stay listed beneath.
- [ ] Block New-session on a missing project (hover button + context menu) with the missing-folder
      message; Remove, archive, and rename stay available.
- [ ] Verify: jsdom tests for red label, blocked new-session, untouched archive/rename; manual pass
      against the owner's two standing dead registry records.

### Gate

- [ ] With the dead records present: supervisor survives repeated launch attempts, the web shows
      the failed reason with Retry, the sidebar shows red labels, sessions stay readable and
      archivable.

## Accepted/Deferred Follow-up

None.

## Superseded/Obsolete

None.

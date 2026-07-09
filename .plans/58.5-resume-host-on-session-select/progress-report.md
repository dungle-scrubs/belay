# Resume Host On Session Select - Progress Report

**Plan:** `58.5-resume-host-on-session-select`
**Stage:** ready for implementation
**Current focus:** M1 - Resume Policy And Recency Classification (4/4)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 23 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 23 |
| Accepted/deferred follow-up | 2 |
| Superseded/obsolete | 0 |

This plan makes sidebar session selection feel instant while reviving hosts according to session
recency: today's sessions auto-start, older sessions show a bottom transcript row asking the user to
resume, and live sessions simply navigate.

## Decisions

- D-001: Sidebar session clicks navigate immediately; host launch follows separately.
- D-002: Current-session busyness does not block viewing or startup for the selected session.
- D-003: Older no-host sessions require manual resume from a bottom transcript row.
- D-004: Recent no-host sessions updated today auto-start/reuse their host.

---

## Current Cutoff

### M1 - Resume Policy And Recency Classification (4/4)

- [ ] RED: Local-calendar recency tests distinguish today from yesterday without using a 24-hour
      duration.
- [ ] RED: Policy tests cover live, today auto-start, older manual resume, and missing-root
      unlaunchable outcomes.
- [ ] GREEN: Add pure `resume-policy.ts` with launch-root selection and a discriminated resume action.
- [ ] REFACTOR: Keep the policy free of React state, transport calls, and launch hook knowledge.

### M2 - Sidebar Select Triggers Fast Navigation Plus Auto-Start (5/5)

- [ ] RED: Clicking a today's stale/no-host session navigates immediately and publishes one exact-session
      launch request.
- [ ] RED: Live rows navigate without launch; older rows navigate without launch until explicit resume.
- [ ] GREEN: Replace raw sidebar navigation with select-and-maybe-launch over the clicked
      `SessionSummary`.
- [ ] GREEN: Reuse the existing `useLaunch` control-session fold.
- [ ] REFACTOR: Deduplicate repeated same-session launch attempts.

### M3 - Bottom Transcript Resume Row (6/6)

- [ ] RED: Cover manual, starting, failed retry, and unlaunchable row states in tests/stories.
- [ ] RED: Prove the row appears after transcript content without blocking scroll or obscuring history.
- [ ] GREEN: Add and wire `ResumeHostRow` above the composer at the transcript bottom.
- [ ] GREEN: Route `Resume this conversation` and `Retry` through the same exact-session launch path.
- [ ] RED: Prove the row disappears when the selected session's host presence becomes live.
- [ ] REFACTOR: Keep row copy and layout compact; no overlay, modal, or blur layer.

### M4 - Composer Gating And Recovery Polish (5/5)

- [ ] RED: Manual-resume-required sessions cannot submit a prompt before resume.
- [ ] GREEN: Gate submit/focus while manual resume, starting, or failed launch requires row action.
- [ ] RED: Host-online timeout settles the row into retry/error while transcript remains readable.
- [ ] GREEN: Scope timeout/error state to the selected session so superseded launches do not leak.
- [ ] REFACTOR: Make session-switch launch resets explicit.

### M5 - Verification And Cutover (3/3)

- [ ] RED: Add/update Storybook fixtures for recent auto-start, older manual resume, failed launch, and
      missing-root states.
- [ ] GREEN: Verify browser behavior for instant transcript render, auto-start, manual resume, success,
      and failure.
- [ ] REFACTOR: Remove stale no-host copy and keep `pnpm lint`, `pnpm typecheck`, and `pnpm test` green.

---

## Accepted/Deferred Follow-Up

### FP1 - Host-Layer Busy/Conflict Diagnostics (1)

- [ ] Create a separate host-side plan if concurrent auto-start exposes insufficient cwd lock or
      big-agent in-flight diagnostics.

### FP2 - Historical Session Auto-Start Preference (1)

- [ ] Add a configurable age threshold only after the fixed calendar-day policy ships.

## Next Step

Start M1 RED with the local-calendar recency tests and policy outcome tests.

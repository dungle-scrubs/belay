# Resume Host On Session Select - Implementation Plan

## 0. Hard Dependencies

- [x] Sidebar session inventory exists and carries `SessionSummary.host`, `updatedAt`, and
  `projectPath` (`apps/web/src/sidebar/project-sidebar.tsx`, `packages/session/src/inventory.ts`).
- [x] Supervisor launch request flow exists (`session.launch.requested` / `session.launch.result`) and
  can launch an exact session when given `sessionId` plus a project root.
- [x] The shared `useLaunch` state machine exists and already owns launched/reused/failed/timeout
  behavior for both the new-session picker and no-host recovery surface.
- [x] Host presence is live-socket based through the session-store hub; a stale durable `host.online`
  alone does not count as a live host.
- [x] Downstream accommodation: plan 58.4 changes transcript virtualization internals but should keep
  the bottom continuation surface as a normal transcript/footer item. No plan after 58.5 exists at
  creation time.

## 1. Architecture

### Product Rule

Sidebar selection is split into two independent effects:

1. **Navigate immediately.** The selected session's durable transcript should render as fast as the
   browser and store can replay it. <!-- D-001 -->
2. **Resume host when policy says to.** Host startup follows after navigation and depends on the
   selected session's host state, launch root, and local-calendar recency.

The selected session's current state drives the policy:

| Session state | Behavior |
|--------------|----------|
| `host === "live"` | Navigate only; no launch request. |
| no live host, updated today, launch root known | Navigate immediately, auto-start/reuse host in the background. <!-- D-004 --> |
| no live host, updated yesterday or earlier, launch root known | Navigate immediately and show a bottom transcript row with `Resume this conversation`. No host starts until click. <!-- D-003 --> |
| no live host, no launch root | Navigate immediately and show an unlaunchable bottom row with manual recovery guidance. |

"Today" means local calendar day, not "within the last 24 hours". A session from 23:50 yesterday is an
older session even if it was active minutes ago.

### Interaction Model

Older sessions remain fully readable and scrollable. There is no blur, overlay, or modal. The resume
action is a transcript-adjacent row at the bottom, near the composer, because it represents the next
continuation step rather than a navigation gate.

The row is a small state machine over the selected session and `useLaunch`:

- `manual`: button `Resume this conversation`, secondary `Last active ...`
- `starting`: spinner/status `Starting host...`
- `failed`: error summary plus `Retry`
- `unlaunchable`: explanatory row when no root is available
- `hidden`: live host, recent auto-start already succeeded, or no resume action needed

When `host.online` arrives and the selected session becomes live, the row disappears. The transcript and
composer should not jump.

### Conflict Boundary

Current-session busyness does not block viewing another session and does not block host auto-start for
the selected session. <!-- D-002 --> Big-agent/cwd conflicts are host/tool-layer concerns: the host can
start, inspect locks, and then refuse or degrade mutating turns with a clear diagnostic. The UI must not
make the click path wait for the previous host's turn to settle.

### Boundaries

```
apps/web/src/session/resume-policy.ts
  Pure policy: launch root selection, local-calendar recency, auto-start/manual/unlaunchable state.

apps/web/src/app.tsx
  Replace raw sidebar navigate with a select-and-maybe-launch handler. Owns wiring to `useLaunch`.

apps/web/src/components/chat/resume-host-row.tsx
  Presentational transcript footer row for manual/start/failed/unlaunchable states.

apps/web/src/components/panel/panel-host.tsx
  Places the footer row at the bottom of the transcript surface and gates composer submit/focus when
  manual resume or launch failure requires action.

apps/web/src/new-session/use-launch.ts
  Reused as the single launch state machine. Only extend it if exact-session retry/error state needs a
  small typed hook around the existing primitive.
```

Do not add a second supervisor subscription or a parallel launch state model. The existing launch hook
already folds `session.launch.result`, waits for `host.online`, handles timeouts, and exposes retry.

### Observability

The user-visible bottom row is the primary inspection surface:

- auto-start rows show that a host is starting instead of leaving a dead "no host" affordance
- manual rows explain that older sessions require an explicit resume
- failure rows keep the launch error and retry in the same location
- unlaunchable rows distinguish missing root from launch failure

Implementation should also keep the existing host/session logs sufficient: launch requests remain
durable supervisor events; the target host still emits `host.online`; failures remain `session.launch.result`
errors.

---

## 2. Current-Cutoff Milestones

### M1: Resume Policy And Recency Classification

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add pure tests for `calendarDayStatus(updatedAt, now)` proving today vs yesterday is based
     on local calendar day, not a 24-hour duration.
  2. RED: Add pure tests for policy outcomes: live host hides action, today's no-host session
     auto-starts, older no-host session requires manual resume, and missing launch root is
     unlaunchable.
  3. GREEN: Add `apps/web/src/session/resume-policy.ts` with root selection from
     `projectPath ?? workspace ?? cwd` and a discriminated resume action union.
  4. REFACTOR: Keep policy free of React state, transport calls, and launch hook knowledge.

### M2: Sidebar Select Triggers Fast Navigation Plus Auto-Start

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add an `App`/hook-level test proving clicking a today's stale/no-host session navigates
     immediately and publishes one exact-session launch request with `{ root, sessionId }`.
  2. RED: Add a test proving live-host rows navigate without launch, and older rows navigate without
     launch until explicit resume.
  3. GREEN: Replace the sidebar `onSelectSession` path with a select handler that looks up the clicked
     `SessionSummary`, calls `navigateToSession`, and invokes `launch(root, { sessionId })` only when
     the policy returns auto-start.
  4. GREEN: Preserve existing picker/new-session launch behavior by reusing `useLaunch` rather than
     creating another control-session fold.
  5. REFACTOR: Keep launch dedupe/idempotence at the handler boundary so repeated clicks on the same
     starting session do not spam supervisor requests.

### M3: Bottom Transcript Resume Row

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests/stories for the manual older-session row, starting row, failed retry row, and
     unlaunchable row.
  2. RED: Add a transcript placement test proving the row appears after existing transcript content
     without blocking scroll or obscuring history.
  3. GREEN: Add `ResumeHostRow` with compact button/status/error states and wire it into the transcript
     bottom area above the composer.
  4. GREEN: Clicking `Resume this conversation` or `Retry` calls the same exact-session launch path as
     auto-start.
  5. RED: Add a success test proving the row disappears when host presence becomes live for the selected
     session.
  6. REFACTOR: Keep row copy short and state-driven; do not introduce an overlay, modal, or blur layer.

### M4: Composer Gating And Recovery Polish

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add a test proving manual-resume-required sessions cannot submit a prompt until resumed.
  2. GREEN: Gate submit/focus while the selected session requires manual resume, is launching, or is in
     a failed launch state; route the user to the bottom row instead of silently dropping input.
  3. RED: Add a failure-path test proving a host-online timeout settles the row into retry/error and
     keeps the transcript readable.
  4. GREEN: Wire timeout/error text from `useLaunch` into the row for the selected session only; a
     superseded launch must not update a newly selected session.
  5. REFACTOR: Make session-switch resets explicit so launch state from one session cannot leak into
     another session's row.

### M5: Verification And Cutover

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add or update Storybook fixtures for recent auto-start, older manual resume, failed launch,
     and no launch-root states.
  2. GREEN: Verify the browser behavior: sidebar click renders transcript immediately; today's no-host
     session starts automatically; older no-host session waits for row click; success removes row.
  3. GREEN: Run focused web tests for policy/sidebar/resume-row, then `pnpm lint`, `pnpm typecheck`,
     and `pnpm test`.
  4. REFACTOR: Remove stale no-host copy that implies manual restart is always required when the new
     auto-start/manual-resume policy applies.

### Current Cutoff Gate

- [ ] Sidebar selection never waits for host startup before showing the selected session.
- [ ] Today's no-host sessions auto-start/reuse a host exactly once per selection attempt.
- [ ] Older no-host sessions show a bottom transcript resume row and do not auto-start.
- [ ] Existing transcript remains readable and scrollable while manual resume is pending.
- [ ] Launch starting, success, failure, retry, and missing-root states are visible in the same row.
- [ ] Composer submit cannot create a prompt into a manually gated older session before resume.
- [ ] Current-session busyness does not block viewing or host start for the selected session.

---

## 3. Accepted/Deferred Follow-Up

### FP1: Host-Layer Busy/Conflict Diagnostics

- If current host/cwd conflict diagnostics are insufficient once auto-start makes concurrent hosts more
  common, create a separate host-side plan. This plan does not redesign cwd locks, tool admission, or
  big-agent in-flight detection.

### FP2: Historical Session Auto-Start Preference

- If users want a configurable threshold later, add a preference after the default calendar-day policy
  ships. This plan hard-codes "today auto-starts, earlier days require manual resume".

---

## 4. Validation Commands

```sh
pnpm vitest run --project web apps/web/src/session/resume-policy.test.ts
pnpm vitest run --project web apps/web/src/new-session/use-launch.test.tsx
pnpm vitest run --project web apps/web/src/components/panel/panel-host.test.tsx
pnpm lint
pnpm typecheck
pnpm test
```

If exact test filenames change during implementation, run the nearest owner tests for policy, sidebar
selection, launch state, panel/composer gating, and transcript row rendering.

---

## 5. Decisions

Canonical decisions are in `.plans/58.5-resume-host-on-session-select/plan.db`.

- D-001: Sidebar session click behavior.
- D-002: Conflict enforcement boundary.
- D-003: Older session manual resume.
- D-004: Recent session auto-start.

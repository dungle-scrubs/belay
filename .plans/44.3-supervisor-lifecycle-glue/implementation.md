# Supervisor Lifecycle Glue - Implementation Plan

## 0. Hard Dependencies

- [ ] `44.1-supervisor-foundation` - the supervisor, `session.launch` request/result (incl. failure results), and `@trevor/launcher`'s reuse/spawn/replace-stale decision. The recovery states here render 44.1's failure and stale outcomes.
- [ ] `44.2-browser-folder-sessions` - the unified launch state machine (idle -> starting -> online) that this plan extends with failed/retry, and the picker surface those states attach to.
- [x] D-094 session lifecycle controls - starting/replacing a host must stay consistent with the lifecycle model (archive/delete/fork/handoff); recovery affordances respect it.
- [x] D-085 project launcher - the reuse/spawn/replace-stale semantics whose outcomes this plan surfaces.

## 1. Architecture

44.2 renders the *happy* launch trajectory (idle -> starting -> online). This plan renders every way that
trajectory can go wrong and gives the user one deterministic way out of each - all on the same session log,
extending 44.2's launch state machine rather than forking a second one. Three recovery states:

1. **No-host session.** Opening a session whose host is `"no host"` (never launched from this browser, or the
   host exited) shows a **"start host"** affordance that publishes `session.launch.requested` for the session's
   known workspace root (from its `host.online`-derived `workspace`/`cwd`, or `projects.json`). This is the
   entry point the current app lacks: today navigating to a never-launched session is a dead end.
2. **Stale host.** When `@trevor/launcher`'s `decideHostAction` returns `replace-stale` (a recorded pid that is
   dead or unresponsive), the supervisor replaces it; the browser surfaces a **"restarting host…"** state that
   resolves to `host.online`, distinct from a fresh start.
3. **Failed launch.** A `session.launch.result` with `status: "failed"` (unresolvable root, spawn denied,
   supervisor unavailable) surfaces an **error with an explicit `Retry`** that re-publishes the same request.
   No silent stall, no infinite spinner.

The launch state machine becomes `idle -> starting -> online | failed -> (retry) starting`, with `stale`
folding into `starting` as a labelled variant ("restarting host…"). 44.2 owns `idle/starting/online`; this
plan adds `failed`, `retry`, and the `stale` label, and wires the no-host entry point in the session view.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Extend, don't fork | Recovery states extend 44.2's single launch state machine; there is not a second launch model in the session view. |
| Deterministic recovery | Every failure has exactly one user action (start / retry); no state is a dead end or an unbounded spinner. |
| Richter-only | Start/retry publish the same `session.launch.requested`; stale replacement is the supervisor's, surfaced from `session.launch.result` / `host.online`. |
| Lifecycle-consistent (D-094) | Starting or replacing a host does not resurrect an archived/deleted session or bypass the lifecycle model. |
| Supervisor may be down | "Supervisor unavailable" is itself a surfaced, retryable failure, not a hang. |

### Boundaries

- **The session view** (`apps/web/src/app.tsx` + the relevant panel) gains the no-host "start host" affordance
  for a `"no host"` session, publishing `session.launch.requested` for its known root.
- **The launch state machine** (introduced in 44.2) gains `failed`, `retry`, and the `stale`/"restarting"
  label; both the picker (44.2) and the session-view start (44.3) read the same states.
- **No new protocol** - this plan consumes 44.1's `session.launch.result` failure/stale signals; it adds no
  events.

### Observability

- Each recovery state is the user-visible inspection surface for a launch failure: the error text names the
  failure class (unresolvable root / spawn denied / supervisor unavailable) from the result payload, and the
  retry count is visible so a repeated failure is obvious rather than a silent re-spin.

## 2. Current State

Navigating to a never-launched or dead-host session yields `host: "no host"` with no affordance to start one;
a failed or slow launch has no browser-visible outcome. 44.1 introduces the launch result (including failure)
and the stale-replacement decision; 44.2 introduces the happy-path launch state machine. This plan fills the
recovery surface those two leave open.

## 3. Phases

### Phase 1: Recovery states

**Goal:** Every launch failure has a deterministic, story-covered browser recovery.

#### M1: No-host session start

- **Dependencies:** 44.1, 44.2
- **Effort:** S
- **Tasks:**
  1. RED: Add a test/story that a session with `host: "no host"` and a known root shows a "start host"
     affordance.
  2. GREEN: Render the "start host" affordance in the session view for a no-host session with a resolvable root.
  3. RED: Add a test that activating it publishes `session.launch.requested` for the session's known root and
     enters the shared "starting host…" state.
  4. GREEN: Wire the start affordance to the launch request + shared launch state.
  5. REFACTOR: Derive the "known root" once (from `host.online` workspace/cwd or `projects.json`) so the picker
     and the session-view start agree.

#### M2: Stale host and failed launch

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add a test that a `session.launch.result { status: "failed", error }` renders an error naming the
     failure class plus an explicit `Retry`.
  2. GREEN: Extend the launch state machine with `failed` + `retry`; render the error + `Retry`.
  3. RED: Add a test that `Retry` re-publishes the same `session.launch.requested` and returns to
     "starting host…".
  4. GREEN: Wire `Retry`.
  5. RED: Add a test that a `replace-stale` outcome renders a distinct "restarting host…" label that resolves
     to `host.online`.
  6. GREEN: Surface the `stale`/"restarting" label as a variant of `starting`.
  7. REFACTOR: Fold `stale`/`failed`/`retry` into the one launch state machine 44.2 introduced; assert no
     second model in the session view.

### Gate 1

- [ ] A no-host session offers a working "start host".
- [ ] A failed launch shows a named error + `Retry`; `Retry` re-launches.
- [ ] A stale host shows "restarting host…" and resolves to online.
- [ ] "Supervisor unavailable" is a surfaced, retryable failure, not a hang.
- [ ] No launch state model exists outside 44.2's unified machine.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Second launch state model drifts from 44.2 | medium | high | M2.7 folds every recovery state into 44.2's one machine; a test asserts no second model. | Web |
| No-host start resurrects an archived session | medium | low | Respect D-094 - the start affordance is gated on lifecycle state, not shown for archived/deleted sessions. | Web |
| Infinite retry masks a persistent failure | medium | medium | Show the retry count; the error names the failure class so a repeat is visible. | Web |
| "Known root" differs between picker and session view | medium | medium | M1.5 derives the root once, shared by both. | Web |

## 5. Escape Hatches

1. **If stale-vs-fresh is hard to distinguish in the UI:** collapse "restarting host…" into the same
   "starting host…" label for the first cut; keep the distinct label as a follow-up.
2. **If supervisor-unavailable detection is unreliable:** treat a launch request with no result within a bounded
   window as a `failed` with a retry, rather than a bespoke unavailable state.

## 6. Progress Report Accounting

The progress report is `.plans/44.3-supervisor-lifecycle-glue/progress-report.md`. It tracks only the recovery
states (no-host start, stale, failed, retry). The happy-path picker and launch machine are 44.2; the supervisor
and protocol are 44.1.

## 7. Validation Commands

```bash
pnpm --filter @trevor/web test
pnpm test -- --project web
pnpm test -- --project e2e
pnpm typecheck
pnpm lint
pnpm --filter @trevor/web test-storybook
```

## 8. Decisions

Canonical decisions are in `.plans/44.3-supervisor-lifecycle-glue/plan.db`.

<!-- D-001 --> Recovery states (no-host start, stale, failed, retry) are split out of the happy path into this plan and extend 44.2's single launch state machine rather than forking a second one.

<!-- D-002 --> A no-host session with a resolvable root gets a "start host" affordance that publishes `session.launch.requested`; this is the entry point the app lacks today.

<!-- D-003 --> A failed launch surfaces a named error + explicit `Retry` (which re-publishes the request); no launch is a dead end or an unbounded spinner.

<!-- D-004 --> Stale-host replacement (from `@trevor/launcher`'s `replace-stale`) surfaces as a "restarting host…" label, a variant of `starting`.

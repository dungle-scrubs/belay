# Concurrent Worktree Sessions - Implementation Plan

## 0. Hard Dependencies

- [x] `/worktree-new` and `/worktree-switch` run inside the host and route through the shared
  `switchToWorkspace` mechanic (`apps/agent-host/src/worktrees/commands.ts`,
  `apps/agent-host/src/session/session-switch.ts`). `switchToWorkspace` today spawns a detached
  replacement host and then **retires the current one**; the spawn is already concurrent-safe
  (`detached: true`, `child.unref()`, on its own `SESSION_ID`) and only the retire makes the flow
  serial.
- [x] `SessionSwitchDeps` exposes the seams this plan needs: `transport`
  (`Pick<SessionTransport, "ensureSession">`), `emit` (`EmitEvent`, writes to `SESSION_ID`), and
  `sessionId` (this host's `SESSION_ID`). The supervisor's cross-session `publishToSession(sessionId,
  event)` pattern (`apps/supervisor/src/dispatch.ts`) is the proven precedent for publishing to a
  target session that is not the current one.
- [x] The browser follows a `session.switch` event via `latestSessionSwitch` / `switchAfterReplay`
  (`apps/web/src/derive.ts`), and navigates via `navigateToSession` (`apps/web/src/app.tsx`).
  `command.result` events are already consumed by the transcript projection
  (`apps/web/src/transcript.ts`).
- [x] Downstream accommodation: none. This plan is independent of the worktree sidebar surface (58.2),
  the transcript virtualization (58.4), and resume-on-select (58.5). 58.2 (badge/grouping) and 58.5
  (navigate/resume) become more valuable once hosts are concurrent, but neither is a prerequisite.

## 1. Architecture

Today `/worktree-new` is serial: to enter worktree B it must kill host A. The worktree session
then appears in the sidebar as a separate, dormant session you can navigate back to, but A is dead.
This plan makes worktree **creation** concurrent: `/worktree-new` spawns host B on the new worktree
session, **keeps host A alive**, and signals the browser to focus B. The original host continues
serving its session with its turn queue and context intact.

The key insight is that the spawn is *already* concurrent-safe. `switchToWorkspace` spawns a
detached, unref'd child on the target session id; nothing about that child depends on the parent
surviving. The only thing making the flow serial is two trailing calls in `announceSwitchAndRetire`:
`dropSessionLocalState()` (clears this host's scheduler queue + context registry) and
`retireAfterSessionSwitch()` (a 750ms timer to `supervisor.killAll()` + `process.exit(0)`). This plan
introduces a concurrent create path that does the spawn + marker + focus signal, and **skips** the
retire.

Worktree **switch** (`/worktree-switch`) stays serial. Switching into an existing worktree replaces
this host's checkout context: the host is bound to its checkout (`WORKSPACE_ROOT`, `process.cwd()`,
`TSX_TSCONFIG_PATH`, the worktree manager resolved against `cwd`), so it cannot serve a different
tree in-process the way a tangent worker can. Creation adds a concurrent session; switching moves
into an existing one. <!-- D-001 -->

### The focus signal is visual-only, not session.switch

The signal to focus the new session is a **purely browser concern**. It MUST NOT be a `session.switch`
event. `session.switch` carries durable, source-side semantics (the source host is retiring) and sits
in the source session's log as a breadcrumb that `switchAfterReplay` follows on replay. In a
concurrent model the source host stays alive, so emitting `session.switch → B` into A's log would
cause a bounce-back: when the user navigates back to A and the browser replays A's log, it hits the
breadcrumb and bounces to B. <!-- D-002 -->

Instead, the focus signal is browser-internal. The `/worktree-new` handler already emits a
`command.result` (via `replyFor("/worktree-new")`) on the source session's log on success; that
result is rendered in the source transcript as a normal command output. The browser additionally
needs a way to focus the new session when that result carries the new session id. Two viable shapes:

- **Reuse `command.result`**: extend its payload (or the web-side handling of `/worktree-new`
  results) to carry the new session id, and have the web app navigate on receipt. No new event type.
- **Dedicated focus payload**: a small web-internal mechanism (e.g. an imperative call through the
  existing command-dispatch callback, or a transient non-durable signal) that focuses the session.

Either keeps the focus signal out of the durable session log's switch semantics. The plan's RED
tests pin the invariant (focus happens, no `session.switch` is written), leaving the exact payload
shape to the GREEN.

### The base-repo marker lands on the target session

The new worktree session must group under its base repo, not its worktree path. The
`events.sessionProject({ path: baseRepo })` marker is published to the **target** session via
`transport.publishEvent(targetSessionId, ...)`, not via the source host's `emit` (which writes to
`SESSION_ID`, the current host's session). This is the same cross-session publish pattern the
supervisor uses (`publishToSession(sessionId, event)` in `dispatch.ts`). <!-- D-003 -->

This makes the worktree session's `projectPath` resolve to the base repo durably, surviving host
death, so it groups correctly in the sidebar (with 58.2) and offline. The marker is emitted once,
after `ensureSession` has run, so the target log exists.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `switchToWorkspace` is shared by `/cd`, `/worktree-switch`, `/worktree-new`, and `/handoff` | The concurrent path must not perturb the retire semantics for `/cd`, `/handoff`, or `/worktree-switch`; introduce a fork in `/worktree-new` only |
| `command.result` is already emitted by the `/worktree-new` handler | The focus signal rides an existing publish path; no new durable event for the result itself |
| `session.switch` is durable and replayed | A concurrent create must never write `session.switch` to the source log; focus is browser-internal |
| Lease rule is per-session | Two hosts on two distinct session ids violate nothing; no lease contention between the source and the new worktree host |

### Boundaries

```
apps/agent-host/src/session/session-switch.ts  (extended)
  switchToWorkspace - unchanged signature; /worktree-new calls a new concurrent variant
                     (or a flag) that does ensureSession + spawn + marker + focus, skipping retire
  SessionSwitchDeps - widen `transport` to Pick<SessionTransport, "ensureSession" | "publishEvent">
                      so the marker can be published to the TARGET session; add a
                      `baseRepoFor(cwd): string | null` seam (backed by WorktreeManager.contextFor)

apps/agent-host/src/worktrees/commands.ts  (extended)
  worktreeNew - route through the concurrent path (spawn + marker + focus, no retire);
                still emits its command.result on success

apps/web/src/app.tsx  (extended)
  /worktree-new command.result handling - focus the carried session id (navigate, no session.switch)

packages/session/src/protocol/  (unchanged)
  No new durable event type. Focus is browser-internal; the marker reuses events.sessionProject.
```

This plan does NOT touch the worktree sidebar surface (badge, tooltip, base-repo grouping join),
which is owned by 58.2. It does NOT touch resume-on-select, owned by 58.5. Both compose with this
plan but are independent layers. <!-- D-004 -->

### Observability

- The existing `/worktree-new` `command.result` carries the created-session confirmation in the
  source transcript.
- The new host's boot output is captured to its per-session host log (the existing
  `spawnReplacementHost` log path), so a failed concurrent spawn is diagnosable.
- No new runtime observability surface is needed.

---

## 2. Phases

### Phase 1: Concurrent create

**Goal:** `/worktree-new` spawns a host on the new worktree session and keeps the current host
alive; the browser focuses the new session without a `session.switch` event.

**Gate from previous:** none.

#### M1: Host spawns without retiring, marker on target

- **Dependencies:** none
- **Effort:** M
- **Rationale:** `switchToWorkspace` today does ensureSession, spawn, then `announceSwitchAndRetire`
  (emit `session.switch` + `dropSessionLocalState` + `retireAfterSessionSwitch`). The concurrent path
  reuses ensureSession + spawn, publishes the `session.project` marker to the target session, emits a
  focus signal, and skips the retire entirely. The spawn is already detached/unref'd and on its own
  session id, so the new host is independent by construction.
- **Tasks:**
  1. RED: Add a host test proving that after `/worktree-new` the current host is still alive (its
     turn scheduler/queue is intact, `process.exit` was not scheduled), AND a new detached host was
     spawned on the worktree session id, AND the target session's log carries a `session.project`
     event whose `path` is the base repo (resolved via `WorktreeManager.contextFor(cwd).baseRepo`),
     not the worktree path.
  2. GREEN: Add a concurrent create path in `switchToWorkspace` (a variant or a flag) that, for
     worktree creation: calls `ensureSession`, spawns the detached host, publishes the marker to the
     target via `transport.publishEvent(opts.sessionId, ...)`, and does NOT call
     `dropSessionLocalState` or `retireAfterSessionSwitch`. Widen `SessionSwitchDeps.transport` to
     `Pick<SessionTransport, "ensureSession" | "publishEvent">` and add a `baseRepoFor(cwd)` seam.
  3. RED: Add a test proving `/worktree-new` does NOT emit a `session.switch` event on the source
     session's log (the concurrent path must not carry durable switch semantics).
  4. REFACTOR: Centralize the base-repo resolution so `worktrees/commands.ts` and
     `session/session-switch.ts` ask the manager once (`manager.contextFor(cwd)?.baseRepo`).

#### M2: Focus the new session without session.switch

- **Dependencies:** M1
- **Effort:** M
- **Rationale:** The browser needs to focus the new worktree session, but `session.switch` is the
  wrong mechanism (durable, source-side, replayed by `switchAfterReplay`, causes bounce-back). The
  focus signal must be browser-internal. The `/worktree-new` handler already emits a `command.result`
  on success; the new session id can ride that existing publish.
- **Tasks:**
  1. RED: Add a web test proving that when a `/worktree-new` `command.result` carries the new
     session id, the browser navigates to it (calls the navigate path), AND no `session.switch`
     event is written to any session log as a side effect of the focus.
  2. GREEN: Extend the web handling of the `/worktree-new` `command.result` (or its payload) to
     carry the new session id, and call `navigateToSession` on receipt. Do NOT emit or synthesize a
     `session.switch` event.
  3. RED: Add a test proving that navigating BACK to the original (source) session after a
     concurrent `/worktree-new` works without bouncing to the new session (no `session.switch`
     breadcrumb in the source log).
  4. REFACTOR: Keep the focus handling at the command-result boundary so it is obviously separate
     from the durable switch path.

### Gate 1→done

- [ ] `/worktree-new` spawns a host on the new worktree session and the original host stays alive
      (turn queue intact, no retire scheduled).
- [ ] The new worktree session's log carries a `session.project` marker with the base repo path.
- [ ] The browser focuses the new session without writing a `session.switch` event.
- [ ] Navigating back to the original session does not bounce to the new session.
- [ ] `/worktree-switch`, `/cd`, and `/handoff` still retire the current host (their behavior is
      unchanged).
- [ ] Lint, typecheck, agent-host tests, and web tests pass.

---

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Focus signal payload shape is under-specified (command.result extension vs dedicated signal) | medium | medium | The RED tests pin the invariant (focus happens, no session.switch); the GREEN picks the lighter shape, reusing command.result if it carries the id cleanly | host + web |
| A concurrent host's spawn fails and the source stays alive with a confusing command.result | medium | low | The spawn failure is caught by the existing try/catch in `worktreeNew`; emit a failed `command.result` and do NOT focus. The source host is unaffected. | host |
| Browser replays a historical `session.switch` and bounces (if any leaks into the source log) | high | low (gated by RED) | The M2 RED test asserts no `session.switch` is written on the concurrent path; the focus path never touches the durable switch event | web |
| Resource load from many concurrent hosts (N installs, N model contexts) | medium | medium | This plan enables pairs, not unbounded fan-out; fleet scheduling/budgeting is a follow-up, not this plan's scope | host |
| Lease contention between source and new host | low | low | The lease rule is per-session; the new host is on a distinct session id, so there is no contention | host |

---

## 4. Escape Hatches

1. **If the focus-without-session.switch path proves fragile on the web side:** ship the host-side
   concurrent spawn (M1) alone first. The new worktree session appears in the sidebar (with 58.2)
   and the user clicks into it manually; focus-without-switch becomes a follow-up. M1 is the
   high-value part (the host stays alive); M2 is polish.

2. **If widening `SessionSwitchDeps.transport` ripples too far:** publish the marker through a
   narrow dedicated seam (`publishToTarget(sessionId, event)`) instead of widening the transport
   Pick. Same effect, smaller surface.

---

## Decisions

Canonical decisions are in `.plans/58.7-concurrent-worktree-sessions/plan.db`.

- D-001: Concurrent host on `/worktree-new`, switch-and-retire on `/worktree-switch`.
- D-002: Focus is a browser-only web signal, not `session.switch`.
- D-003: `session.project` marker is published to the TARGET session, not the source.
- D-004: Plan scope is host-side spawn mechanic + focus signal only.

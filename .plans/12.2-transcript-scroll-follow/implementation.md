# Transcript Scroll Follow - Implementation Plan

The web transcript's scroll behavior regressed in three user-visible ways: (1) a new transcript item
forces a scroll to the bottom while the user is scrolled up reading; (2) scrolling up at a normal pace
is repeatedly "tugged" back down a little; (3) a rapid upward flick from the bottom sometimes resets
the scroll to an unexpected position. All three share one root cause, so this plan replaces the
scattered auto-follow effects with a single follow controller - and reproduces each regression as a
failing Lane B e2e spec BEFORE fixing it. <!-- D-001 -->

## 0. Hard Dependencies

- [x] 09.2 Lane B browser e2e infrastructure (merged): `tests/browser/playwright.config.ts`,
  `run-browser-e2e.ts`, `lane-b-fixtures.ts` (`seedExchanges`/`appendExchange`/`startStreamingTurn`/
  `storeTransport`), the existing `transcript-scroll.spec.ts`, and `pnpm test:e2e:browser`.
- [x] The current scroll stack this plan rewrites (all merged): `apps/web/src/scroll.ts` (D-086
  top-down math), `apps/web/src/hooks/use-scroll-follow.ts`, the follow effects in
  `apps/web/src/components/chat/virtual-transcript.tsx`, and the listener wiring in
  `apps/web/src/components/panel/panel-host.tsx`.

No dependency on plan 12 (`bounded-child-takeover`) or 12.1 (`claude-code-max-provider`); the `12.2`
number is the owner's explicit "run soon" placement, not a real dependency. <!-- D-004 -->

## 1. Architecture

### The three regressions and their shared root cause

| Regression | Mechanism in current code |
|---|---|
| Append yanks to bottom while reading | `onUserScrollIntent` unpins only if `atBottomOf(el)` is ALREADY false at the wheel event (`use-scroll-follow.ts:30-36`); on the first wheel tick the DOM has not moved yet, so the state stays pinned until an async `onScroll` lands. An append inside that window sees `pinned=true`, and `followOnAppend:"auto"` plus the last-row layout effect (`virtual-transcript.tsx:180-186`) pull to the live edge. The 40px `AT_BOTTOM_TOLERANCE` widens the trap: reading within 40px of the bottom still counts as pinned. |
| Constant small downward tug while scrolling up | Inside that same lag band `pinnedRef.current` is still true, so every row re-measurement (a streaming row growing per token, images loading, overscan rows measuring in) changes `totalSize` and fires the re-measure effect (`virtual-transcript.tsx:254-270`), nudging `scrollTop` back toward the bottom. `scrollToFn` only swallows programmatic writes once FULLY unpinned (`:142-146`). |
| Rapid flick resets position | Three cooperating causes: `onTranscriptScroll` drops `scroll.onScroll()` while `data-transcript-ready="false"` while the settle loop force-scrolls to the live edge (`panel-host.tsx:291-297`, `virtual-transcript.tsx:205-237`); a fast flick mounts many rows at once whose heights jump from estimate to measured, translating the column; and momentum that transits the 40px bottom band re-pins (`use-scroll-follow.ts:43-44`), after which the `[pinned]` rAF effect (`virtual-transcript.tsx:188-194`) yanks to the bottom. |

Root cause: **pin/unpin is lagging derived React state, and ~6 independent effects write scroll gated
only on that lagging flag.** The fix removes the lag (unpin is synchronous and direction-based) and
removes the independent writers (one authority arbitrates every programmatic write).

### The follow controller <!-- D-001 -->

A new pure module `apps/web/src/scroll-follow.ts` (DOM-free, unit-testable, like `scroll.ts`) owns the
pin state machine and write arbitration:

- **Inputs:** user scroll gestures WITH DIRECTION (wheel `deltaY` sign, touch move delta, scroll
  events carrying the `scrollTop` delta plus self-write bookkeeping), programmatic write requests
  classified as `follow` (go to live edge) or `anchor-compensation` (keep the viewport visually
  stationary while content above re-measures), and explicit re-pin commands (jump button, prompt
  submit).
- **Unpin:** any upward user gesture unpins SYNCHRONOUSLY at the input event - no `atBottomOf`
  precondition, no 700ms intent window. A `scrollTop` decrease not attributable to a
  controller-approved write also unpins (catch-all for scrollbar drags and keyboard scrolling).
- **Re-pin:** only (a) a downward user gesture that ENDS within `AT_BOTTOM_TOLERANCE` of the bottom,
  (b) jump-to-bottom, or (c) prompt submit. Upward momentum transiting the bottom band never re-pins.
  The tolerance is for at-bottom display and re-pin detection only; it never overrides an upward
  gesture.
- **Write arbitration:** while pinned, `follow` writes are allowed. While unpinned, EVERY
  `follow`-class write is denied (append follow, settle loop, `totalSize` growth, `[pinned]` rAF) and
  only `anchor-compensation` writes are allowed.
- **Self-write recognition:** the controller records offsets it approves so the resulting scroll event
  is not misread as user movement.

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| `scroll-follow.ts` (new) | The pin state machine + write-arbitration policy | DOM, React, the virtualizer |
| `scroll.ts` | Bottom-distance math - unchanged home, imported by the controller <!-- D-003 --> | Policy |
| `use-scroll-follow.ts` | React adapter: sync refs + render subscription (jump button), event handlers delegating to the controller | Policy decisions |
| `virtual-transcript.tsx` | The virtualizer + rendering; its follow effects become REQUESTS to the controller; `scrollToFn` asks the controller | Pin policy |
| `panel-host.tsx` | DOM listeners including direction extraction; routes scroll events to the controller even while `data-transcript-ready="false"` (the settle loop terminates on user intent instead) | - |

Additional wiring rules:

- Pin state lives ABOVE `VirtualTranscript` so the connecting/waiting branch swaps in
  `panel-host.tsx:375-400` cannot remount their way back to a fresh pinned state, and `initialOffset`
  only ever runs against real pin state.
- **DOM contract stability:** the scroll element identity (`data-transcript-scroll` on the same div),
  `data-transcript-virtual-list`/`-ready`/`-row-count`, and the jump-button aria labels are
  unchanged. One ADDITIVE hook is introduced: `data-transcript-pinned="true|false"` on the scroll
  container, so tests and debugging read pin state directly instead of inferring it. <!-- D-003 -->
- New module gets a `Responsible for:` / `Not for:` header (repo convention).

### Reproduce-first e2e (Lane B) <!-- D-002 -->

Three specs are added to `tests/browser/transcript-scroll.spec.ts`, authored to FAIL against current
code, reusing `lane-b-fixtures.ts` (no new infrastructure):

1. **Append while reading must not yank.** Deterministic case: wheel up a SMALL amount (within the
   old 40px tolerance band - "reading near the bottom") then `appendExchange`; the viewport must not
   move to the live edge. Race case: append published immediately after a larger wheel burst without
   waiting for the unpin to settle; same assertion.
2. **Slow upward scroll makes monotonic progress.** Start a streaming turn, then wheel up in small
   steps; sample `scrollTop` after each step; the sequence must be non-increasing (zero downward
   movement between samples - the "tug" is any increase).
3. **Rapid flick from the bottom holds.** Fire rapid consecutive wheel-up bursts from the pinned
   state; assert the transcript unpins and STAYS unpinned (`data-transcript-pinned="false"`, jump
   button present), the sampled `scrollTop` trajectory never snaps downward, and the final position
   reflects the gesture rather than a reset offset.

Flake posture: deterministic fake-provider fixtures, `workers:1`, poll-based settling, and
direction/monotonicity assertions instead of exact pixel targets.

### Observability

The controller exposes an inspectable snapshot (pinned, last transition reason, last denied write
class) behind a debug getter used by unit tests and surfaced as the `data-transcript-pinned`
attribute; denied unexpected writers log a structured dev-only warning so a future regression names
its writer instead of silently tugging.

## 2. Non-Goals

- No visual scrollbar work (plan 33), no reasoning auto-open behavior (plan 35), no image rendering
  work (plan 34) - those plans are threaded to accommodate this one instead. <!-- D-005 -->
- No virtualization library change: TanStack `@tanstack/react-virtual` stays at its pinned version;
  `overscan`/`anchorTo`/`useAnimationFrameWithResizeObserver` tuning survives unless a task proves a
  value wrong.
- The thinking-preview mini-scroller (`reasoning.tsx` ResizeObserver pin) is a separate scroll
  element and is untouched.
- No host/protocol/store changes; this is web-app code plus Lane B specs only.
- No new scroll-position persistence across session switches; only the regressions are in scope.

## 3. Phases

### Phase 1: Reproduce

#### M1: Lane B reproduction specs

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Spec "an append while the user is reading (small scroll-up within the old tolerance band,
     and an append racing a larger wheel burst) does not move the viewport to the live edge" -
     failing against current code. <!-- D-002 -->
  2. RED: Spec "slow upward wheel during a streaming turn makes monotonic upward progress
     (sampled scrollTop is never increasing)" - failing against current code.
  3. RED: Spec "a rapid wheel flick from the bottom unpins, stays unpinned, never snaps downward,
     and lands where the gesture says" - failing against current code.
  4. GREEN: Verify the four pre-existing Lane B scroll specs still pass unmodified, and record each
     new spec's observed failure mode in the progress report (evidence the reproduction matches the
     diagnosed mechanism).

### Phase 2: The follow controller

#### M2: Pure state machine (`scroll-follow.ts`)

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Unit tests - an upward user gesture unpins immediately regardless of current bottom
     distance; no intent-window or position precondition survives. <!-- D-001 -->
  2. GREEN: Implement the state machine skeleton (pinned/unpinned; gesture inputs with direction;
     re-pin commands).
  3. RED: Unit tests for re-pin rules - only a downward gesture ending within `AT_BOTTOM_TOLERANCE`
     re-pins; upward transit through the band never re-pins; jump/submit re-pin unconditionally.
  4. GREEN: Implement re-pin arbitration.
  5. RED: Unit tests for write arbitration - while unpinned every `follow` write is denied and
     `anchor-compensation` writes are allowed; while pinned `follow` writes pass; controller-approved
     writes are recognized on the next scroll event (not misread as user movement).
  6. GREEN: Implement write classification, arbitration, and self-write bookkeeping.
  7. REFACTOR: Bottom-distance math stays imported from `scroll.ts` (no duplication, D-003); module
     comment (`Responsible for:` / `Not for:`); debug snapshot getter.

#### M3: Wire the web app through the controller

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Adapter tests (`use-scroll-follow.test.tsx` rewrite) - a wheel-up while pinned unpins
     synchronously within the same event; `pinned` is exposed to render for the jump button.
  2. GREEN: Rewrite `use-scroll-follow.ts` as the adapter over the controller (sync refs + render
     subscription); hoist pin state above `VirtualTranscript` remounts.
  3. RED: Component tests (`virtual-transcript.test.tsx`) - while unpinned: appended rows, `totalSize`
     growth, and the settle loop write nothing to `scrollTop`; while pinned they follow; the settle
     loop terminates on user scroll intent; `panel-host` no longer drops scroll events while
     `data-transcript-ready="false"`.
  4. GREEN: Collapse the follow effects into controller requests; route `scrollToFn`, the settle
     loop, and the `panel-host.tsx` listeners (with direction extraction) through the controller.
  5. RED: Component test - an above-viewport re-measure keeps the viewport content visually
     stationary while unpinned (anchor compensation accepted, net-zero movement).
  6. GREEN: Implement the anchor-compensation acceptance path.
  7. GREEN: The three M1 specs now pass; the four pre-existing Lane B scroll specs plus
     `app-boot`/`smoke` stay green (`pnpm test:e2e:browser`).
  8. REFACTOR: Delete the intent-window plumbing and dead gates; add `data-transcript-pinned`;
     module comments; confirm the DOM contract is unchanged except the additive attribute.

### Phase 3: Verification

#### M4: Full verification + manual EZE

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. GREEN: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e:browser` all green.
  2. RED: Manual EZE feel-check in a real browser against a live streaming session: read while
     streaming (no yank), slow-scroll up (no tug), rapid flick up (no reset) - be picky; any residual
     jitter is a finding, not a pass.
  3. REFACTOR: Record verification commands and observed feel-check results in the progress report;
     confirm the plan 33/35/34 notes still describe the landed contract.

### Done Gate

- [ ] The three new Lane B specs pass; the four pre-existing scroll specs are unchanged and green.
- [ ] While unpinned, no code path writes `scrollTop` toward the bottom (append, stream growth,
  settle loop, re-measurement).
- [ ] Upward gestures unpin synchronously; re-pin happens only via a deliberate bottom return, the
  jump button, or prompt submit.
- [ ] Scroll element identity and data hooks unchanged, except additive `data-transcript-pinned`.
- [ ] Full suites green; manual feel-check EZE done and recorded.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---:|---|
| Mid-gesture e2e specs are timing-sensitive and flake | medium | medium | Deterministic fixtures, `workers:1`, poll-based settling, monotonicity/direction assertions instead of exact px; if the race variant cannot be made reliable, keep the deterministic variant in Lane B and cover the race in component tests with fake timers. |
| Anchor-compensation writes re-open a tug vector | high | low | Compensation is accepted only for above-viewport growth and must keep the anchored row visually stationary; unit tests assert net-zero viewport movement; the M1 bug-2 spec is the backstop. |
| TanStack internals write scroll outside `scrollToFn` | medium | low | The controller's self-write bookkeeping surfaces unexpected writers (dev-only structured warning); audit during M3; keep `useAnimationFrameWithResizeObserver` batching. |
| Hoisting pin state breaks remount flows (session switch, chooser overlay, connecting branches) | medium | medium | Component tests for remount preservation; `app-boot` spec stays green. |
| Plans 33/35/34 were authored against the old model | low | low | Threaded via D-005 (forward-dependency notes recorded in each plan). |

## 5. Escape Hatches

1. **If the pure-controller extraction fights TanStack's internal scroll adjustments:** implement the
   same policy inside the existing hook + `scrollToFn` seams (still direction-based unpin + write
   classes, still one authority) and keep the e2e specs as the contract; the module split becomes a
   follow-up refactor.
2. **If anchor compensation cannot be made reliable:** ship follow-swallowing without compensation
   (strictly better than today), record the residual estimate-shift during fast flicks as a known
   issue, and open a follow-up plan for it.

## 6. Progress Report Accounting

Use `.plans/12.2-transcript-scroll-follow/progress-report.md` as the resume state. Before resuming or
declaring convergence:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "12.2-transcript-scroll-follow"
```

## 7. Validation Commands

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e:browser
```

## 8. Decisions

Canonical decisions are in `.plans/12.2-transcript-scroll-follow/plan.db`. Key decisions use
`<!-- D-NNN -->` markers above.

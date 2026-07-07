# Reconnecting Transcript Status - Implementation Plan

Refine the reconnecting transcript UX so a transient provider/server drop is one stable, useful status item instead of a stack of repeated alerts with raw gateway markup.

## 0. Hard Dependencies

None. This is a focused web transcript projection and rendering fix over the existing `assistant.reconnecting` protocol event.

## Architecture

`assistant.reconnecting` already exists in `@trevor/session`, and the host already emits it when a provider stream drops before useful output. The web fold currently treats every event as a standalone transcript marker. That is why repeated reconnect attempts render as separate "connection dropped" items, and why a provider detail such as an HTML 502 body can dominate the transcript.

The target shape keeps the wire event unchanged and fixes the web projection/presentation contract:

- the transcript fold maintains at most one reconnecting message per `runId`;
- later reconnecting events for the same run update that message's `attempt`, `maxAttempts`, and sanitized reason;
- row identity stays stable so the virtualized transcript updates in place;
- full and compact renderers share the same plain reconnect display model;
- Storybook's `Chat/CompactCatalog` includes the stable multi-attempt scenario.

<!-- D-001 --> Multiple `assistant.reconnecting` events for the same run update one transcript item in place instead of appending one row per attempt.

<!-- D-002 --> The reconnecting row renders plain, relevant status information only: a sanitized drop reason and current attempt budget. It must never show raw provider/server markup such as an HTML 502 body.

<!-- D-003 --> Reconnect status has an explicit compact presentation and must be represented in `Chat/CompactCatalog`, including a multi-attempt fixture that proves the latest attempt is the rendered one.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Protocol compatibility remains unchanged | Do not rename `assistant.reconnecting` or require a new host payload shape for this UX fix. |
| Transcript row identity must be stable | Key the reconnecting transcript message by `runId`, not by every event id, so attempts update in place. |
| Reconnected output still streams below the marker | Preserve the existing behavior where the answer after recovery starts as its own assistant segment. |
| Details must be sanitized before display | Collapse whitespace, strip markup, and cap the visible reason so gateway bodies cannot appear as transcript prose. |
| Compact mode is first class | `compactDisplayFor`, `CompactRow`, and `Chat/CompactCatalog` must show the same latest attempt state as full mode. |

### Boundaries

- **Protocol owner:** `packages/session` keeps the existing event type, decoder, tests, and optional `maxAttempts` compatibility behavior.
- **Transcript projection owner:** `apps/web/src/transcript.ts` owns coalescing reconnect events by `runId`, stable message ids, and display-safe reason text.
- **Action label owner:** `apps/web/src/action-label.ts` continues to own `reconnectActionLabel(attempt, maxAttempts)` so full, compact, and live status labels cannot drift.
- **Full row renderer:** `apps/web/src/components/chat/transcript-row-view.tsx` renders a compact alert-like marker without raw detail markup.
- **Compact row projection:** `apps/web/src/components/chat/compact-display.ts` renders reconnecting as a one-line running status with the latest attempt budget and a short sanitized reason.
- **Storybook catalog:** `apps/web/src/components/chat/compact-catalog-fixtures.ts` and `compact-catalog.stories.tsx` own the visual regression fixture.

### Observability

This work changes visible recovery state, not provider retry behavior. Runtime observability remains in the existing host/provider logs and `assistant.reconnecting` events. The UI-facing observability requirement is that a screenshot or Storybook catalog clearly answers:

- is Trevor reconnecting;
- which attempt out of the budget is active;
- what short class of failure triggered it;
- did repeated attempts update one item rather than flood the transcript.

No new storage root, protocol event, or host diagnostics channel is introduced.

## Phases

### Phase 1: Stable Reconnect Projection And Copy

**Goal:** Repeated reconnect attempts for one run render as one updating transcript item with safe, readable copy.

**Gate from previous:** Existing `assistant.reconnecting` decode tests and web transcript tests pass.

#### M1: Reproduce The Transcript Flood

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a web transcript unit test with two `assistant.reconnecting` events for the same `runId`, attempts `1/10` then `2/10`, and assert the projected transcript contains one reconnecting message.
  2. RED: Assert that the single reconnecting message carries the latest attempt and `maxAttempts`, while the recovered assistant output still appears below it.
  3. RED: Add a rendering test using a 502 HTML body detail and assert the visible full row does not include `<html>`, `<body>`, `ZenZG`, or other markup-only payload text.
  4. GREEN: Pin the current failure without production changes beyond test fixtures.
  5. REFACTOR: Name fixtures around the product rule, for example `sameRunReconnectAttempts`, not around the observed gateway implementation.

#### M2: Coalesce And Sanitize Reconnecting Messages

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. GREEN: In `toTranscript`, maintain reconnecting messages by `runId` and update the existing message when a later reconnecting event arrives for the same run.
  2. GREEN: Use a stable reconnecting message id derived from the run, while preserving event-order placement at the first reconnect marker.
  3. GREEN: Add a small display-safety helper for reconnect details that strips/collapses markup-heavy HTML, caps length, and falls back to a generic reason when the detail has no useful plain text.
  4. RED: Add edge-case tests for legacy reconnect events without `maxAttempts`, different `runId`s producing distinct markers, and a later same-run attempt not changing row order.
  5. GREEN: Pass the edge-case tests without changing protocol decode behavior.
  6. REFACTOR: Keep retry-state coalescing local to the transcript fold so components consume an already-correct `Message`.

#### M3: Refine Full And Compact Presentation

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add `TranscriptRowView` tests that full mode shows one concise reconnecting status with `reconnectActionLabel(latestAttempt, maxAttempts)`.
  2. GREEN: Render the full row with a short title and sanitized detail, avoiding raw gateway body text and duplicated "connection dropped" copy.
  3. RED: Add `compactDisplayFor` tests proving reconnecting compact rows use the shared attempt label and sanitized short reason.
  4. GREEN: Update compact reconnect display to show the latest attempt budget and readable reason within the one-line row constraints.
  5. REFACTOR: Share label/reason helpers where it prevents full and compact copy drift.

#### M4: Add CompactCatalog Coverage

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Extend `compact-catalog-fixtures.ts` with a multi-attempt reconnect scenario and a sanitized gateway-detail fixture.
  2. GREEN: Add the reconnect scenario to `Chat/CompactCatalog` or its active-state fixture so Storybook shows the final `2/10` style state as one compact row.
  3. RED: Extend `compact-catalog.test.tsx` to prove the catalog includes the reconnecting latest-attempt state and does not render raw markup.
  4. GREEN: Wire the fixture through the existing real `VirtualTranscript` renderer.
  5. REFACTOR: Keep the catalog's all-kinds coverage guard intact so reconnecting remains represented when message kinds evolve.

### Gate 1->done

- [ ] A same-run reconnect sequence projects one `reconnecting` message updated to the latest attempt.
- [ ] Different runs still produce distinct reconnecting markers.
- [ ] Full mode shows relevant retry state and no raw HTML/provider body markup.
- [ ] Compact mode shows the same latest attempt state in one line.
- [ ] `Chat/CompactCatalog` includes the reconnecting compact state and a test-backed fixture.
- [ ] `pnpm test:web -- apps/web/src/transcript.test.ts apps/web/src/components/chat/transcript-row-view.test.tsx apps/web/src/components/chat/compact-catalog.test.tsx` passes.
- [ ] `pnpm typecheck` and `pnpm lint` pass or have stated unrelated blockers.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Stable id changes virtualized row behavior | medium | medium | Cover transcript row keys and placement with unit tests, then inspect CompactCatalog. | web |
| Sanitizing detail hides useful provider information | low | medium | Keep a short plain reason such as `502 Bad Gateway` while dropping tags and server branding. | web |
| Coalescing by run hides distinct failures across different runs | medium | low | Explicit test that different `runId`s still create distinct reconnect markers. | web |
| Compact and full copy drift again | low | medium | Reuse `reconnectActionLabel` and display-safety helper from both render paths. | web |

## Escape Hatches

1. **If stable ids conflict with existing event-id assumptions:** keep `id` as the first reconnect event id and add a separate `runId` field to `ReconnectingMessage` for coalescing and tests.
2. **If markup stripping is too broad:** preserve the first recognized status phrase (`502 Bad Gateway`, `connection reset`, `websocket closed`) and fall back to `connection dropped` when extraction is uncertain.

## Progress Report Accounting

The progress report has four current-cutoff milestones and no deferred work. Run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.1-reconnecting-transcript-status"
```

## Validation Commands

```bash
pnpm test:web -- apps/web/src/transcript.test.ts apps/web/src/components/chat/transcript-row-view.test.tsx apps/web/src/components/chat/compact-catalog.test.tsx
pnpm --filter @trevor/web typecheck
pnpm typecheck
pnpm lint
```

## Decisions

Canonical decisions are in `.plans/58.1-reconnecting-transcript-status/plan.db`.

# Transcript Virtualization Performance - Implementation Plan

> This plan is planning-only as of 2026-06-27. It authorizes no code changes
> until explicitly picked up for implementation. It is subordinate to the
> canonical Trevor V2 plan at `.plans/trevor-v2/implementation.md`.

## Architecture

<!-- D-001 --> Trevor should use stable `@tanstack/react-virtual` for the
long-transcript rendering problem, not a custom windowing implementation.

<!-- D-002 --> Virtualization applies to transcript rows, not raw durable
events. The durable log remains complete, `toTranscript(events)` remains the
semantic fold, and a new pure row builder prepares the renderable list for the
virtualizer.

```text
session stream
  -> events[]
  -> toTranscript(events)
  -> readOnlyToolBatches(transcript)
  -> buildTranscriptRows(...)
  -> VirtualTranscript
  -> TranscriptRowView
```

### Key Constraints

| Constraint | Impact |
|---|---|
| Canonical Trevor V2 plan remains authoritative | This plan cannot change transport, session protocol, or host behavior. |
| <!-- D-003 --> Row indexes must map to real renderable rows | Concurrent tool continuations are skipped before virtualization, not rendered as null rows. |
| <!-- D-004 --> Chat live-edge behavior must remain stable | Initial replay opens at bottom, streaming follows only while pinned, and scrolling up stops follow. |
| <!-- D-005 --> Row heights are dynamic | Markdown, thinking, tool output, alerts, and images require dynamic measurement. |
| <!-- D-006 --> Composer isolation is metric-gated | Do not move composer state until virtualization metrics show whether it is still needed. |
| Stable TanStack packages only | No alpha, beta, rc, canary, or next dist-tags. |

### Boundaries

- `apps/web/src/transcript.ts` continues to own semantic event folding and panel
  model data.
- A new pure row module owns `TranscriptRow` construction and stable row keys.
- A new React virtual transcript component owns TanStack Virtual setup,
  measurement, end anchoring, and scroll controls.
- `PanelHost` owns layout composition but delegates transcript rendering.
- `PromptInput` remains behaviorally unchanged in the first cutoff.

### Observability

<!-- D-007 --> The implementation must produce before/after performance
artifacts, not just a subjective UI check. At minimum, record:

- event count and transcript row count
- mounted transcript row DOM count
- replay-to-interactive timing
- per-keystroke input delay or key-to-paint timing
- React commit duration while typing when profiler data is available
- scroll-follow state during replay, streaming, and scroll-up cases

## Phases

### Phase 1: Baseline And Targets

**Goal:** Reproduce the large-conversation lag and define pass/fail budgets
before changing rendering.

#### M1: Large-session measurement harness

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add or identify a deterministic large-session fixture that produces
     thousands of events and a large transcript.
  2. RED: Capture current baseline metrics for input delay, replay time, mounted
     row count, and scroll position.
  3. RED: Capture a real-session measurement when a local large session is
     available.
  4. GREEN: Document target budgets for this cutoff.

### Phase 2: Row Model

**Goal:** Create a stable renderable row list that can be virtualized without
changing visible behavior.

#### M2: Build transcript rows

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Test that row building contains no null or hidden rows.
  2. RED: Test that every current message kind maps to a stable row key.
  3. RED: Test that concurrent read-only tool batches become one row and
     continuation tool messages disappear from the row list.
  4. RED: Test that working and queued prompt rows appear at the live edge.
  5. GREEN: Implement the pure row builder and row type union.
  6. REFACTOR: Add module comments explaining row ownership and invariants.

### Phase 3: Virtual Transcript Boundary

**Goal:** Replace full transcript mounting with a TanStack Virtual boundary.

#### M3: Virtualized renderer

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add component tests for rendering a visible subset from a large row
     list.
  2. GREEN: Add stable `@tanstack/react-virtual`.
  3. GREEN: Extract `TranscriptRowView` from the existing `PanelHost` row
     dispatch.
  4. GREEN: Add `VirtualTranscript` with stable `getItemKey`, overscan, and
     dynamic measurement.
  5. GREEN: Preserve `data-message-id`, quote selection, doctor rows, shell
     rows, task-adjacent layout, and queued prompt rendering.
  6. REFACTOR: Remove obsolete null-row and full-list rendering assumptions.

### Phase 4: Scroll And Dynamic Measurement

**Goal:** Preserve Trevor's chat/log scroll behavior with dynamic virtual rows.

#### M4: Live-edge behavior

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Browser test initial replay opens at the bottom for a large session.
  2. RED: Browser test streaming appends stay pinned only while already at the
     live edge.
  3. RED: Browser test scrolling up prevents automatic bottom yank.
  4. RED: Browser test markdown, thinking, image, and tool-height changes
     remeasure without scroll drift.
  5. GREEN: Move bottom-follow and jump-to-bottom logic onto the virtualizer
     boundary.
  6. REFACTOR: Remove raw `scrollHeight` assumptions that no longer apply.

### Phase 5: Composer Responsiveness Gate

**Goal:** Only isolate composer state if virtualization does not meet input
latency targets.

#### M5: Metric-gated composer isolation

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Re-run key-to-paint and React commit metrics after virtualization.
  2. RED: If the target still fails, add a regression test or profiler artifact
     showing transcript/panel re-render on keystroke.
  3. GREEN: Memoize the transcript subtree or move composer-local state behind a
     smaller boundary only when metrics require it.
  4. GREEN: Preserve slash command menu, prompt history, image tokens,
     attachments, quote insertion, and shell mode.
  5. REFACTOR: Keep composer changes isolated from session and transcript
     semantics.

### Phase 6: Selector And Side-Panel Cost

**Goal:** Avoid optimizing selectors before evidence, but handle them if large
sessions still spend time outside rendering.

#### M6: Selector profiling

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Capture selector costs for `toTranscript`, `panelModel`,
     `hostStatus`, and related event scans on a large session.
  2. GREEN: Leave selectors unchanged if render virtualization fixes the budget.
  3. GREEN: If selector cost remains material, add targeted tests for the slow
     selector before changing it.
  4. REFACTOR: Keep any selector cache keyed by immutable event-array identity
     and current replay status.

### Phase 7: Regression Gates

**Goal:** Make large-conversation performance hard to regress.

#### M7: Performance test lane

- **Dependencies:** M5, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add a synthetic large-session browser or e2e check.
  2. RED: Assert mounted transcript row DOM count stays bounded.
  3. RED: Assert input latency or key-to-paint stays under the chosen budget.
  4. RED: Assert replay-to-interactive stays under the chosen budget.
  5. RED: Assert scroll stability for pinned and scrolled-up states.
  6. GREEN: Wire the check into the appropriate local/CI lane or document why it
     remains manual.

### Phase 8: Final Verification

**Goal:** Ship only after correctness and performance are both verified.

#### M8: Gates

- **Dependencies:** M7
- **Effort:** S
- **Tasks:**
  1. GREEN: Confirm `@tanstack/react-virtual` resolves to a stable release.
  2. GREEN: `pnpm lint`
  3. GREEN: `pnpm typecheck`
  4. GREEN: `pnpm test:web`
  5. GREEN: Relevant unit tests pass.
  6. GREEN: Relevant e2e or browser performance lane passes.
  7. GREEN: Manual EZE check on a real large session confirms typing, replay,
     streaming, and scroll behavior.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Bottom anchoring regresses | high | medium | Dedicated replay and streaming browser tests | web |
| Dynamic row heights cause scroll jumps | high | medium | Measure rows and test markdown/image/thinking changes | web |
| Composer lag persists after virtualization | medium | medium | Metric-gated composer isolation phase | web |
| Tool batching changes visible order | medium | low | Pure row-model tests around read-only batches | web |
| Browser perf lane flakes | medium | medium | Keep synthetic fixture deterministic and compare metrics, not screenshots only | web |

## Escape Hatches

1. **If TanStack Virtual cannot preserve dynamic bottom anchoring:** keep the
   row model and implement a narrower virtualized tail plus static older-history
   placeholder as a second design.
2. **If virtualization improves DOM cost but not input latency:** execute M5 and
   isolate composer state from the transcript/panel subtree.
3. **If browser performance tests are too flaky for CI:** keep deterministic
   unit/component tests in CI and require a documented local browser perf gate
   for this feature.

## Validation Commands

```bash
pnpm view @tanstack/react-virtual version
pnpm lint
pnpm typecheck
pnpm test:web
pnpm test:e2e
```

## Decisions

Canonical decisions are in `.plans/transcript-virtualization-performance/plan.db`.
Key decisions referenced in this document use `<!-- D-NNN -->` markers.

# Assistant-UI Thread Virtualization - Implementation Plan

## 0. Hard Dependencies

- [x] Existing Trevor transcript projection exists: `toTranscript`, `readOnlyToolBatches`,
  `buildTranscriptRows`, `TranscriptRowView`, and `VirtualTranscript`.
- [x] Existing scroll authority exists in `scroll-follow.ts` and `use-scroll-follow.ts`; it owns pin,
  unseen-content, explicit jump-to-bottom, and approved programmatic writes.
- [x] `@assistant-ui/react` is already present in `apps/web`, but the live Trevor transcript is not
  backed by assistant-ui runtime messages. This plan does not require that migration.
- [x] Downstream accommodation - none. No later numbered plans exist after 58.4 at creation time.

## 1. Architecture

### Current Problem

`VirtualTranscript` currently virtualizes individual transcript rows with absolutely positioned
children translated to `item.start`. During sidebar drag, `PanelHost` commits the sidebar width on
every raw mousemove. That continuously changes the transcript column width, long text wraps by one
line at many intermediate widths, and TanStack Virtual remeasures row heights while Trevor's follow
and anchor-compensation effects are also reacting to `totalSize`.

The result is a feedback loop:

```text
sidebar mousemove -> transcript width changes -> row text wraps -> virtualizer remeasures
  -> total size changes -> follow/anchor correction -> render -> repeat
```

### Target Shape

Adopt the assistant-ui thread virtualization composition pattern fully for Trevor's transcript
surface: group content into stable turn-level virtual items, render mounted items in normal document
flow with padding spacers for the unmounted regions, and keep a single scroll owner. The underlying
virtualizer may remain `@tanstack/react-virtual`, but Trevor stops using row-level absolute
positioning for the chat transcript. <!-- D-001 -->

The assistant-ui guide is the reference pattern:
https://www.assistant-ui.com/docs/guides/virtualization

The plan adapts the guide to Trevor's existing transcript row model instead of migrating the durable
projection into assistant-ui runtime messages. Trevor rows carry tool batches, compact rows, detail
takeovers, `data-message-id` selection anchors, Lucid/artifact controls, and local row expansion
state. Those stay owned by Trevor in this plan. <!-- D-003 -->

### Boundaries

```
apps/web/src/transcript-rows.ts
  buildTranscriptRows        - remains the semantic row projection consumed by rendering.
  transcriptRowKey           - remains row identity inside a turn.

apps/web/src/components/chat/transcript-turns.ts
  buildTranscriptTurns       - new pure grouping layer. Turns are stable virtual items:
                               a user row plus all rows until the next user row; preface rows
                               before the first user message form a synthetic preface turn.
  transcriptTurnKey          - stable identity for virtualizer item keys.
  estimateTurnSize           - estimate from constituent row estimates plus compact gap behavior.

apps/web/src/components/chat/virtual-transcript.tsx
  VirtualTranscript          - replaced internally with turn-level virtualization and spacer
                               padding. Public props stay compatible with PanelHost.
  Spacer layout              - mounted turns are regular flow children inside a container with
                               paddingTop/paddingBottom, not absolute positioned rows.

apps/web/src/scroll-follow.ts
apps/web/src/hooks/use-scroll-follow.ts
  ScrollFollowController     - stays the single authority for every programmatic scroll write.
                               Virtualizer measurement writes are still routed through it.

apps/web/src/components/panel/panel-host.tsx
  Sidebar resize             - drag preview and persistence are separated or animation-frame gated,
                               so raw mousemove does not force app-wide persisted width updates.
```

### Scroll Ownership

Do not use `ThreadPrimitive.Viewport` for the live Trevor transcript in this plan. Its built-in
auto-scroll assumes all messages are mounted, while this plan intentionally unmounts off-viewport
turns. Trevor keeps the existing scroll well and controller as the scroll owner. <!-- D-002 -->

Pinned behavior:

- explicit jump-to-bottom re-pins and scrolls to the live edge through the controller
- append-follow and streaming-follow ask the controller at fire time
- while pinned, virtualizer remeasure adjustments must not rubber-band against follow writes
- while unpinned, visual-anchor compensation may adjust scrollTop if and only if the controller
  approves it as anchor compensation

### Resize Stability

Sidebar drag is part of the transcript contract. The resize handle must not persist and propagate
width on every raw mousemove in a way that causes transcript-wide measurement churn. Implementation
can use a local preview width, a requestAnimationFrame gate, a commit-on-release preference update,
or a combination, but the finished behavior must prove that dragging the left sidebar over a long
transcript does not produce rapid one-line vertical reflow. <!-- D-005 -->

### Non-Goals

- No durable session protocol changes.
- No migration of Trevor's transcript projection to assistant-ui runtime message storage.
- No adoption of `ThreadPrimitive.Unstable_MessageById` as a dependency for the live transcript.
- No removal of TanStack Virtual from the project if it remains useful under the assistant-ui
  composition pattern.
- No redesign of transcript visual styling beyond what is required for stable flow layout.

---

## 2. Current-Cutoff Milestones

### M1: Characterize Current Resize And Scroll Churn

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a focused `VirtualTranscript` or `PanelHost` characterization that simulates sidebar
     width changes against long assistant/user text and records repeated measurement/follow writes.
  2. RED: Add a pure `scroll-follow` regression proving approved virtualizer self-writes are not
     misclassified as user movement during a layout-width change.
  3. GREEN: Add minimal test hooks or fixtures needed to observe virtualizer follow vs
     anchor-compensation writes without changing production behavior.
  4. GREEN: Capture the existing failure signature in test names and comments: width drag causes
     repeated one-line row remeasure and scroll correction churn.
  5. REFACTOR: Keep the characterization local to transcript/scroll tests; do not add a broad
     browser automation harness yet.

### M2: Turn-Level Transcript Grouping

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add unit tests for `buildTranscriptTurns`: a user row starts a turn, following assistant,
     tool, shell, result, marker, and `tool_batch` rows stay in that turn until the next user row.
  2. RED: Add edge-case tests for empty transcripts, preface rows before the first user message,
     compact mode expanded rows, and read-only tool batches.
  3. GREEN: Add `transcript-turns.ts` with stable turn keys, row membership, and estimate helpers that
     reuse existing row estimate semantics instead of duplicating message-kind knowledge.
  4. GREEN: Preserve row-level `data-message-id` and `transcriptRowKey` inside each turn so quote
     selection, detail takeovers, compact expansion, and tests still address the original row.
  5. REFACTOR: Keep turn grouping pure and colocated with transcript row projection; React state stays
     in `VirtualTranscript`.

### M3: Replace Absolute Rows With Spacer-Based Flow Virtualization

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add a rendering test proving virtualized items are turn containers in normal flow with
     padding spacers and no `absolute`/`translateY` row positioning.
  2. RED: Add a test proving `paddingTop` and `paddingBottom` represent unmounted regions and update
     from `virtualizer.getVirtualItems()`/`getTotalSize()`.
  3. GREEN: Rewrite `VirtualTranscript` internals to virtualize turns, render turn children in normal
     document flow, and measure the turn container with `virtualizer.measureElement`.
  4. GREEN: Preserve the existing public `VirtualTranscriptProps` so `PanelHost`, stories, and tests
     do not need a second transcript component.
  5. RED: Add regression coverage for compact spacing across turn boundaries and adjacent tool batches
     so the visual grouping from plan 58 remains intact.
  6. REFACTOR: Remove obsolete visual-anchor DOM queries that depended on row-level absolute
     positioning, replacing them with turn-aware helpers where still needed.

### M4: Reconcile Scroll Ownership And Sidebar Resize

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving pinned remeasurement suppresses virtualizer-owned scroll adjustments that
     would fight live-edge follow, while explicit jump-to-bottom still works.
  2. RED: Add tests proving unpinned resize/remeasure can perform approved anchor compensation without
     re-pinning or following to the live edge.
  3. GREEN: Update `scrollToFn`, follow effects, and settle logic so the controller remains the only
     programmatic scroll authority under turn-level virtualization. <!-- D-002 -->
  4. RED: Add a `PanelHost` or hook test proving sidebar drag does not persist the preference or
     trigger app-wide width state updates on every raw mousemove.
  5. GREEN: Split sidebar resize preview from persisted width, or gate resize commits to animation
     frames and commit the stored preference on release. <!-- D-005 -->
  6. REFACTOR: Keep resize behavior local to the sidebar binding; transcript components should not
     need a global "resizing" flag unless tests prove scroll corrections still need one.

### M5: Browser Verification, Cleanup, And Cutover

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add or update Storybook fixtures for long transcript, compact long transcript, streaming
     bottom-pinned transcript, and unpinned reading state under the new turn virtualizer.
  2. GREEN: Update stories and fixture helpers to exercise turn-level virtualization and the left
     sidebar resize scenario.
  3. RED: Add a browser/manual or Codex computer-use verification checklist for dragging the left
     sidebar over a long transcript with no rapid one-line vertical reflow. <!-- D-004 -->
  4. GREEN: Run the browser check against the local app or Storybook fixture and capture the result in
     the progress report before marking the plan complete.
  5. GREEN: Remove obsolete absolute-row tests, comments, and dead helpers once replacement coverage
     exists.
  6. REFACTOR: Re-scan `virtual-transcript.tsx`, `scroll-follow.ts`, and `panel-host.tsx` for duplicate
     scroll policy, stale comments, and unnecessary custom compensation now covered by the new layout.
  7. REFACTOR: Keep final validation gates green: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and a
     targeted web project run for transcript tests.

### Current Cutoff Gate

- [ ] Transcript virtualization groups by stable turns, not individual rows.
- [ ] Mounted virtual items are normal-flow children with spacer padding, not absolute translated
      rows.
- [ ] Trevor's scroll-follow controller remains the only programmatic scroll authority.
- [ ] Sidebar drag no longer commits persisted width on every raw mousemove or causes rapid one-line
      transcript reflow.
- [ ] Quote selection, compact rows, tool batches, detail takeovers, artifact controls, and jump to
      bottom still work.
- [ ] Browser verification confirms the original sidebar-drag failure is gone.
- [ ] Lint, typecheck, web tests, and the full test suite pass.

---

## 3. Accepted/Deferred Follow-Up

### FP1: Assistant-UI Runtime Transcript Migration

- If a later product direction wants assistant-ui runtime messages as the source of truth, create a
  separate plan. That migration would need to map Trevor protocol events, tool batches, artifacts,
  tangents, and compact rows into assistant-ui message parts without losing existing semantics.

### FP2: Non-Virtualized Live Transcript Cut

- If turn-level virtualization still creates more scroll complexity than value for typical Trevor
  sessions, a later plan may replace the live transcript with normal rendering plus transcript
  compaction and archived-history virtualization. This plan does not choose that fallback unless the
  current cutoff gate fails.

---

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Turn grouping changes visual spacing or selection anchors | high | medium | M2 and M3 pin row membership, row keys, compact spacing, and `data-message-id` preservation | web |
| Scroll policy remains duplicated between virtualizer effects and controller | high | medium | M4 explicitly tests pinned and unpinned write ownership through the controller | web |
| Sidebar resize fix masks rather than removes virtualization churn | medium | medium | M1 captures the old signature; M5 requires browser verification during active drag | web |
| Assistant-ui APIs marked unstable change if adopted directly | medium | low | D-003 avoids depending on `Unstable_MessageById` for the live transcript | web |
| Turn-level items become too tall for efficient virtualization in giant tool-heavy turns | medium | medium | M2 estimates by constituent rows; FP2 remains the fallback if live virtualization remains too complex | web |

---

## 5. Escape Hatches

1. **If turn-level virtualization still jitters during resize:** keep the turn grouping and spacer
   layout, but freeze non-explicit virtualizer scroll adjustments during active resize and replay one
   controller-approved correction after resize ends.

2. **If turn-level items are too coarse for heavy tool bursts:** split oversized turns into stable
   subturn groups at safe row boundaries, but keep spacer flow layout and never return to row-level
   absolute positioning.

3. **If virtualization remains more complex than value:** cut over to normal-flow rendering for the
   live transcript and virtualize only archive/history views. This requires an explicit gate failure
   and should be recorded as a plan iteration before implementation continues.

---

## 6. Validation

Run narrow tests first, then the full gates:

```sh
pnpm vitest run --project web apps/web/src/components/chat/virtual-transcript.test.tsx
pnpm vitest run --project web apps/web/src/components/chat/compact-spacing-layout.test.tsx
pnpm vitest run --project web apps/web/src/components/panel/panel-host.test.tsx
pnpm vitest run --project unit apps/web/src/scroll-follow.test.ts
pnpm typecheck
pnpm lint
pnpm test
```

For the visual resize gate, run the local app or Storybook fixture in a real browser and drag the left
sidebar across a long transcript while both pinned and unpinned. Computer-use verification is
appropriate for this gate because jsdom cannot prove pixel stability. <!-- D-004 -->

---

## Decisions

Canonical decisions are in the plan database
(`.plans/58.4-assistant-ui-thread-virtualization/plan.db`).

- D-001: Adopt the assistant-ui thread virtualization composition pattern fully for Trevor.
- D-002: Keep Trevor's scroll-follow controller as the single scroll authority.
- D-003: Adapt the pattern to Trevor's transcript row model instead of migrating to assistant-ui
  runtime messages.
- D-004: Validate with targeted tests plus a real browser/computer-use drag check.
- D-005: Treat sidebar drag as a first-class transcript stability case.

# Transcript Virtualization Performance - Progress Report

**Status:** Planning complete, implementation not started.

## Current phase: Phase 1

First unchecked current-cutoff item: M1 deterministic large-session fixture.

## Summary

- Total checklist items: 44
- Completed: 0
- Remaining: 44
- Current cutoff blockers: 44
- Deferred follow-up: 4

## Phase 1: Baseline And Targets

### M1: Large-session measurement harness

- [ ] Deterministic large-session fixture identified or added
- [ ] Current baseline metrics captured for input delay, replay time, mounted
  row count, and scroll position
- [ ] Real-session measurement captured when a local large session is available
- [ ] Target budgets documented for this cutoff

## Phase 2: Row Model

### M2: Build transcript rows

- [ ] Row building test proves there are no null or hidden rows
- [ ] Every current message kind maps to a stable row key
- [ ] Concurrent read-only tool batches become one row and continuations are
  omitted
- [ ] Working and queued prompt rows appear at the live edge
- [ ] Pure row builder and row type union implemented
- [ ] Row module comments explain ownership and invariants

## Phase 3: Virtual Transcript Boundary

### M3: Virtualized renderer

- [ ] Component tests cover rendering a visible subset from a large row list
- [ ] Stable `@tanstack/react-virtual` dependency added
- [ ] `TranscriptRowView` extracted from existing row dispatch
- [ ] `VirtualTranscript` added with stable keys, overscan, and measurement
- [ ] Quote selection, doctor rows, shell rows, task-adjacent layout, and queued
  prompts preserved
- [ ] Obsolete null-row and full-list assumptions removed

## Phase 4: Scroll And Dynamic Measurement

### M4: Live-edge behavior

- [ ] Browser test proves initial replay opens at bottom for a large session
- [ ] Browser test proves streaming appends stay pinned only at the live edge
- [ ] Browser test proves scrolling up prevents automatic bottom yank
- [ ] Browser test proves markdown, thinking, image, and tool-height changes
  remeasure without scroll drift
- [ ] Bottom-follow and jump-to-bottom logic moved onto virtualizer boundary
- [ ] Raw `scrollHeight` assumptions removed where no longer valid

## Phase 5: Composer Responsiveness Gate

### M5: Metric-gated composer isolation

- [ ] Key-to-paint and React commit metrics rerun after virtualization
- [ ] If target still fails, regression artifact shows transcript or panel
  re-render on keystroke
- [ ] Transcript subtree memoized or composer state isolated only if metrics
  require it
- [ ] Slash command menu, prompt history, image tokens, attachments, quote
  insertion, and shell mode preserved
- [ ] Composer changes remain isolated from session and transcript semantics

## Phase 6: Selector And Side-Panel Cost

### M6: Selector profiling

- [ ] Selector costs captured for `toTranscript`, `panelModel`, `hostStatus`,
  and related event scans on a large session
- [ ] Selectors intentionally left unchanged if render virtualization fixes the
  budget
- [ ] Targeted tests added before any selector optimization
- [ ] Selector cache, if added, is keyed by immutable event-array identity and
  replay status

## Phase 7: Regression Gates

### M7: Performance test lane

- [ ] Synthetic large-session browser or e2e check added
- [ ] Mounted transcript row DOM count stays bounded
- [ ] Input latency or key-to-paint stays under the chosen budget
- [ ] Replay-to-interactive stays under the chosen budget
- [ ] Scroll stability passes for pinned and scrolled-up states
- [ ] Performance check wired into the right local/CI lane or documented as
  manual

## Phase 8: Final Verification

### M8: Gates

- [ ] `@tanstack/react-virtual` resolves to a stable release
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:web`
- [ ] Relevant unit tests pass
- [ ] Relevant e2e or browser performance lane passes
- [ ] Manual EZE check on a real large session confirms typing, replay,
  streaming, and scroll behavior

## Deferred Follow-Up

- [ ] Alternative older-history placeholder design if full dynamic
  virtualization fails
- [ ] Rich scroll-position debugging overlay for developers
- [ ] Long-term dashboard of transcript performance metrics across sessions
- [ ] Automatic capture of profiler traces on local performance failure

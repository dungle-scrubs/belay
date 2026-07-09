# Assistant-UI Thread Virtualization - Progress Report

**Plan:** `58.4-assistant-ui-thread-virtualization`
**Stage:** ready for implementation
**Current focus:** M1 - Characterize Current Resize And Scroll Churn (5/5)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 29 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 29 |
| Accepted/deferred follow-up | 2 |
| Superseded/obsolete | 0 |

The plan replaces Trevor's row-level absolute `VirtualTranscript` internals with the assistant-ui
thread virtualization composition pattern adapted to Trevor rows: stable turn-level virtual items,
normal-flow mounted content, padding spacers, Trevor-owned scroll policy, and explicit sidebar-resize
stability.

## Decisions

- D-001: Adopt the assistant-ui thread virtualization composition pattern fully for Trevor.
- D-002: Keep Trevor's scroll-follow controller as the single scroll authority.
- D-003: Adapt the pattern to Trevor's transcript row model instead of migrating to assistant-ui
  runtime messages.
- D-004: Validate with targeted tests plus a real browser/computer-use drag check.
- D-005: Treat sidebar drag as a first-class transcript stability case.

---

## Current Cutoff

### M1 - Characterize Current Resize And Scroll Churn (5/5)

- [ ] RED: Simulate sidebar width changes against long transcript text and record repeated
      measurement/follow writes.
- [ ] RED: Prove approved virtualizer self-writes are not misclassified as user movement during a
      layout-width change.
- [ ] GREEN: Add minimal test hooks or fixtures for observing follow vs anchor-compensation writes.
- [ ] GREEN: Capture the old failure signature in test names/comments.
- [ ] REFACTOR: Keep characterization local to transcript/scroll tests.

### M2 - Turn-Level Transcript Grouping (5/5)

- [ ] RED: `buildTranscriptTurns` groups a user row plus following assistant/tool/shell/result/marker
      rows until the next user row.
- [ ] RED: Cover empty transcripts, preface rows, compact expanded rows, and read-only tool batches.
- [ ] GREEN: Add `transcript-turns.ts` with stable keys, row membership, and estimate helpers.
- [ ] GREEN: Preserve row-level `data-message-id` and `transcriptRowKey` inside each turn.
- [ ] REFACTOR: Keep grouping pure and React state in `VirtualTranscript`.

### M3 - Spacer-Based Flow Virtualization (6/6)

- [ ] RED: Mounted virtualized items are normal-flow turn containers, not absolute translated rows.
- [ ] RED: `paddingTop` and `paddingBottom` represent unmounted regions.
- [ ] GREEN: Rewrite `VirtualTranscript` internals to virtualize turns and measure turn containers.
- [ ] GREEN: Preserve the existing public `VirtualTranscriptProps` surface.
- [ ] RED: Preserve compact spacing across turn boundaries and adjacent tool batches.
- [ ] REFACTOR: Replace obsolete row-level absolute-position visual-anchor helpers.

### M4 - Scroll Ownership And Sidebar Resize (6/6)

- [ ] RED: Pinned remeasurement suppresses virtualizer-owned scroll adjustments that would fight
      live-edge follow, while explicit jump-to-bottom still works.
- [ ] RED: Unpinned resize/remeasure can perform approved anchor compensation without re-pinning.
- [ ] GREEN: Update `scrollToFn`, follow effects, and settle logic so the controller remains the only
      programmatic scroll authority.
- [ ] RED: Sidebar drag does not persist preference or trigger app-wide width state updates on every
      raw mousemove.
- [ ] GREEN: Split sidebar resize preview from persisted width, or gate resize commits and commit
      stored preference on release.
- [ ] REFACTOR: Keep resize behavior local to the sidebar binding unless tests prove otherwise.

### M5 - Browser Verification, Cleanup, And Cutover (7/7)

- [ ] RED: Add/update Storybook fixtures for long, compact, streaming pinned, and unpinned transcripts.
- [ ] GREEN: Update stories and fixtures to exercise turn-level virtualization and sidebar resize.
- [ ] RED: Add a browser/manual or Codex computer-use checklist for dragging the left sidebar with no
      rapid one-line vertical reflow.
- [ ] GREEN: Run the browser check and capture the result before marking the plan complete.
- [ ] GREEN: Remove obsolete absolute-row tests, comments, and dead helpers.
- [ ] REFACTOR: Re-scan transcript, scroll, and sidebar files for duplicate scroll policy and stale
      comments.
- [ ] REFACTOR: Keep `pnpm lint`, `pnpm typecheck`, `pnpm test`, and targeted web tests green.

---

## Accepted/Deferred Follow-Up

### FP1 - Assistant-UI Runtime Transcript Migration (1)

- [ ] Create a separate plan if Trevor should migrate durable transcript projection to assistant-ui
      runtime messages.

### FP2 - Non-Virtualized Live Transcript Cut (1)

- [ ] If the current cutoff gate fails, iterate the plan toward normal-flow live rendering plus
      archive/history virtualization.

## Next Step

Start M1 RED with the smallest characterization around sidebar width changes and virtualizer write
classification.

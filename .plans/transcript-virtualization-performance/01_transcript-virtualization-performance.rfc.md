---
number: 01
title: "Transcript Virtualization Performance"
type: refactor
status: Draft
author: Kevin Frilot
date: 2026-06-27
---

# RFC-01: Transcript Virtualization Performance

## Abstract

Large Trevor sessions can make the browser input feel delayed because the app
keeps a long, fully mounted transcript in the React tree. This RFC proposes a
measured refactor that virtualizes transcript rows with TanStack Virtual while
preserving the existing event-log, transcript-folding, bottom-follow, quote, and
composer behavior. The work starts with performance evidence, then introduces a
stable row model, a `VirtualTranscript` boundary, dynamic row measurement, and
regression gates for input latency and scroll stability.

## Introduction

Trevor's web UI is a durable session viewer. A browser reload receives the full
session log, folds it into transcript messages, and renders the whole history.
`useSession` already buffers replay into one state commit, but after replay the
DOM still contains every transcript row. The prompt composer state also lives in
`App`, so each keystroke can still ask React to reconcile a large transcript and
side panel subtree.

In scope:

- <!-- D-001 --> Use stable `@tanstack/react-virtual` for transcript
  virtualization.
- <!-- D-002 --> Virtualize transcript rows, not raw durable events.
- Preserve the existing session protocol, host behavior, and transcript
  semantics.
- Measure large-session input latency, replay-to-interactive time, row DOM
  count, scroll stability, and render/commit cost.
- Define tests and gates before implementation.

Out of scope:

- Implementing virtualization in this planning turn.
- Changing Richter/session-store protocol.
- Dropping transcript history from the durable log.
- Rewriting markdown, doctor, task, or side-panel rendering without performance
  evidence.
- Replacing React or the current Vite app structure.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

- **Event log**: The ordered durable session events from session-store or
  Richter.
- **Transcript message**: The current `toTranscript(events)` output item.
- **Transcript row**: A renderable virtualizer item. A row MAY contain one
  transcript message, a concurrent tool batch, a working indicator, or queued
  prompt state.
- **Virtualizer**: The TanStack Virtual instance that owns visible row indexes,
  dynamic measurement, and end anchoring.
- **Live edge**: The bottom of the transcript while the user is following new
  output.
- **Large session**: Any replayed session whose event count or rendered row
  count is large enough to make input or scroll responsiveness measurable.

## Current State

The current web path is:

```text
useSession(sessionId)
  -> events[]
  -> toTranscript(events)
  -> readOnlyToolBatches(transcript)
  -> PanelHost
  -> transcript.map(...)
  -> PromptInput
```

Relevant current files:

- `apps/web/src/session/use-session.ts` buffers replay events and commits once.
- `apps/web/src/transcript.ts` folds raw events into transcript messages and
  panel data.
- `apps/web/src/App.tsx` owns composer state, transcript selectors, scroll
  following, side-panel model, and modal wiring.
- `apps/web/src/components/panel/PanelHost.tsx` renders the complete transcript
  with `transcript.map(...)`.
- `apps/web/src/components/chat/prompt-input.tsx` is a controlled textarea whose
  value updates on each keystroke.

Pain points:

- The complete transcript remains mounted after replay.
- Current row rendering has hidden skips for concurrent tool batches, which is a
  poor direct fit for virtualizer indexes.
- Bottom-follow behavior is implemented with raw `scrollHeight` and a
  `ResizeObserver` over the whole content element.
- Dynamic row heights come from markdown, thinking blocks, tool renderers,
  images, alerts, and collapsible content.
- Composer updates currently happen in the same `App` component that owns the
  transcript view model.

## Proposed Changes

<!-- D-003 --> The implementation SHOULD introduce an explicit
`TranscriptRow[]` view model before rendering. This row model removes null rows
and gives the virtualizer stable keys.

```text
events[]
  -> toTranscript(events)
  -> buildTranscriptRows(transcript, toolBatches, liveState, queue)
  -> VirtualTranscript
  -> TranscriptRowView
```

Proposed boundaries:

- `apps/web/src/transcript-rows.ts` or adjacent module owns pure row-building.
- `apps/web/src/components/chat/virtual-transcript.tsx` owns TanStack Virtual
  setup and scroll/end anchoring.
- `apps/web/src/components/chat/transcript-row.tsx` or a local helper owns row
  dispatch for message kinds.
- `PanelHost` passes stable data and callbacks into `VirtualTranscript`.
- `PromptInput` behavior remains unchanged in the first virtualization cut.

<!-- D-004 --> The row model MUST preserve existing semantics:

- Consecutive read-only tools render as one concurrent batch row.
- Skipped batch continuation messages are not virtual rows.
- `data-message-id` remains available for quote selection on rendered message
  rows.
- Working and queued prompt UI remain visible at the live edge.
- Doctor, shell, delegation, recovered, reconnecting, compacting, overflow, and
  error rows keep their current visual meaning.

<!-- D-005 --> Dynamic measurement is required. Rows SHOULD use TanStack
Virtual's element measurement path because markdown, images, and collapsible
thinking can change height after initial render.

<!-- D-006 --> Composer-state isolation is a measured follow-up. If
virtualization leaves per-keystroke latency above the target budget, then the
implementation SHOULD memoize or isolate the transcript/panel subtree or move
composer-local state behind a smaller boundary.

## Migration Strategy

1. Add a large-session performance reproduction and baseline metrics.
2. Add pure `buildTranscriptRows` tests without changing rendering.
3. Add TanStack Virtual as a stable dependency only when implementation begins.
4. Replace the transcript body with `VirtualTranscript` behind existing
   `PanelHost` props.
5. Move bottom-follow and jump-to-bottom behavior onto the virtualizer boundary.
6. Add browser/performance gates and compare before/after metrics.
7. Only then consider composer isolation if the measured input budget still
   fails.

Rollback is straightforward: keep row-building pure and keep the old renderer
available during the migration until the virtualized path passes parity tests.

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Initial reload no longer lands at the bottom | high | Dedicated browser test for replayed large session at live edge |
| Streaming yanks user back to bottom after they scroll up | high | Scroll-up test where live events append without forced follow |
| Dynamic markdown/image heights create jumpy scroll | high | Element measurement tests plus manual EZE on image/thinking rows |
| Quote selection stops working for virtualized rows | medium | Preserve `data-message-id`; test quote toolbar on visible rows |
| Tool batching regresses | medium | Pure row-model tests for concurrent read-only batches |
| Virtualization hides live working or queue state | medium | Row-model tests for working and queued rows |
| Browser-only performance tests become flaky | medium | Use thresholds with before/after artifacts and deterministic synthetic sessions |
| Dependency churn | low | Use stable TanStack Virtual only; no prerelease packages |

## Testing Strategy

<!-- D-007 --> Performance gates MUST be explicit before the renderer changes.
The first implementation pass should define targets for:

- Per-keystroke input delay on a large session.
- React commit duration while typing.
- Mounted transcript row DOM count.
- Replay-to-interactive time.
- Scroll stability while pinned and while scrolled up.

Required coverage:

- Unit tests for `buildTranscriptRows`.
- Component tests for virtual transcript row rendering.
- Browser or e2e performance check against a synthetic large session.
- Manual EZE verification against a real large session when available.
- Existing `pnpm test:web`, typecheck, lint, and relevant e2e gates.

## Implementation Plan

See `.plans/transcript-virtualization-performance/implementation.md`.

## Open Questions

1. What target input latency should block the cutoff: P95 under 16ms, 32ms, or a
   project-specific threshold measured on the local machine?
2. Should the first browser performance lane live in Vitest/jsdom,
   Playwright/browser-tools, or the existing e2e workspace?
3. Should composer isolation happen in the same cutoff if virtualization improves
   but does not fully solve input delay?

## References

- Normative: `.plans/trevor-v2/implementation.md`
- Normative: `apps/web/src/App.tsx`
- Normative: `apps/web/src/transcript.ts`
- Normative: `apps/web/src/components/panel/PanelHost.tsx`
- Normative: `apps/web/src/components/chat/prompt-input.tsx`
- Normative: `apps/web/src/session/use-session.ts`
- Informative: TanStack Virtual React docs,
  `https://tanstack.com/virtual/latest/docs/framework/react/react-virtual`
- Informative: TanStack Virtual API docs,
  `https://tanstack.com/virtual/latest/docs/api/virtualizer`
- Informative: TanStack Virtual chat example,
  `https://tanstack.com/virtual/latest/docs/framework/react/examples/chat`

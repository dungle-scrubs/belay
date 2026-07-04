# Ghosted Reasoning Rendering - Progress Report

## Summary

> Current focus: Done - all milestones landed

- Total checklist items: 34
- Completed: 34
- Current cutoff blockers: 0

## 0. Hard Dependencies

- [x] Existing `assistant.thinking` protocol event and transcript reducer path
- [x] Existing `TranscriptRowView` `showThinking` gate
- [x] Existing `ThinkingMessage` component in `apps/web/src/components/chat/message.tsx`
- [x] Existing `MarkdownBody` rendering for reasoning text
- [x] Existing assistant-ui `ReasoningGroup` / disclosure primitives in `apps/web/src/components/assistant-ui/reasoning.tsx`
- [x] Existing `.plans/05-compact-transcript-layout` as the future compact-mode integration boundary

## M1: Component Shape and States

- [x] RED: Add component tests for collapsed, expanded, empty, long, and markdown-rich reasoning content
- [x] GREEN: Replace or wrap `ThinkingMessage` with a ghosted reasoning component using Trevor tokens and assistant-ui reasoning behavior
- [x] RED: Add tests for manual toggle persistence within a mounted message
- [x] GREEN: Keep collapsed state compact and expanded state capped with internal scroll/fade for long content
- [x] RED: Verify copy/source or text selection still works in expanded content
- [x] REFACTOR: Rename local component only if it improves clarity without touching protocol names

## M2: Streaming Behavior

- [x] RED: Add tests/stories for active streaming reasoning with shimmer/active trigger state
- [x] GREEN: Auto-open while reasoning is actively streaming when `showThinking` is enabled
- [x] RED: Add tests for auto-collapse after streaming completes unless the user manually toggled
- [x] GREEN: Preserve manual user choice over automatic streaming state once the user toggles
- [x] RED: Verify reduced-motion disables shimmer/animated distractions
- [x] REFACTOR: Keep streaming state derivation local to transcript rendering, not protocol-breaking

## M3: Transcript Row Wiring

- [x] RED: Extend `transcript-row-view.test.tsx` for `showThinking=true`, `showThinking=false`, streaming, done, interrupted, and error rows
- [x] GREEN: Wire assistant rows to the new reasoning surface while preserving answer text and meta placement
- [x] RED: Verify rows with no answer text still show loading/thinking correctly
- [x] GREEN: Preserve `WorkingIndicator` fallback when no thinking text has arrived
- [x] RED: Verify virtualized row measurement stabilizes when reasoning expands/collapses
- [x] REFACTOR: Avoid duplicating reasoning rendering between "thinking only" and "answer plus thinking" assistant rows

## M4: Storybook Coverage

- [x] RED: Add Storybook states for hidden, collapsed, expanded, streaming, long, markdown-rich, interrupted/error-adjacent, and narrow viewport
- [x] GREEN: Make the visual treatment ghosted/muted while keeping trigger and chevron readable
- [x] RED: Add dark/high-contrast and reduced-motion visual checks
- [x] GREEN: Ensure text does not overlap inside compact row widths or long reasoning lines
- [x] REFACTOR: Keep stories on production components rather than detached demo-only markup

## M5: Compact and Accessibility

- [x] RED: Document compact transcript behavior: reasoning collapses to one line with status/count/active indicator
- [x] GREEN: Add props or view-model affordances needed by plan 27 without implementing compact mode here
- [x] RED: Add accessibility tests for trigger label, expanded region semantics, keyboard toggle, and busy state while streaming
- [x] GREEN: Preserve focus order and Escape behavior expectations from broader shortcut plans
- [x] REFACTOR: Keep the visible label stable as `thinking` unless product copy is deliberately changed everywhere

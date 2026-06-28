# Transcript Mermaid Rendering - Progress Report

## Summary

> Current focus: M1: Fenced-Block Detection

- Total checklist items: 38
- Completed: 5
- Current cutoff blockers: 33

## 0. Hard Dependencies

- [x] Existing `MarkdownBody` chat markdown boundary
- [x] Existing `apps/web/src/markdown.tsx` `marked` plus DOMPurify renderer
- [x] Existing `apps/web/src/components/chat/message.stories.tsx` Storybook message fixtures
- [x] Existing `apps/agent-host/src/providers/system-prompt.ts` centralized prompt guidance
- [x] Existing Lucid/artifact-panel plans as the richer artifact-iteration boundary

## M1: Fenced-Block Detection

- [ ] RED: Add markdown tests for ` ```mermaid ` routing and ordinary fenced code staying a code block
- [ ] GREEN: Add a renderer seam that detects normalized `mermaid` language only
- [ ] RED: Cover case, whitespace, and info-string variants without false positives
- [ ] GREEN: Pass raw Mermaid source into a React-owned component instead of injecting unsanitized SVG directly
- [ ] RED: Verify non-Mermaid code-block copy behavior remains unchanged
- [ ] REFACTOR: Keep markdown parsing and Mermaid rendering responsibilities separate

## M2: Mermaid Component

- [ ] RED: Add component tests for loading, rendered, syntax error, and unavailable-library states
- [ ] GREEN: Render diagrams with a locked config, theme-token colors, and no arbitrary script execution
- [ ] RED: Add tests for source fallback and copy-source control
- [ ] GREEN: Show raw source fallback whenever rendering fails
- [ ] RED: Verify reduced-motion and repeated rerenders do not duplicate SVG nodes
- [ ] REFACTOR: Keep generated IDs deterministic enough for tests without leaking cross-message collisions

## M3: Storybook Coverage

- [ ] RED: Add Storybook states for flowchart, sequence, state/class-style diagram, syntax error, long/wide diagram, and narrow viewport
- [ ] GREEN: Add responsive contained layout with horizontal overflow or zoom controls as needed
- [ ] RED: Add dark theme and high-contrast visual checks
- [ ] GREEN: Map Mermaid colors to Trevor tokens instead of one-off palette values
- [ ] RED: Add streaming/incomplete-message story with skeleton or deferred render
- [ ] REFACTOR: Keep diagram chrome aligned with existing code-block/card surfaces

## M4: Transcript Integration

- [ ] RED: Add message/assistant transcript tests for Mermaid diagrams mixed with prose and code
- [ ] GREEN: Render diagrams in assistant messages without changing user-message markdown behavior unless explicitly reused
- [ ] RED: Verify virtualized transcript row measurement settles after diagram render
- [ ] GREEN: Avoid blocking initial transcript paint by deferring Mermaid rendering
- [ ] REFACTOR: Keep fallback source visible enough for failures and copy/debug needs

## M5: Prompt Guidance

- [ ] RED: Add system-prompt tests proving Mermaid guidance is present on tool and no-tool routes where transcript rendering is available
- [ ] GREEN: Add concise guidance that Mermaid fenced blocks are supported and useful for flows, sequences, state machines, dependencies, and architecture relationships
- [ ] RED: Add tests that the guidance does not mention Lucid as a callable tool unless it is actually available
- [ ] GREEN: Define Mermaid as inline response explanation and Lucid/artifacts as reviewable external iteration surfaces
- [ ] REFACTOR: Keep guidance in the centralized prompt builder rather than duplicating it across providers

## M6: E2E and Regression

- [ ] RED: Add a web test or Storybook interaction that verifies diagram source fallback on invalid input
- [ ] GREEN: Verify valid diagrams render without console errors
- [ ] RED: Add regression coverage for ordinary code copy, tables, links, and GFM still rendering correctly
- [ ] GREEN: Run the web project tests and the relevant system-prompt tests
- [ ] REFACTOR: Document when to prefer Mermaid vs Lucid in plan notes or prompt comments

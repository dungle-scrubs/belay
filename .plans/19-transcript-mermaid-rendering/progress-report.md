# Transcript Mermaid Rendering - Progress Report

## Summary

> Current focus: Complete

- Total checklist items: 38
- Completed: 38
- Current cutoff blockers: 0

## 0. Hard Dependencies

- [x] Existing `MarkdownBody` chat markdown boundary
- [x] Existing `apps/web/src/markdown.tsx` `marked` plus DOMPurify renderer
- [x] Existing `apps/web/src/components/chat/message.stories.tsx` Storybook message fixtures
- [x] Existing `apps/agent-host/src/providers/system-prompt.ts` centralized prompt guidance
- [x] Existing Lucid/artifact-panel plans as the richer artifact-iteration boundary

## M1: Fenced-Block Detection

- [x] RED: Add markdown tests for ` ```mermaid ` routing and ordinary fenced code staying a code block
- [x] GREEN: Add a renderer seam that detects normalized `mermaid` language only
- [x] RED: Cover case, whitespace, and info-string variants without false positives
- [x] GREEN: Pass raw Mermaid source into a React-owned component instead of injecting unsanitized SVG directly
- [x] RED: Verify non-Mermaid code-block copy behavior remains unchanged
- [x] REFACTOR: Keep markdown parsing and Mermaid rendering responsibilities separate

## M2: Mermaid Component

- [x] RED: Add component tests for loading, rendered, syntax error, and unavailable-library states
- [x] GREEN: Render diagrams with a locked config, theme-token colors, and no arbitrary script execution
- [x] RED: Add tests for source fallback and copy-source control
- [x] GREEN: Show raw source fallback whenever rendering fails
- [x] RED: Verify reduced-motion and repeated rerenders do not duplicate SVG nodes
- [x] REFACTOR: Keep generated IDs deterministic enough for tests without leaking cross-message collisions

## M3: Storybook Coverage

- [x] RED: Add Storybook states for flowchart, sequence, state/class-style diagram, syntax error, long/wide diagram, and narrow viewport
- [x] GREEN: Add responsive contained layout with horizontal overflow or zoom controls as needed
- [x] RED: Add dark theme and high-contrast visual checks
- [x] GREEN: Map Mermaid colors to Trevor tokens instead of one-off palette values
- [x] RED: Add streaming/incomplete-message story with skeleton or deferred render
- [x] REFACTOR: Keep diagram chrome aligned with existing code-block/card surfaces

## M4: Transcript Integration

- [x] RED: Add message/assistant transcript tests for Mermaid diagrams mixed with prose and code
- [x] GREEN: Render diagrams in assistant messages without changing user-message markdown behavior unless explicitly reused
- [x] RED: Verify virtualized transcript row measurement settles after diagram render
- [x] GREEN: Avoid blocking initial transcript paint by deferring Mermaid rendering
- [x] REFACTOR: Keep fallback source visible enough for failures and copy/debug needs

## M5: Prompt Guidance

- [x] RED: Add system-prompt tests proving Mermaid guidance is present on tool and no-tool routes where transcript rendering is available
- [x] GREEN: Add concise guidance that Mermaid fenced blocks are supported and useful for flows, sequences, state machines, dependencies, and architecture relationships
- [x] RED: Add tests that the guidance does not mention Lucid as a callable tool unless it is actually available
- [x] GREEN: Define Mermaid as inline response explanation and Lucid/artifacts as reviewable external iteration surfaces
- [x] REFACTOR: Keep guidance in the centralized prompt builder rather than duplicating it across providers

## M6: E2E and Regression

- [x] RED: Add a web test or Storybook interaction that verifies diagram source fallback on invalid input
- [x] GREEN: Verify valid diagrams render without console errors
- [x] RED: Add regression coverage for ordinary code copy, tables, links, and GFM still rendering correctly
- [x] GREEN: Run the web project tests and the relevant system-prompt tests
- [x] REFACTOR: Document when to prefer Mermaid vs Lucid in plan notes or prompt comments

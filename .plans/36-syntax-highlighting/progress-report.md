# Syntax Highlighting - Progress Report

## Summary

> Current focus: M1: Renderer Contract Tests

- Total checklist items: 33
- Completed: 5
- Current cutoff blockers: 28

## 0. Hard Dependencies

- [x] Existing `apps/web/src/markdown.tsx` `marked` plus DOMPurify markdown renderer
- [x] Existing `apps/web/src/markdown.css` code-block structure and SMUI overrides
- [x] Existing `apps/web/src/markdown.test.tsx` coverage for table wrapping, copy buttons, and dedent/copy behavior
- [x] Existing `.plans/19-transcript-mermaid-rendering` language-route contract for fenced `mermaid` blocks
- [x] Existing chat message Storybook fixtures for realistic transcript markdown states

## M1: Renderer Contract Tests

- [ ] RED: Extend markdown tests for `ts`, `tsx`, `bash`, `json`, `diff`, unknown language, no language, and `mermaid` exclusion
- [ ] GREEN: Add language normalization and highlighter routing behind the existing code-block renderer
- [ ] RED: Verify copy button copies the original dedented source for highlighted and non-highlighted blocks
- [ ] GREEN: Keep copy text generation independent from highlighted markup
- [ ] RED: Add a sanitization regression with suspicious code content
- [ ] REFACTOR: Keep dedent/normalize/copy helpers pure and separately testable where useful

## M2: Highlight Engine Integration

- [ ] RED: Add tests or fixtures proving fallback when the highlighter or grammar is unavailable
- [ ] GREEN: Integrate a Shiki-style highlighter or equivalent React-safe token renderer for explicit languages
- [ ] RED: Verify unknown/no-language blocks retain current plain code rendering
- [ ] GREEN: Load only needed grammars/themes where practical
- [ ] RED: Verify highlighted markup uses token classes/styles compatible with DOMPurify or avoids raw HTML entirely
- [ ] REFACTOR: Avoid global highlighter initialization in render paths that can run frequently

## M3: Visual States

- [ ] RED: Add Storybook states for TypeScript, TSX, shell, JSON, diff, unknown, no language, long/wide code, and mixed prose/code
- [ ] GREEN: Apply token colors that work with Trevor/SMUI dark surfaces and muted reasoning surfaces
- [ ] RED: Add narrow viewport and high-contrast stories/checks
- [ ] GREEN: Keep code blocks horizontally scrollable without text overlap or copy-button collision
- [ ] RED: Add dark theme checks for contrast and selection readability
- [ ] REFACTOR: Keep code-block chrome consistent with existing copy button and planned custom scrollbar styling

## M4: Streaming and Performance

- [ ] RED: Add tests/stories for streaming or partial code blocks where highlighting is deferred/skipped
- [ ] GREEN: Do not run expensive tokenization on unstable streaming content if it causes churn
- [ ] RED: Verify very long code blocks do not freeze the transcript or virtualized list
- [ ] GREEN: Cache highlighted output by language and source where appropriate
- [ ] REFACTOR: Keep performance policy local to markdown rendering so tool renderers are unaffected

## M5: Regression Suite

- [ ] RED: Add regression coverage for GFM tables, links, inline code, blockquotes, and code-copy behavior after highlighting
- [ ] GREEN: Keep all existing markdown behavior intact
- [ ] RED: Add tests proving `mermaid` remains routed/fallback-owned by plan 36 behavior
- [ ] GREEN: Document language-route precedence: Mermaid first, syntax highlighter second, plain fallback third
- [ ] REFACTOR: Document future opt-in requirements for tool outputs/diffs before reuse

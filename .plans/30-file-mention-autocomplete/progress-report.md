# File Mention Autocomplete - Progress Report

## Summary

> Current focus: M5: Test and E2E Coverage

- Total checklist items: 37
- Completed: 31
- Current cutoff blockers: 6

## 0. Hard Dependencies

- [x] Existing production composer boundary: `apps/web/src/hooks/use-composer.ts` and `apps/web/src/components/chat/prompt-input.tsx`
- [x] Existing slash-command autocomplete pattern: `useSlashMenu` plus `CommandMenu`
- [x] Existing host workspace root confinement and file-search primitives
- [x] Existing prompt token/ref behavior for visible inline tokens plus structured refs

## M1: Reusable Autocomplete Chrome

- [x] RED: Storybook fixtures for slash menu, file menu, long paths, empty results, and narrow composer widths
- [x] GREEN: Extract or widen the shared menu row/list primitive
- [x] RED: Component tests for active row, focus-preserving mouse pick, long path truncation, and summary metadata
- [x] GREEN: Render file rows with basename emphasis, muted directory path, and stable row height
- [x] REFACTOR: Preserve existing slash command behavior at its public boundary

## M2: Composer Token Detection

- [x] RED: Unit-test active mention parsing across cursor positions, boundaries, emails, multiline prompts, shell lane, and slash lane
- [x] GREEN: Add a pure active-mention parser
- [x] RED: Hook-test ArrowUp/Down, Tab, Enter, Escape, Backspace, and normal typing ownership
- [x] GREEN: Add `useFileMentionMenu` parallel to `useSlashMenu`
- [x] RED: Test coexistence with slash menu, prompt history, image-token deletion, Enter submit, and future Vim mode
- [x] GREEN: Wire the hook into App's composer key path with correct ownership order
- [x] REFACTOR: Keep parsing pure and React-independent

## M3: Workspace-Confined Search

- [x] RED: Host unit tests for confinement, ignore policy, caps, empty query, and path escaping
- [x] GREEN: Add a host-side file-search service using existing workspace primitives
- [x] RED: Ranking tests for basename, path segment, exact prefix, fuzzy subsequence, and tie-break order
- [x] GREEN: Implement lightweight fuzzy scoring without file-content reads
- [x] RED: Protocol/decoder tests for request, response, stale response, and host unavailable cases
- [x] GREEN: Add browser-host file-search request/read-model path
- [x] RED: Debounce and cancellation tests so stale results cannot overwrite newer queries
- [x] REFACTOR: Keep result payloads small and relative-path-only

## M4: Live Composer Integration

- [x] RED: Web tests for loading, stale host, no results, capped results, keyboard pick, mouse pick, and preserving surrounding draft text
- [x] GREEN: Wire live search into `useFileMentionMenu` with debounce and request identity
- [x] RED: Submission tests for visible text plus structured mention metadata alignment
- [x] GREEN: Add mention metadata to composer state or derive selected mentions at submit
- [x] RED: Regression tests that unselected `@foo` remains plain text
- [x] GREEN: Submit selected mention metadata only if this protocol slice is included; otherwise ship visible text first
- [x] REFACTOR: Remove duplicated menu filtering

## M5: Test and E2E Coverage

- [ ] RED: Storybook interaction tests for keyboard navigation and selection
- [ ] GREEN: Visual states for desktop, narrow composer, long paths, dark theme, and reduced motion
- [ ] RED: Integration tests with a temp workspace and fake host search
- [ ] GREEN: Live EZE path: type `@`, fuzzy-find a file, insert it, submit, and verify transcript text
- [ ] RED: Accessibility tests for menu semantics, active descendant, and screen-reader labels
- [ ] REFACTOR: Document that this slice does not automatically read or inject file contents

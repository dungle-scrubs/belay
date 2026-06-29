# Artifact Panel UX - Progress Report

> Current focus: M1: Panel State and Layout Contract

## Summary

- Current cutoff blockers: 35
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `.plans/trevor-v2` D-028 blob-backed artifacts exists before implementation starts

## M1: Panel State and Layout Contract

- [ ] RED: Add state/model tests for selected artifact id, open/closed state, layout mode, width, min/max, and reset behavior
- [ ] GREEN: Define artifact panel state contract and browser-local layout preference
- [ ] RED: Add tests for switching artifacts, closing, reopening, and missing artifact state
- [ ] GREEN: Implement panel state transitions without coupling to a specific viewer
- [ ] REFACTOR: Keep panel state independent from transcript message state

## M2: Storybook Layout Exploration

- [ ] RED: Add Storybook stories for closed, replace-current-panel, push/narrow transcript, partial overlap, and resizable states
- [ ] GREEN: Build panel shell with toolbar, title, resize handle, close control, loading, empty, and error states
- [ ] RED: Add visual tests or Storybook assertions for narrow, desktop, wide desktop, and active composer states
- [ ] GREEN: Pick first production layout mode from reviewed stories and keep alternates as fixtures
- [ ] REFACTOR: Keep layout CSS explicit and container-query driven

## M3: Resize, Focus, and Accessibility

- [ ] RED: Add tests for keyboard focus when opening/closing the panel and returning to transcript/composer
- [ ] GREEN: Implement accessible focus management, close controls, resize semantics, and panel landmarks
- [ ] RED: Add tests for min/max resize, viewport changes, and no text/control overlap
- [ ] GREEN: Implement responsive constraints so transcript and panel remain usable
- [ ] REFACTOR: Make resize handle and toolbar reusable by future right-side surfaces

## M4: Artifact Viewer Registry

- [ ] RED: Add tests for artifact kind/MIME/source metadata mapping to viewer components
- [ ] GREEN: Implement typed artifact viewer registry with unknown-kind fallback
- [ ] RED: Add tests for viewer capabilities: copy, open external, download, inspect metadata, and safe disabled states
- [ ] GREEN: Expose viewer capability metadata through panel toolbar
- [ ] REFACTOR: Keep registry entries data-driven and independent from transcript renderers

## M5: Document, HTML, Image, and Diagnostic Viewers

- [ ] RED: Add Storybook fixtures for generated document, HTML artifact, image, diagnostic/report, unknown, loading, and failed-load states
- [ ] GREEN: Implement initial viewers with safe sizing and scroll behavior
- [ ] RED: Add tests for large documents, wide images, tall reports, missing blobs, and non-renderable content
- [ ] GREEN: Degrade to safe fallback rows with copy/open/download where available
- [ ] REFACTOR: Share metadata, empty, and error chrome across viewers

## M6: Transcript and Command Integration

- [ ] RED: Add tests proving transcript artifact cards and command/tool result artifacts open in the same panel
- [ ] GREEN: Wire artifact open actions from transcript messages, command results, and generated document events
- [ ] RED: Add tests proving panel selection does not mutate transcript, queue, or model-visible history
- [ ] GREEN: Keep artifact viewing browser-local unless artifact content itself is durable
- [ ] REFACTOR: Remove duplicate artifact preview logic where the panel supersedes it

## M7: UX and E2E Verification

- [ ] RED: Add end-to-end or component integration tests for opening an artifact, resizing the panel, switching artifacts, and closing
- [ ] GREEN: Verify selected production layout mode at mobile, desktop, and wide desktop widths
- [ ] RED: Add regression tests for active streaming turn plus open artifact panel
- [ ] GREEN: Ensure transcript, composer, and task/tool status remain usable while panel is open
- [ ] REFACTOR: Document artifact panel API for consumers, including Lucid

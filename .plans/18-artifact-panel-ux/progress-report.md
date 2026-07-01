# Artifact Panel UX - Progress Report

> Current focus: Complete - reusable artifact panel UX current cutoff

## Summary

- Current cutoff blockers: 0
- Deferred follow-up: 1
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `.plans/trevor-v2` D-028 blob-backed artifacts exists before implementation starts
- [x] `09.2-web-browser-test-suite` is complete on `main` before implementation starts

## M1: Panel State and Layout Contract

- [x] RED: Add state/model tests for selected artifact id, open/closed state, layout mode, width, min/max, and reset behavior
- [x] GREEN: Define artifact panel state contract and browser-local layout preference
- [x] RED: Add tests for switching artifacts, closing, reopening, and missing artifact state
- [x] GREEN: Implement panel state transitions without coupling to a specific viewer
- [x] REFACTOR: Keep panel state independent from transcript message state

## M2: Storybook Layout Exploration

- [x] RED: Add Storybook stories for closed, replace-current-panel, push/narrow transcript, partial overlap, and resizable states
- [x] GREEN: Build panel shell with toolbar, title, resize handle, close control, loading, empty, and error states
- [x] RED: Add visual tests or Storybook assertions for narrow, desktop, wide desktop, and active composer states
- [x] GREEN: Pick first production layout mode from reviewed stories and keep alternates as fixtures
- [x] REFACTOR: Keep layout CSS explicit and container-query driven

## M3: Resize, Focus, and Accessibility

- [x] RED: Add tests for keyboard focus when opening/closing the panel and returning to transcript/composer
- [x] GREEN: Implement accessible focus management, close controls, resize semantics, and panel landmarks
- [x] RED: Add tests for min/max resize, viewport changes, and no text/control overlap
- [x] GREEN: Implement responsive constraints so transcript and panel remain usable
- [x] REFACTOR: Make the resize handle and toolbar reusable by future right-side surfaces

## M4: Artifact Viewer Registry

- [x] RED: Add tests for artifact kind/MIME/source metadata mapping to viewer components
- [x] GREEN: Implement typed artifact viewer registry with unknown-kind fallback
- [x] RED: Add tests for viewer capabilities: copy, open external, download, inspect metadata, and safe disabled states
- [x] GREEN: Expose viewer capability metadata through panel toolbar
- [x] REFACTOR: Keep registry entries data-driven and independent from transcript renderers

## M5: Document, HTML, Image, and Diagnostic Viewers

- [x] RED: Add Storybook fixtures for generated document, HTML artifact, image, diagnostic/report, unknown, loading, and failed-load states
- [x] GREEN: Implement initial viewers with safe sizing and scroll behavior
- [x] RED: Add tests for large documents, wide images, tall reports, missing blobs, and non-renderable content
- [x] GREEN: Degrade to safe fallback rows with copy/open/download where available
- [x] REFACTOR: Share metadata, empty, and error chrome across viewers

## M6: Transcript and Command Integration

- [x] RED: Add tests proving transcript artifact cards open in the same panel
- [x] GREEN: Wire artifact open actions from transcript messages through the shared panel route
- [x] RED: Add tests proving panel selection does not mutate transcript, queue, or model-visible history
- [x] GREEN: Keep artifact viewing browser-local unless artifact content itself is durable
- [x] REFACTOR: Remove duplicate artifact preview logic where the panel supersedes it

## M7: UX and E2E Verification

- [x] RED: Add end-to-end or component integration tests for opening an artifact, resizing the panel, switching artifacts, and closing
- [x] GREEN: Verify selected production layout mode at mobile, desktop, and wide desktop widths
- [x] RED: Add regression tests for active streaming turn plus open artifact panel
- [x] GREEN: Ensure transcript, composer, and task/tool status remain usable while panel is open
- [x] REFACTOR: Document artifact panel API for consumers, including Lucid

## Deferred follow-up

- [ ] Command/tool result artifact opening once those message types carry durable `ArtifactRef` values on the protocol. Current Trevor wire events expose `artifacts` only on `user.message`, so the implemented shared `onOpenArtifact` route is ready for future sources without claiming unsupported protocol behavior.

# Tool Detail Takeover - Progress Report

> Current focus: 0. Hard Dependencies

## 0. Hard Dependencies

- [ ] `07-keyboard-shortcuts` - focus guards and Escape ownership.
- [ ] `05-compact-transcript-layout` - compact row/detail eligibility language.
- [x] Existing model chooser transcript-takeover pattern from D-065.
- [x] Existing archive-browser plan pattern in `.plans/04-archive-browser-and-delete`.
- [x] Existing transcript/tool rendering boundary.

## Phase 1: Storybook Detail Shell

### M1: Detail Eligibility Contract

- [ ] RED: Add tests or fixture assertions for detail eligibility on bash, read, write, edit, multi_edit, grep, glob, web search, docs/web fetch, MCP, session recall, shell lane, and unknown tool rows
- [ ] GREEN: Define a `ToolDetailModel` contract with id, source row key, tool name, status, args, result/output, error, timing, stream/progress, artifacts, and redaction metadata where available
- [ ] RED: Add tests proving user prompts and ordinary final assistant responses are not first-cut detail targets
- [ ] GREEN: Implement a pure projection from transcript tool rows/events to generic detail models
- [ ] REFACTOR: Keep detail projection independent from compact row summaries

### M2: Takeover Shell Stories

- [ ] RED: Add Storybook stories for generic detail open, running, completed, error, aborted, empty/unavailable, narrow width, both sidebars visible, and long-output states
- [ ] GREEN: Build the detail takeover shell with top-left back arrow and stable header/status area
- [ ] RED: Add interaction tests for back arrow and Escape returning to chat
- [ ] GREEN: Implement focus return to the source transcript row when closing where possible
- [ ] REFACTOR: Reuse takeover shell patterns only where already clean; do not prematurely force model chooser/archive/detail into one abstraction

### Gate 1->2

- [ ] Storybook shell states are reviewed
- [ ] Escape and back-arrow behavior are covered in component tests
- [ ] Detail view clearly reads as a focused inspection surface, not normal chat

## Phase 2: Tool-Specific Detail Adapters

### M3: Filesystem and Shell Details

- [ ] RED: Add detail adapter tests for bash, read, write, edit, and multi_edit
- [ ] GREEN: Show bash command, cwd, status, streaming output, exit/error state, truncation, and timing when available
- [ ] GREEN: Show read path/range, rendered snippet/full output boundary, and open-in-editor action where available
- [ ] GREEN: Show write/edit/multi_edit file paths, diff/full patch detail, result, and failures
- [ ] REFACTOR: Share file/path/open-in-editor detail primitives across filesystem tools

### M4: Search, Web, Docs, MCP, and Unknown Details

- [ ] RED: Add detail adapter tests for grep, glob, web search, docs/web fetch, MCP, session recall, and unknown tools
- [ ] GREEN: Show search query/pattern, scope, match counts, result groups, truncation, and errors
- [ ] GREEN: Show web/docs request metadata, normalized results, fetch status, citations/URLs, and sanitized errors
- [ ] GREEN: Show MCP server/tool name, args summary, streaming/progress output where available, result, and failure details
- [ ] REFACTOR: Keep unknown-tool fallback useful without requiring tool-specific code

### Gate 2->3

- [ ] Filesystem, shell, search, web/docs, MCP, and unknown detail stories exist
- [ ] Running/streaming fixtures update in place
- [ ] Redaction and truncation indicators are visible where applicable

## Phase 3: Live App Integration

### M5: Open/Close Routing

- [ ] RED: Add app tests for opening detail from regular transcript rows and compact rows
- [ ] GREEN: Add the detail-open action to eligible rows without cluttering non-eligible rows
- [ ] RED: Add tests proving only one transcript takeover is active at a time across model chooser, archive browser, and tool detail
- [ ] GREEN: Route detail takeover through the same center-column takeover slot as other takeover surfaces
- [ ] REFACTOR: Keep source row identity stable so close can restore focus and scroll

### M6: Live Streaming Detail

- [ ] RED: Add tests for a running bash/tool detail view receiving incremental updates
- [ ] GREEN: Wire live session events into the open detail model without requiring transcript re-open
- [ ] RED: Add tests for tool completion, error, abort, and late-arriving updates while detail is open
- [ ] GREEN: Keep detail status/output synchronized with transcript rows
- [ ] REFACTOR: Ensure detail state is derived from session events/read models, not copied stale local snapshots

### Gate 3->4

- [ ] Live detail opens from regular and compact transcript rows
- [ ] Escape/back returns to chat and does not trigger background actions
- [ ] Running tool detail updates live through completion/error/abort

## Phase 4: Validation

### M7: Verification Pass

- [ ] RED: Add hermetic e2e coverage for opening detail on a running fake tool and watching it complete
- [ ] GREEN: Make e2e pass with deterministic fake provider/tool events
- [ ] RED: Add manual EZE checklist for bash, read/write/edit, web/docs, MCP if configured, Escape/back, and narrow-width behavior
- [ ] GREEN: Verify Storybook stories at desktop and narrow widths
- [ ] REFACTOR: Remove any duplicate detail logic from individual transcript row renderers

### Gate 4

- [ ] Unit, web, integration, and hermetic e2e tests pass for tool-detail behavior
- [ ] Storybook detail view review is approved
- [ ] Manual EZE confirms live streaming detail and Escape/back behavior

## Summary

- Current cutoff blockers: 49 unchecked implementation/report items.
- Accepted/deferred follow-up: none.
- Superseded/obsolete checklist debt: none.

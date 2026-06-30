# Compact Transcript Layout - Progress Report

> Current focus: Phase 1, M1 - compact row inventory.

## 0. Hard Dependencies

- [x] Existing transcript projection and rendering boundaries.
- [x] Existing Storybook coverage for chat/tool components.

## Phase 1: Storybook Compact Row Contract

### M1: Compact Row Inventory

- [x] RED: Add fixture coverage for user prompt, final assistant response, thinking-only segment, streaming assistant segment, running tool, completed tool, failed tool, aborted tool, concurrent read batch, shell lane, recovery/status row, image result, and session recall/web search rows
- [x] GREEN: Define a compact display contract with row kind, icon, status, primary label, secondary summary, action slot, progress/loader slot, and detail eligibility
- [x] RED: Add tests proving user prompts and final assistant responses are not compacted by default
- [x] GREEN: Implement pure row classification for compact eligibility
- [x] REFACTOR: Keep compact eligibility separate from durable transcript semantics

### M2: Shared Compact Row Component

- [x] RED: Add Storybook stories for compact row visual states: running, done, error, aborted, expandable/detail-eligible, no-detail, long path, long command, narrow width, and high-density lists
- [x] GREEN: Build the shared one-line compact row chrome
- [x] RED: Add interaction tests for row actions and accessible labels without layout shifts
- [x] GREEN: Implement stable sizing, truncation, loader/progress indicators, and consistent hover/focus styles
- [x] REFACTOR: Move repeated status/icon mapping into one display helper if existing helpers are insufficient

### Gate 1->2

- [ ] Storybook compact row states are reviewed at desktop and narrow widths
- [ ] Long labels and paths do not overflow or resize rows
- [ ] The compact language is consistent across non-primary row types

## Phase 2: Transcript-Level Compact Mode

### M3: Transcript Fixture and Toggle

- [x] RED: Add Storybook stories for full transcript regular mode, compact mode, and live-running compact mode using the same fixture data
- [x] GREEN: Add a transcript-level compact-mode prop that switches eligible rows to compact rendering
- [x] RED: Add tests proving toggling compact mode preserves semantic row keys and does not mutate messages
- [x] GREEN: Update virtualization estimates for compact rows
- [x] REFACTOR: Keep compact mode out of transcript folding and provider history code

### M4: Tool-by-Tool Summaries

- [x] RED: Add compact summary tests for bash, read, write, edit, multi_edit, grep, glob, web search, session recall, docs/web fetch, MCP, and unknown tools
- [x] GREEN: Implement compact summaries incrementally, starting with generic fallback and then high-value tool-specific summaries
- [x] RED: Add tests for running/progress states per supported tool type
- [x] GREEN: Render action/progress indicators appropriate to each tool type
- [x] REFACTOR: Keep tool-specific summary logic near tool renderers or a dedicated display registry, not scattered through `TranscriptRowView`

### Gate 2->3

- [ ] Full transcript Storybook fixture toggles cleanly
- [ ] Compact rows stay one line across supported tool types
- [ ] Running tools update compact status without row-height churn

## Phase 3: Live App Toggle

### M5: Toggle Surface

- [x] RED: Add web tests for toggling compact mode while idle, while streaming assistant text, and while tools are running
- [x] GREEN: Add the compact-layout toggle to the chosen app control surface
- [x] RED: Add tests proving user prompts and final assistant responses remain full rendering in compact mode
- [x] GREEN: Wire compact mode into `PanelHost`/`VirtualTranscript`
- [x] REFACTOR: Keep toggle state local unless a separate decision chooses persistence

### M6: Scroll and Accessibility

- [ ] RED: Add scroll tests for compact toggle at bottom, scrolled up, and during live streaming
- [ ] GREEN: Preserve live-bottom behavior and unseen-message state when compact mode changes row heights
- [ ] RED: Add keyboard/screen-reader tests for compact rows and row actions
- [ ] GREEN: Add accessible names that describe compact row status without verbose transcript duplication
- [ ] REFACTOR: Keep compact row focus targets stable and predictable

### Gate 3

- [ ] Storybook compact transcript review is approved
- [ ] Web tests cover idle, streaming, tool-running, and scroll states
- [ ] Compact mode does not mutate transcript semantics or prompt history

## Summary

- Current cutoff blockers: 39 unchecked implementation/report items.
- Accepted/deferred follow-up: none.
- Superseded/obsolete checklist debt: none.


# Clipboard Write Surface - Progress Report

## Summary

- Current cutoff blockers: 0
- Deferred follow-up: 3
- Superseded checklist debt: 0

## Hard Dependencies

None.

## Current Focus

Blockers

## Current Cutoff Blockers

### Phase 1: Host Clipboard Abstraction

#### M1: Clipboard writer and tool

- [x] RED: Add unit tests for a clipboard writer interface with real and test-capture implementations.
- [x] GREEN: Implement `clipboard_write(text)` over the host clipboard abstraction.
- [x] GREEN: Return bounded metadata such as `{ copied: true, charCount }`.
- [x] RED: Add failure tests for unavailable clipboard command/API.
- [x] GREEN: Return a structured tool error when the host clipboard write fails.
- [x] RED: Add tests proving automated test mode captures text without touching the real clipboard.
- [x] REFACTOR: Keep platform selection behind the abstraction, not in command/model code.
- [x] Clipboard writes are host-owned and plain text only.
- [x] Tests never touch the real system clipboard.
- [x] Failure is visible and structured.

### Phase 2: Bare `/clip`

#### M2: Immediate copy command

- [x] RED: Add command tests for bare `/clip`.
- [x] GREEN: Find the last copyable transcript item in the current session view.
- [x] GREEN: Copy that text through the host clipboard abstraction.
- [x] GREEN: Emit a visible command/result event with bounded preview and char count.
- [x] RED: Add tests for empty history and no copyable item.
- [x] GREEN: Return a clear "nothing to copy" result.
- [x] RED: Add tests proving bare `/clip` does not start a model turn.
- [x] REFACTOR: Share copyable-text extraction with any existing transcript copy behavior if one exists.
- [x] Bare `/clip` is immediate and no-model.
- [x] Empty/no-copyable history is handled cleanly.
- [x] The copied text is exactly the selected transcript text.

### Phase 3: Prompt `/clip <request>`

#### M3: Restricted clipboard-only turn

- [x] RED: Add prompt-routing tests for `/clip <request>`.
- [x] GREEN: Start a restricted model turn with only the clipboard-write surface.
- [x] GREEN: Provide relevant conversation context needed to resolve the clipboard request.
- [x] GREEN: Require the model to call `clipboard_write` with the exact text to copy.
- [x] RED: Add tests proving shell, file mutation, process, MCP, web, docs, and other tools are unavailable.
- [x] GREEN: Return structured refusal/error if the restricted turn tries to use anything except `clipboard_write`.
- [x] RED: Add prompt tests proving the model does not describe shell clipboard commands or ask for `pbcopy`.
- [x] REFACTOR: Keep restricted-turn construction separate from normal model-turn construction.
- [x] `/clip <request>` can select, transform, or compose clipboard text from context.
- [x] It exposes no general tool surface.
- [x] It does not use shell clipboard commands.

### Phase 4: Visibility and Verification

#### M4: Visible result, no extra product surface

- [x] RED: Add transcript rendering tests for clipboard command/tool results.
- [x] GREEN: Show visible command/tool events with bounded previews and counts.
- [x] GREEN: Keep copied content out of persisted special clipboard state.
- [x] RED: Add tests proving no `/doctor` area/check/finding is added.
- [x] RED: Add tests proving no task-panel state is created or updated.
- [x] GREEN: Keep task and doctor surfaces unchanged.
- [ ] DEFERRED Manual EZE: run `/clip`, verify clipboard contains the last copyable transcript item.
- [ ] DEFERRED Manual EZE: run `/clip summarize the last answer for Slack`, verify clipboard contains the transformed text and transcript shows a bounded visible result.
- [x] Clipboard writes are visible as normal command/tool results.
- [x] No `/doctor` or task-panel behavior changes.
- [ ] DEFERRED Manual EZE verifies the clipboard convenience path.

### Verification Checklist

- [x] `clipboard_write` writes exact plain text.
- [x] Test-capture adapter prevents real clipboard writes in automated tests.
- [x] Bare `/clip` copies last copyable transcript item.
- [x] Bare `/clip` starts no model turn.
- [x] `/clip <request>` exposes only `clipboard_write`.
- [x] Restricted clipboard turns cannot call shell, files, process, MCP, web, or docs.
- [x] Model guidance rejects shell clipboard commands.
- [x] No persisted clipboard state is created.
- [x] No `/doctor` integration is added.
- [x] No task-panel relation is added.

## Accepted/Deferred Follow-Up

The three Phase 4 Manual EZE steps are DEFERRED: they need a real system clipboard and an
interactive host run, which the automated suite deliberately never touches (D-009 - tests use the
in-memory CaptureClipboard). Everything they would verify is covered by automated tests of the same
seams (clipboard_write writes exact text, bare `/clip` copies the last copyable item, the restricted
`/clip <request>` turn exposes only clipboard_write, and the visible command/tool result rendering).

- Manual EZE: run `/clip`, verify the real clipboard holds the last copyable transcript item.
- Manual EZE: run `/clip summarize the last answer for Slack`, verify the real clipboard holds the
  transformed text and the transcript shows a bounded visible result.
- Manual EZE verifies the clipboard convenience path end to end against the real clipboard.

## Superseded/Obsolete Checklist Debt

None.

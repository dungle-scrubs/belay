# Clipboard Write Surface - Progress Report

## Summary

- Current cutoff blockers: 53
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

None.

## Current Focus

Blockers

## Current Cutoff Blockers

### Phase 1: Host Clipboard Abstraction

#### M1: Clipboard writer and tool

- [ ] RED: Add unit tests for a clipboard writer interface with real and test-capture implementations.
- [ ] GREEN: Implement `clipboard_write(text)` over the host clipboard abstraction.
- [ ] GREEN: Return bounded metadata such as `{ copied: true, charCount }`.
- [ ] RED: Add failure tests for unavailable clipboard command/API.
- [ ] GREEN: Return a structured tool error when the host clipboard write fails.
- [ ] RED: Add tests proving automated test mode captures text without touching the real clipboard.
- [ ] REFACTOR: Keep platform selection behind the abstraction, not in command/model code.
- [ ] Clipboard writes are host-owned and plain text only.
- [ ] Tests never touch the real system clipboard.
- [ ] Failure is visible and structured.

### Phase 2: Bare `/clip`

#### M2: Immediate copy command

- [ ] RED: Add command tests for bare `/clip`.
- [ ] GREEN: Find the last copyable transcript item in the current session view.
- [ ] GREEN: Copy that text through the host clipboard abstraction.
- [ ] GREEN: Emit a visible command/result event with bounded preview and char count.
- [ ] RED: Add tests for empty history and no copyable item.
- [ ] GREEN: Return a clear "nothing to copy" result.
- [ ] RED: Add tests proving bare `/clip` does not start a model turn.
- [ ] REFACTOR: Share copyable-text extraction with any existing transcript copy behavior if one exists.
- [ ] Bare `/clip` is immediate and no-model.
- [ ] Empty/no-copyable history is handled cleanly.
- [ ] The copied text is exactly the selected transcript text.

### Phase 3: Prompt `/clip <request>`

#### M3: Restricted clipboard-only turn

- [ ] RED: Add prompt-routing tests for `/clip <request>`.
- [ ] GREEN: Start a restricted model turn with only the clipboard-write surface.
- [ ] GREEN: Provide relevant conversation context needed to resolve the clipboard request.
- [ ] GREEN: Require the model to call `clipboard_write` with the exact text to copy.
- [ ] RED: Add tests proving shell, file mutation, process, MCP, web, docs, and other tools are unavailable.
- [ ] GREEN: Return structured refusal/error if the restricted turn tries to use anything except `clipboard_write`.
- [ ] RED: Add prompt tests proving the model does not describe shell clipboard commands or ask for `pbcopy`.
- [ ] REFACTOR: Keep restricted-turn construction separate from normal model-turn construction.
- [ ] `/clip <request>` can select, transform, or compose clipboard text from context.
- [ ] It exposes no general tool surface.
- [ ] It does not use shell clipboard commands.

### Phase 4: Visibility and Verification

#### M4: Visible result, no extra product surface

- [ ] RED: Add transcript rendering tests for clipboard command/tool results.
- [ ] GREEN: Show visible command/tool events with bounded previews and counts.
- [ ] GREEN: Keep copied content out of persisted special clipboard state.
- [ ] RED: Add tests proving no `/doctor` area/check/finding is added.
- [ ] RED: Add tests proving no task-panel state is created or updated.
- [ ] GREEN: Keep task and doctor surfaces unchanged.
- [ ] Manual EZE: run `/clip`, verify clipboard contains the last copyable transcript item.
- [ ] Manual EZE: run `/clip summarize the last answer for Slack`, verify clipboard contains the transformed text and transcript shows a bounded visible result.
- [ ] Clipboard writes are visible as normal command/tool results.
- [ ] No `/doctor` or task-panel behavior changes.
- [ ] Manual EZE verifies the clipboard convenience path.

### Verification Checklist

- [ ] `clipboard_write` writes exact plain text.
- [ ] Test-capture adapter prevents real clipboard writes in automated tests.
- [ ] Bare `/clip` copies last copyable transcript item.
- [ ] Bare `/clip` starts no model turn.
- [ ] `/clip <request>` exposes only `clipboard_write`.
- [ ] Restricted clipboard turns cannot call shell, files, process, MCP, web, or docs.
- [ ] Model guidance rejects shell clipboard commands.
- [ ] No persisted clipboard state is created.
- [ ] No `/doctor` integration is added.
- [ ] No task-panel relation is added.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

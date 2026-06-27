# Clipboard Write Surface - Implementation Plan

## 0. Hard Dependencies

None. <!-- D-001 -->

## 1. Outcome

Add a small plain-text Trevor-to-clipboard surface that saves the user a manual copy step. <!-- D-002 --> This is not a clipboard subsystem, not clipboard read/paste, not persisted state, not `/doctor`, and not task-panel work. <!-- D-003 --><!-- D-004 --><!-- D-005 -->

The useful surface is:

- `clipboard_write` host tool writes exactly supplied plain text to the host system clipboard.
- Bare `/clip` copies the last copyable transcript item without starting a model turn. <!-- D-006 -->
- `/clip <request>` starts a restricted clipboard-only model turn that can select, transform, or compose text from existing conversation context, then calls `clipboard_write`. <!-- D-006 -->

## 2. Boundaries

| Area | Decision |
|---|---|
| Dependencies | No hard dependencies on other plans. <!-- D-001 --> |
| Scope | Plain-text Trevor-to-clipboard convenience only. <!-- D-002 --> |
| Doctor | No `/doctor` integration. <!-- D-003 --> |
| Persistence | No durable state, settings, history, or cache. <!-- D-004 --> |
| Tasks | No task panel creation, update, or relation. <!-- D-005 --> |
| Commands | Bare `/clip` copies last copyable transcript item; `/clip <request>` runs a restricted clipboard-only model turn. <!-- D-006 --> |
| Tool surface | Restricted clipboard turns expose only `clipboard_write` and relevant conversation context. <!-- D-007 --> |
| Shell | Do not use model-requested shell clipboard commands such as `pbcopy`, `clip`, or `wl-copy`. <!-- D-008 --> |
| Tests | Automated tests use a clipboard test-capture adapter, never the real clipboard. <!-- D-009 --> |

## 3. Non-Goals

- No clipboard read.
- No image or rich-text clipboard formats.
- No hidden assistant-output delivery.
- No `/doctor` clipboard health.
- No persisted clipboard history.
- No task-panel status.
- No shell clipboard commands from the model path.
- No general tool access from `/clip <request>`.

## 4. Implementation Sequence

### Phase 1: Host Clipboard Abstraction

**Goal:** Provide one host-owned plain-text clipboard write boundary.

1. RED: Add unit tests for a clipboard writer interface with real and test-capture implementations.
2. GREEN: Implement `clipboard_write(text)` over the host clipboard abstraction. <!-- D-002 -->
3. GREEN: Return bounded metadata such as `{ copied: true, charCount }`.
4. RED: Add failure tests for unavailable clipboard command/API.
5. GREEN: Return a structured tool error when the host clipboard write fails.
6. RED: Add tests proving automated test mode captures text without touching the real clipboard. <!-- D-009 -->
7. REFACTOR: Keep platform selection behind the abstraction, not in command/model code.

**Acceptance:**

- [ ] Clipboard writes are host-owned and plain text only.
- [ ] Tests never touch the real system clipboard.
- [ ] Failure is visible and structured.

### Phase 2: Bare `/clip`

**Goal:** Copy the last copyable transcript item without a model turn.

1. RED: Add command tests for bare `/clip`.
2. GREEN: Find the last copyable transcript item in the current session view.
3. GREEN: Copy that text through the host clipboard abstraction. <!-- D-006 -->
4. GREEN: Emit a visible command/result event with bounded preview and char count.
5. RED: Add tests for empty history and no copyable item.
6. GREEN: Return a clear "nothing to copy" result.
7. RED: Add tests proving bare `/clip` does not start a model turn.
8. REFACTOR: Share copyable-text extraction with any existing transcript copy behavior if one exists.

**Acceptance:**

- [ ] Bare `/clip` is immediate and no-model.
- [ ] Empty/no-copyable history is handled cleanly.
- [ ] The copied text is exactly the selected transcript text.

### Phase 3: Prompt `/clip <request>`

**Goal:** Let the model select, transform, or compose clipboard text from existing context only.

1. RED: Add prompt-routing tests for `/clip <request>`.
2. GREEN: Start a restricted model turn with only the clipboard-write surface. <!-- D-007 -->
3. GREEN: Provide relevant conversation context needed to resolve the clipboard request.
4. GREEN: Require the model to call `clipboard_write` with the exact text to copy. <!-- D-006 -->
5. RED: Add tests proving shell, file mutation, process, MCP, web, docs, and other tools are unavailable. <!-- D-007 -->
6. GREEN: Return structured refusal/error if the restricted turn tries to use anything except `clipboard_write`.
7. RED: Add prompt tests proving the model does not describe shell clipboard commands or ask for `pbcopy`. <!-- D-008 -->
8. REFACTOR: Keep restricted-turn construction separate from normal model-turn construction.

**Acceptance:**

- [ ] `/clip <request>` can select, transform, or compose clipboard text from context.
- [ ] It exposes no general tool surface.
- [ ] It does not use shell clipboard commands.

### Phase 4: Visibility and Verification

**Goal:** Make the external clipboard mutation visible without expanding the feature.

1. RED: Add transcript rendering tests for clipboard command/tool results.
2. GREEN: Show visible command/tool events with bounded previews and counts.
3. GREEN: Keep copied content out of persisted special clipboard state. <!-- D-004 -->
4. RED: Add tests proving no `/doctor` area/check/finding is added. <!-- D-003 -->
5. RED: Add tests proving no task-panel state is created or updated. <!-- D-005 -->
6. GREEN: Keep task and doctor surfaces unchanged.
7. Manual EZE: run `/clip`, verify clipboard contains the last copyable transcript item.
8. Manual EZE: run `/clip summarize the last answer for Slack`, verify clipboard contains the transformed text and transcript shows a bounded visible result.

**Acceptance:**

- [ ] Clipboard writes are visible as normal command/tool results.
- [ ] No `/doctor` or task-panel behavior changes.
- [ ] Manual EZE verifies the clipboard convenience path.

## 5. Verification Checklist

- [ ] `clipboard_write` writes exact plain text.
- [ ] Test-capture adapter prevents real clipboard writes in automated tests. <!-- D-009 -->
- [ ] Bare `/clip` copies last copyable transcript item.
- [ ] Bare `/clip` starts no model turn.
- [ ] `/clip <request>` exposes only `clipboard_write`.
- [ ] Restricted clipboard turns cannot call shell, files, process, MCP, web, or docs. <!-- D-007 -->
- [ ] Model guidance rejects shell clipboard commands. <!-- D-008 -->
- [ ] No persisted clipboard state is created. <!-- D-004 -->
- [ ] No `/doctor` integration is added. <!-- D-003 -->
- [ ] No task-panel relation is added. <!-- D-005 -->

## 6. Progress Accounting

Run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "05-clipboard-write-surface"
```

## 7. Decision Ledger

Canonical decisions are in `.plans/05-clipboard-write-surface/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "05-clipboard-write-surface"
```

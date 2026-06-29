# Large Paste Placeholders - Progress Report

## Summary

- Current focus: M3 - Paste Interception
- Current cutoff blockers: 51
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 19
- Thresholds (D-003): large paste = 20+ lines OR 1500+ chars (DEFAULT_PASTE_THRESHOLDS, configurable).
- Token format (D-001): `[Pasted text #N +M lines]`, M = derived display line count (CRLF/CR normalized, lone trailing newline ignored).

## Current Cutoff Blockers

### Phase 1: Token Contract and Draft Model

#### M1: Token Format and Threshold Policy

- [x] RED: Add shared parser/formatter tests for `[Pasted text #N +M lines]` tokens.
- [x] GREEN: Define token text, parser, and stable numbering for pasted-text tokens.
- [x] RED: Add threshold tests for small paste, boundary paste, large-by-lines paste, and large-by-characters paste.
- [x] GREEN: Add configurable line and character thresholds for tokenizing large plain-text paste.
- [x] RED: Add tests for CRLF, trailing newline, blank lines, and Unicode text.
- [x] GREEN: Preserve exact payload text while deriving display line counts separately.
- [x] REFACTOR: Keep pasted-text token parsing separate from image-token parsing while sharing common token utilities where sensible.

#### M2: Draft Payload Pairing

- [x] RED: Add composer-model tests for inserting one large paste token at the cursor.
- [x] GREEN: Extend the draft model to pair pasted-text tokens with exact payload metadata.
- [x] RED: Add tests for insertion at start, middle, end, and selection replacement.
- [x] GREEN: Insert pasted-text tokens at the current selection while preserving surrounding text.
- [x] RED: Add tests for multiple large paste tokens and mixed image/paste token ordering.
- [x] GREEN: Renumber pasted-text tokens in reading order without disturbing image-token numbering.
- [x] RED: Add atomic delete tests for Backspace, Delete, and selection deletion.
- [x] GREEN: Delete paired payloads whenever their visible token is removed.

### Gate 1 -> 2

- [x] Token parsing and formatting are stable.
- [x] Threshold behavior is explicit and tested.
- [x] Draft state can pair visible tokens with exact paste payloads.
- [x] Token deletion cannot leave orphaned hidden payloads.

### Phase 2: Composer UX and Inspection

#### M3: Paste Interception

- [ ] RED: Add `useComposer.onPaste` tests for large plain text creating a pasted-text token.
- [ ] GREEN: Intercept `clipboardData.getData("text/plain")` when it crosses the large-paste threshold.
- [ ] RED: Add tests proving small text paste falls through as literal text.
- [ ] GREEN: Preserve normal browser paste for small text and non-text cases.
- [ ] RED: Add tests for mixed clipboard content with images/files and text.
- [ ] GREEN: Preserve existing image/file paste behavior while handling large text deterministically.
- [ ] REFACTOR: Keep paste branching readable and independent of upload logic.

#### M4: Token Overlay, Hover, and Actions

- [ ] RED: Add Storybook states for one pasted token, multiple pasted tokens, long surrounding prompt, mobile width, and mixed image/paste tokens.
- [ ] GREEN: Render pasted-text tokens with distinct overlay styling from image tokens.
- [ ] RED: Add hover/focus tests for payload preview capped to a safe height/width.
- [ ] GREEN: Show an inspectable preview with line count, character count, copy action, and remove action.
- [ ] RED: Add tests proving remove action deletes both visible token and hidden payload.
- [ ] GREEN: Wire remove/copy actions to the composer draft model.
- [ ] REFACTOR: Keep token controls accessible without replacing the textarea with a rich editor.

### Gate 2 -> 3

- [ ] Large text paste creates a compact token in the normal chat composer.
- [ ] Small text paste remains literal.
- [ ] Existing image/file paste behavior is unchanged.
- [ ] Users can inspect, copy, and remove the full pasted payload.
- [ ] Shell mode does not hide command text behind paste tokens.

### Phase 3: Submission, Queue, and Transcript

#### M5: Protocol and Provider Projection

- [ ] RED: Add protocol tests for submitted user messages carrying pasted-text token metadata.
- [ ] GREEN: Extend the submitted prompt representation to carry pasted payloads durably.
- [ ] RED: Add provider projection tests proving payloads expand at the token position.
- [ ] GREEN: Expand pasted payloads when building model-facing user content.
- [ ] RED: Add tests proving visible tokens do not leak as the only model-facing content.
- [ ] GREEN: Keep transcript-visible token text while sending full payload content to the provider.
- [ ] RED: Add decode compatibility tests for older messages without pasted payload metadata.
- [ ] REFACTOR: Keep paste expansion separate from image token stripping/projection.

#### M6: Queue, Draft Persistence, and Transcript Rendering

- [ ] RED: Add queued-prompt tests proving pasted payload metadata survives while waiting.
- [ ] GREEN: Preserve pasted-text token text and payload metadata in the send queue.
- [ ] RED: Add hard-steer tests for queued/draft collapse with pasted payloads.
- [ ] GREEN: Preserve pasted payloads through hard steer and draft reset.
- [ ] RED: Add transcript tests for submitted pasted-text tokens with inspect/copy affordances.
- [ ] GREEN: Render transcript paste tokens with expandable/copyable payload detail.
- [ ] REFACTOR: Keep transcript payload inspection safe for very large text.

### Gate 3 -> 4

- [ ] Provider projection receives the exact pasted text at the token position.
- [ ] Queue and hard steer preserve pasted payloads.
- [ ] Transcript displays compact tokens with inspect/copy access.
- [ ] Legacy messages without pasted payload metadata still decode.
- [ ] Image tokens and pasted-text tokens compose cleanly.

### Phase 4: Verification

#### M7: Full Verification

- [ ] RED: Add regression tests for secrets-looking pasted text staying user-inspectable and removable before submit.
- [ ] GREEN: Ensure preview/copy/remove actions work without logging or exposing payloads outside intended state.
- [ ] GREEN: Run composer model tests, hook tests, prompt input tests, queue tests, transcript tests, and provider projection tests.
- [ ] GREEN: Run Storybook review for desktop/mobile token overlay and transcript payload inspection.
- [ ] GREEN: Run lint, typecheck, web tests, host tests, and hermetic e2e where applicable.
- [ ] GREEN: Manual EZE repro: paste a multi-line payload, inspect/copy it, submit, and verify the model receives the full content without flooding the composer.
- [ ] REFACTOR: Record exact verification commands and threshold values in the progress report.

### Done Gate

- [ ] Large paste payloads become compact visible tokens.
- [ ] Full pasted text is preserved exactly and sent intentionally.
- [ ] Users can inspect, copy, and remove the payload.
- [ ] Queue, transcript, and provider projection preserve placement.
- [ ] Full verification passes.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

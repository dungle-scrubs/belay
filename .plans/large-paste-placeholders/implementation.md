# Large Paste Placeholders - Implementation Plan

## Architecture

Plain text paste currently falls through the browser textarea path. `useComposer.onPaste` only intercepts files/images; when the clipboard contains ordinary text, the browser inserts the full payload into the draft. Large paste payloads should instead become compact visible tokens such as `[Pasted text #24 +3 lines]`, with the exact pasted text preserved in draft metadata and expanded intentionally at submission/provider projection time. <!-- D-001 --><!-- D-002 -->

This should follow the existing image-token architecture: visible tokens in the textarea, paired metadata in composer state, atomic token deletion, renumbering by reading order, queue preservation, transcript preservation, and provider projection that reconstructs the model-facing content. <!-- D-004 --><!-- D-005 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Large paste only | Small plain-text pastes remain literal text; thresholds are tested at boundary values. <!-- D-003 --> |
| Exact payload preserved | The full pasted text is stored exactly and expanded at the token position when building the submitted prompt. <!-- D-002 --> |
| Visible token is compact | The textarea receives a token like `[Pasted text #N +M lines]` instead of the whole payload. <!-- D-001 --> |
| Token editing is atomic | Deleting a token removes its paired payload; remaining tokens renumber by reading order. <!-- D-004 --> |
| Workflow preservation | Draft persistence, queued prompts, hard steer, transcript rendering, and provider projection preserve token placement and payloads. <!-- D-005 --> |
| Shell lane excluded first | Prompt shell mode keeps pasted command text literal rather than hiding command bytes behind metadata. <!-- D-006 --> |
| Payload is inspectable | Users can inspect, copy, and remove the full payload before submission and from transcript surfaces. <!-- D-007 --> |

### Boundaries

Owned by this plan:

- composer plain-text paste interception
- pasted-text draft model and token parser
- token overlay styling and inspection UI
- draft persistence and queue preservation for pasted-text metadata
- submitted message/protocol representation
- provider projection that expands pasted text at the token position
- transcript rendering and inspection/copy affordances

Not owned by this plan:

- image paste behavior beyond compatibility with mixed paste events
- file/document attachment behavior
- shell command hidden payload expansion
- server-side paste storage unless the protocol/design needs it for durability
- external clipboard history management

### Current Code Surfaces

- `apps/web/src/hooks/use-composer.ts`: owns `onPaste`, image-token draft state, draft persistence boundary, and file intake.
- `apps/web/src/composer/image-tokens.ts`: useful precedent for token/payload pairing, renumbering, and atomic delete.
- `apps/web/src/composer/image-token-overlay.tsx`: useful precedent for visual token overlay and hover/focus preview.
- `apps/web/src/components/chat/prompt-input.tsx`: textarea and paste callback wiring.
- `apps/web/src/send-queue.ts`, `apps/web/src/transcript.ts`, and `packages/session/src/protocol.ts`: queue, transcript, and durable event boundaries.
- `apps/agent-host/src/agent/history-projection.ts` and provider adapters: model-facing prompt reconstruction.

### Observability

No background runtime observability is needed. Verification should make the hidden payload inspectable through UI tests, transcript tests, and provider-projection tests. Error states should be visible if a pasted payload cannot be preserved or decoded.

## Phases

### Phase 1: Token Contract and Draft Model

**Goal:** Trevor has a typed pasted-text token model with exact payload pairing before live paste interception changes.

**Gate from previous:** none.

#### M1: Token Format and Threshold Policy

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add shared parser/formatter tests for `[Pasted text #N +M lines]` tokens.
  2. GREEN: Define token text, parser, and stable numbering for pasted-text tokens. <!-- D-001 -->
  3. RED: Add threshold tests for small paste, boundary paste, large-by-lines paste, and large-by-characters paste.
  4. GREEN: Add configurable line and character thresholds for tokenizing large plain-text paste. <!-- D-003 -->
  5. RED: Add tests for CRLF, trailing newline, blank lines, and Unicode text.
  6. GREEN: Preserve exact payload text while deriving display line counts separately. <!-- D-002 -->
  7. REFACTOR: Keep pasted-text token parsing separate from image-token parsing while sharing common token utilities where sensible.

#### M2: Draft Payload Pairing

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add composer-model tests for inserting one large paste token at the cursor.
  2. GREEN: Extend the draft model to pair pasted-text tokens with exact payload metadata. <!-- D-002 -->
  3. RED: Add tests for insertion at start, middle, end, and selection replacement.
  4. GREEN: Insert pasted-text tokens at the current selection while preserving surrounding text.
  5. RED: Add tests for multiple large paste tokens and mixed image/paste token ordering.
  6. GREEN: Renumber pasted-text tokens in reading order without disturbing image-token numbering. <!-- D-004 -->
  7. RED: Add atomic delete tests for Backspace, Delete, and selection deletion.
  8. GREEN: Delete paired payloads whenever their visible token is removed. <!-- D-004 -->

### Gate 1 -> 2

- [ ] Token parsing and formatting are stable.
- [ ] Threshold behavior is explicit and tested.
- [ ] Draft state can pair visible tokens with exact paste payloads.
- [ ] Token deletion cannot leave orphaned hidden payloads.

### Phase 2: Composer UX and Inspection

**Goal:** Pasting large text into the normal chat composer creates a compact inspectable token instead of flooding the textarea.

**Gate from previous:** Gate 1 passes.

#### M3: Paste Interception

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add `useComposer.onPaste` tests for large plain text creating a pasted-text token.
  2. GREEN: Intercept `clipboardData.getData("text/plain")` when it crosses the large-paste threshold. <!-- D-001 -->
  3. RED: Add tests proving small text paste falls through as literal text.
  4. GREEN: Preserve normal browser paste for small text and non-text cases. <!-- D-003 -->
  5. RED: Add tests for mixed clipboard content with images/files and text.
  6. GREEN: Preserve existing image/file paste behavior while handling large text deterministically.
  7. REFACTOR: Keep paste branching readable and independent of upload logic.

#### M4: Token Overlay, Hover, and Actions

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook states for one pasted token, multiple pasted tokens, long surrounding prompt, mobile width, and mixed image/paste tokens.
  2. GREEN: Render pasted-text tokens with distinct overlay styling from image tokens.
  3. RED: Add hover/focus tests for payload preview capped to a safe height/width.
  4. GREEN: Show an inspectable preview with line count, character count, copy action, and remove action. <!-- D-007 -->
  5. RED: Add tests proving remove action deletes both visible token and hidden payload.
  6. GREEN: Wire remove/copy actions to the composer draft model.
  7. REFACTOR: Keep token controls accessible without replacing the textarea with a rich editor.

### Gate 2 -> 3

- [ ] Large text paste creates a compact token in the normal chat composer.
- [ ] Small text paste remains literal.
- [ ] Existing image/file paste behavior is unchanged.
- [ ] Users can inspect, copy, and remove the full pasted payload.
- [ ] Shell mode does not hide command text behind paste tokens. <!-- D-006 -->

### Phase 3: Submission, Queue, and Transcript

**Goal:** Large paste placeholders survive every prompt workflow and expand correctly for the model.

**Gate from previous:** Gate 2 passes.

#### M5: Protocol and Provider Projection

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for submitted user messages carrying pasted-text token metadata.
  2. GREEN: Extend the submitted prompt representation to carry pasted payloads durably. <!-- D-005 -->
  3. RED: Add provider projection tests proving payloads expand at the token position.
  4. GREEN: Expand pasted payloads when building model-facing user content. <!-- D-002 -->
  5. RED: Add tests proving visible tokens do not leak as the only model-facing content.
  6. GREEN: Keep transcript-visible token text while sending full payload content to the provider.
  7. RED: Add decode compatibility tests for older messages without pasted payload metadata.
  8. REFACTOR: Keep paste expansion separate from image token stripping/projection.

#### M6: Queue, Draft Persistence, and Transcript Rendering

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add queued-prompt tests proving pasted payload metadata survives while waiting.
  2. GREEN: Preserve pasted-text token text and payload metadata in the send queue. <!-- D-005 -->
  3. RED: Add hard-steer tests for queued/draft collapse with pasted payloads.
  4. GREEN: Preserve pasted payloads through hard steer and draft reset.
  5. RED: Add transcript tests for submitted pasted-text tokens with inspect/copy affordances.
  6. GREEN: Render transcript paste tokens with expandable/copyable payload detail. <!-- D-007 -->
  7. REFACTOR: Keep transcript payload inspection safe for very large text.

### Gate 3 -> 4

- [ ] Provider projection receives the exact pasted text at the token position.
- [ ] Queue and hard steer preserve pasted payloads.
- [ ] Transcript displays compact tokens with inspect/copy access.
- [ ] Legacy messages without pasted payload metadata still decode.
- [ ] Image tokens and pasted-text tokens compose cleanly.

### Phase 4: Verification

**Goal:** The feature is covered by unit, web, Storybook, and EZE testing.

**Gate from previous:** Gate 3 passes.

#### M7: Full Verification

- **Dependencies:** M6
- **Effort:** S
- **Tasks:**
  1. RED: Add regression tests for secrets-looking pasted text staying user-inspectable and removable before submit.
  2. GREEN: Ensure preview/copy/remove actions work without logging or exposing payloads outside intended state.
  3. GREEN: Run composer model tests, hook tests, prompt input tests, queue tests, transcript tests, and provider projection tests.
  4. GREEN: Run Storybook review for desktop/mobile token overlay and transcript payload inspection.
  5. GREEN: Run lint, typecheck, web tests, host tests, and hermetic e2e where applicable.
  6. GREEN: Manual EZE repro: paste a multi-line payload, inspect/copy it, submit, and verify the model receives the full content without flooding the composer.
  7. REFACTOR: Record exact verification commands and threshold values in the progress report.

### Done Gate

- [ ] Large paste payloads become compact visible tokens.
- [ ] Full pasted text is preserved exactly and sent intentionally.
- [ ] Users can inspect, copy, and remove the payload.
- [ ] Queue, transcript, and provider projection preserve placement.
- [ ] Full verification passes.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Hidden payload surprises the user | high | medium | Token preview, copy, remove, line count, character count, and transcript inspection are required. <!-- D-007 --> | implementer |
| Provider receives token text but not payload | high | low | Provider projection tests expand payloads at token positions. <!-- D-002 --> | implementer |
| Payload metadata drifts from edited text | high | medium | Reuse image-token-style sync and atomic deletion semantics. <!-- D-004 --> | implementer |
| Shell command behavior becomes obscured | high | low | Exclude shell lane from hidden paste tokens in the first cut. <!-- D-006 --> | implementer |
| Large payload bloats durable events | medium | medium | Cap inspection output and decide during implementation whether to store payload inline or blob-backed if size requires it. | implementer |
| Mixed image/paste tokens collide | medium | medium | Separate token namespaces and test mixed ordering. | implementer |

## Escape Hatches

1. **If inline event payloads are too large:** store pasted text as a blob-backed text artifact and keep the token metadata as a durable reference.
2. **If placeholder expansion complicates provider projection:** normalize pasted-text expansion before image projection so providers receive ordinary text plus existing image handling.
3. **If shell support becomes necessary later:** create a separate shell-specific plan with explicit expansion preview and confirmation.

## Progress Report Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "large-paste-placeholders"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test -- --project unit
pnpm test -- --project web
pnpm test -- --project integration
pnpm test -- --project e2e
```

## Decisions

Canonical decisions are in `.plans/large-paste-placeholders/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "large-paste-placeholders"
```

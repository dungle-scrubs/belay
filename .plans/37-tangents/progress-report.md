# Tangents - Progress Report

## Summary

- **Current focus:** M1 - Tangent Metadata Contract
- **Completed:** 6 / 66
- **Current cutoff blockers:** 60
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing `QuoteSelectionToolbar` selection capture in `apps/web/src/components/assistant-ui/quote-selection-toolbar.tsx`.
- [x] Existing `data-message-id` transcript message scoping, so a selected quote can be tied to one source message.
- [x] Existing center-column transcript takeover pattern from the model chooser and archive/detail plans.
- [x] Existing session transport boundary in `packages/session` and `apps/web/src/session/use-session.ts`.
- [x] Existing session inventory/read-model filtering, so tangent sessions can be tagged and kept out of normal top-level navigation when appropriate.
- [x] Existing quote-to-composer behavior, used as the adjacent selection-toolbar precedent.
- `02.5-selection-copy-toolbar-reliability` - Tangent must consume the stable selected-text snapshot and edge-aware toolbar behavior instead of depending on live browser selection before M3 starts.

## Current Cutoff Blockers

### Phase 1: Tangent Domain and Metadata

#### M1: Tangent Metadata Contract

- [ ] RED: Add protocol/read-model tests for tangent metadata with parent session id, tangent session id, source message id, selected quote, created time, and optional label.
- [ ] GREEN: Add the minimum typed event or metadata projection needed to mark a session as a tangent.
- [ ] RED: Add tests proving tangent sessions can be filtered separately from normal top-level sessions.
- [ ] GREEN: Add inventory helpers for parent-owned tangent lists and ordinary-session exclusion where appropriate.
- [ ] REFACTOR: Keep tangent metadata separate from archive/delete/title lifecycle markers.

#### M2: Prompt Isolation Contract

- [ ] RED: Add host prompt-assembly tests proving tangent turns do not include parent transcript history.
- [ ] GREEN: Ensure tangent sessions assemble prompts from their own event log plus the explicit seed message only.
- [ ] RED: Add regression tests proving parent session history, tool results, and hidden summaries are not pulled into tangents.
- [ ] GREEN: Add structured diagnostics for tangent prompt assembly that confirm parent exclusion.
- [ ] REFACTOR: Keep fork/subagent prompt logic distinct from tangent prompt logic.

#### Gate 1->2

- [ ] Tangent metadata is durable and queryable.
- [ ] Tangents are not forks in protocol, prompt assembly, or inventory behavior.
- [ ] Parent transcript history is excluded by test.

### Phase 2: Storybook-First Tangent UX

#### M3: Selection Toolbar Tangent Action

- [ ] RED: Add toolbar tests for Tangent appearing only when selection is inside one message.
- [ ] GREEN: Replace the disabled Tangent placeholder with a live callback carrying selected text and source message id.
- [ ] RED: Add tests proving Copy, Quote, and Tangent preserve their separate behaviors.
- [ ] GREEN: Update Storybook to show Copy, Quote, Tangent, disabled/error states, and long selections.
- [ ] REFACTOR: Keep selection capture centralized so Quote and Tangent cannot drift on trimming/scoping rules.

#### M4: Tangent Takeover Shell

- [ ] RED: Add Storybook stories for empty tangent, seeded tangent, active tangent turn, completed tangent, error creating tangent, fold-back available, and narrow width.
- [ ] GREEN: Build the tangent takeover shell with top-left back arrow, source quote context, tangent transcript, and tangent composer.
- [ ] RED: Add interaction tests for back arrow, Escape return where keyboard infrastructure exists, composer focus, and parent transcript non-interaction while takeover is active.
- [ ] GREEN: Route the tangent shell through the same center-column takeover slot as chooser/archive/detail surfaces.
- [ ] REFACTOR: Share takeover chrome only if existing surfaces already have a clean reusable boundary.

#### Gate 2->3

- [ ] Storybook tangent states are reviewed at desktop and narrow widths.
- [ ] Tangent action is active in the selection toolbar.
- [ ] The takeover reads as a separate side conversation, not parent chat.

### Phase 3: Live Tangent Session Flow

#### M5: Create and Open Tangent Sessions

- [ ] RED: Add web/session tests for selecting text, creating a tangent session, and opening the tangent takeover.
- [ ] GREEN: Generate or request a new tangent session id and publish tangent metadata plus the seed prompt.
- [ ] RED: Add tests for creation failure, missing source message, duplicate click, reconnect, and reload.
- [ ] GREEN: Persist enough state to return from tangent to parent and reopen active tangents from the parent session.
- [ ] REFACTOR: Keep tangent navigation state derived from durable session metadata where possible.

#### M6: Tangent Chat Isolation

- [ ] RED: Add integration/e2e tests proving a tangent can send prompts and receive assistant responses without mutating parent transcript context.
- [ ] GREEN: Wire tangent composer to publish into the tangent session, not the parent session.
- [ ] RED: Add tests proving parent send queue, active run, tasks panel, and cancellation state do not bleed into tangent state.
- [ ] GREEN: Render tangent turn activity and errors in the tangent takeover only.
- [ ] REFACTOR: Keep session hooks parameterized by the active displayed session instead of copying parent state.

#### Gate 3->4

- [ ] Highlight -> Tangent creates an isolated tangent session.
- [ ] Tangent chat works live through the existing session transport.
- [ ] Back returns to the parent without changing parent prompt context.

### Phase 4: Discovery and Explicit Fold-Back

#### M7: Parent Tangent Discovery

- [ ] RED: Add read-model tests for listing tangents attached to a parent session.
- [ ] GREEN: Add a parent-session tangent list/entry affordance that does not clutter the ordinary session sidebar.
- [ ] RED: Add tests for multiple tangents from one message, tangents from different messages, deleted/archived parent sessions, and missing tangent sessions.
- [ ] GREEN: Show source quote snippets, recency, status, and open actions for parent-owned tangents.
- [ ] REFACTOR: Keep tangent discovery separate from archive browser and normal resume filtering.

#### M8: Explicit Fold-Back

- [ ] RED: Add tests proving tangent content never reaches the parent unless fold-back is explicitly invoked.
- [ ] GREEN: Add a fold-back action that places a selected tangent summary/message/quote into the parent composer for review.
- [ ] RED: Add tests proving fold-back does not auto-submit and does not inject hidden context.
- [ ] GREEN: Add confirmation/preview language and row-scoped success/error states.
- [ ] REFACTOR: Keep fold-back content visible as user-editable composer text or a visible parent message draft.

#### Gate 4->5

- [ ] Parent sessions can discover their tangent conversations.
- [ ] Fold-back is explicit, visible, and user-reviewable.
- [ ] No hidden tangent context enters parent prompt assembly.

### Phase 5: Full Validation

#### M9: Verification Pass

- [ ] RED: Add hermetic e2e coverage for highlight -> tangent -> tangent chat -> back -> parent unaffected.
- [ ] GREEN: Make the e2e pass with fake provider and deterministic session transport.
- [ ] RED: Add e2e coverage for explicit fold-back to parent composer and cancellation of fold-back.
- [ ] GREEN: Verify Storybook states, keyboard/focus behavior, reload/reconnect, and inventory filtering.
- [ ] REFACTOR: Remove placeholder tangent comments and disabled-state dead code from the toolbar.

#### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass for tangent behavior.
- [ ] Storybook tangent surfaces are reviewed.
- [ ] Manual EZE confirms selection toolbar, takeover, isolation, return, discovery, and explicit fold-back.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

# Tangents - Implementation Plan

## 0. Hard Dependencies

- [x] Existing `QuoteSelectionToolbar` selection capture in `apps/web/src/components/assistant-ui/quote-selection-toolbar.tsx`.
- [x] Existing `data-message-id` transcript message scoping, so a selected quote can be tied to one source message.
- [x] Existing center-column transcript takeover pattern from the model chooser and archive/detail plans.
- [x] Existing session transport boundary in `packages/session` and `apps/web/src/session/use-session.ts`.
- [x] Existing session inventory/read-model filtering, so tangent sessions can be tagged and kept out of normal top-level navigation when appropriate.
- [x] Existing quote-to-composer behavior, used as the adjacent selection-toolbar precedent.
- `02.5-selection-copy-toolbar-reliability` - Tangent must consume the stable selected-text snapshot and edge-aware toolbar behavior instead of depending on live browser selection before M3 starts.

## 1. Architecture

Tangents are related, isolated conversations started from highlighted transcript text. A tangent is not a fork: it does not inherit or replay the parent conversation, and the main agent does not see tangent messages or results unless the user later performs an explicit fold-back action. <!-- D-001 -->

The selected quote is the tangent seed. The tangent session records durable parent metadata such as parent session id, source message id, selected text, and creation time. That metadata is for navigation, attribution, and optional later fold-back. It is not permission to include the parent transcript in the tangent prompt. <!-- D-001 -->

The entry point is the existing selection toolbar. The disabled Tangent button becomes active beside Copy and Quote. Clicking it creates or opens a tangent session and replaces the main transcript/composer area with a tangent conversation surface using the same takeover shape as the model chooser, archive browser, and tool detail view: top-left back arrow, no modal overlay, no drawer, and Escape returns to the parent chat when the frontmost-surface keyboard plan is available. <!-- D-002 -->

Fold-back is explicit and visible. By default, tangent output feeds nothing into the parent session. A later fold-back action can send a chosen tangent summary, quote, or selected message back to the parent composer for review before submission. It must not silently inject hidden context into the parent agent. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Not a fork | Do not replay parent history into the tangent prompt. Store parent metadata only. |
| Selected quote seed | Tangent starts from the highlighted text and source message metadata. |
| Transcript takeover | Tangent replaces the center chat area with a back arrow, matching existing takeover patterns. |
| Main agent isolation | Parent session receives no tangent content unless the user explicitly folds it back. |
| Storybook first | Selection toolbar and tangent takeover states are reviewed before live wiring. |
| Inventory clarity | Tangent sessions are tagged as tangents and should not clutter ordinary top-level session lists. |
| Explicit fold-back | Fold-back requires a visible user action and preview path. |

### Boundaries

- `apps/web` owns the selection-toolbar Tangent action, tangent takeover shell, parent/back navigation, composer focus, Storybook states, and fold-back preview UX.
- `packages/session` owns typed tangent metadata on session summaries/events if the current protocol cannot represent it cleanly.
- `apps/session-store` and Richter/session inventory own durable storage and read-model projection for tangent parent metadata.
- `apps/agent-host` owns prompt-history behavior for tangent sessions: tangent turns use the tangent session log only, not the parent log.
- The parent transcript renderer owns only the source message id and selected quote. It does not own tangent session lifecycle.

### Observability

Tangents should be inspectable without leaking parent content:

- tangent creation logs include parent session id, tangent session id, source message id, quote length, and creation result;
- tangent prompt assembly logs prove whether parent history was excluded;
- fold-back logs include parent session id, tangent session id, selected fold-back mode, and whether content was only placed into the composer or actually submitted;
- failures distinguish selection missing, source message missing, session creation failure, transport failure, and fold-back rejection.

## 2. Current State

The repo already has a selection toolbar with Copy, Quote, and a disabled Tangent button. The toolbar scopes a selection to one message using `data-message-id`, which is the right source boundary for tangent creation.

`PanelHost` already renders a center-column takeover slot for the model chooser. Archive and tool-detail plans standardize the same takeover interaction: replace the transcript/prompt area, keep surrounding shell context, and return with a top-left back arrow.

The session boundary already supports durable session creation, event publishing, archive/delete metadata, and inventory projections. Tangents need an additional metadata/read-model layer, not a new transport.

## 3. Phases

### Phase 1: Tangent Domain and Metadata

**Goal:** Tangents have a clear durable identity and cannot be confused with forks.

**Gate from previous:** Existing session creation and inventory flow are understood.

#### M1: Tangent Metadata Contract

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/read-model tests for tangent metadata with parent session id, tangent session id, source message id, selected quote, created time, and optional label.
  2. GREEN: Add the minimum typed event or metadata projection needed to mark a session as a tangent.
  3. RED: Add tests proving tangent sessions can be filtered separately from normal top-level sessions.
  4. GREEN: Add inventory helpers for parent-owned tangent lists and ordinary-session exclusion where appropriate.
  5. REFACTOR: Keep tangent metadata separate from archive/delete/title lifecycle markers.

#### M2: Prompt Isolation Contract

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add host prompt-assembly tests proving tangent turns do not include parent transcript history.
  2. GREEN: Ensure tangent sessions assemble prompts from their own event log plus the explicit seed message only.
  3. RED: Add regression tests proving parent session history, tool results, and hidden summaries are not pulled into tangents.
  4. GREEN: Add structured diagnostics for tangent prompt assembly that confirm parent exclusion.
  5. REFACTOR: Keep fork/subagent prompt logic distinct from tangent prompt logic.

### Gate 1->2

- [ ] Tangent metadata is durable and queryable.
- [ ] Tangents are not forks in protocol, prompt assembly, or inventory behavior.
- [ ] Parent transcript history is excluded by test.

### Phase 2: Storybook-First Tangent UX

**Goal:** Selection entry and takeover behavior are reviewable before live wiring.

**Gate from previous:** Tangent metadata contract is defined.

#### M3: Selection Toolbar Tangent Action

- **Dependencies:** M1, `02.5-selection-copy-toolbar-reliability`
- **Effort:** S
- **Tasks:**
  1. RED: Add toolbar tests for Tangent appearing only when selection is inside one message.
  2. GREEN: Replace the disabled Tangent placeholder with a live callback carrying selected text and source message id.
  3. RED: Add tests proving Copy, Quote, and Tangent preserve their separate behaviors.
  4. GREEN: Update Storybook to show Copy, Quote, Tangent, disabled/error states, and long selections.
  5. REFACTOR: Keep selection capture centralized so Quote and Tangent cannot drift on trimming/scoping rules.

#### M4: Tangent Takeover Shell

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for empty tangent, seeded tangent, active tangent turn, completed tangent, error creating tangent, fold-back available, and narrow width.
  2. GREEN: Build the tangent takeover shell with top-left back arrow, source quote context, tangent transcript, and tangent composer.
  3. RED: Add interaction tests for back arrow, Escape return where keyboard infrastructure exists, composer focus, and parent transcript non-interaction while takeover is active.
  4. GREEN: Route the tangent shell through the same center-column takeover slot as chooser/archive/detail surfaces.
  5. REFACTOR: Share takeover chrome only if existing surfaces already have a clean reusable boundary.

### Gate 2->3

- [ ] Storybook tangent states are reviewed at desktop and narrow widths.
- [ ] Tangent action is active in the selection toolbar.
- [ ] The takeover reads as a separate side conversation, not parent chat.

### Phase 3: Live Tangent Session Flow

**Goal:** Users can start, chat in, and return from an isolated tangent.

**Gate from previous:** Storybook entry and takeover shell are approved.

#### M5: Create and Open Tangent Sessions

- **Dependencies:** M2, M4
- **Effort:** L
- **Tasks:**
  1. RED: Add web/session tests for selecting text, creating a tangent session, and opening the tangent takeover.
  2. GREEN: Generate or request a new tangent session id and publish tangent metadata plus the seed prompt.
  3. RED: Add tests for creation failure, missing source message, duplicate click, reconnect, and reload.
  4. GREEN: Persist enough state to return from tangent to parent and reopen active tangents from the parent session.
  5. REFACTOR: Keep tangent navigation state derived from durable session metadata where possible.

#### M6: Tangent Chat Isolation

- **Dependencies:** M5
- **Effort:** L
- **Tasks:**
  1. RED: Add integration/e2e tests proving a tangent can send prompts and receive assistant responses without mutating parent transcript context.
  2. GREEN: Wire tangent composer to publish into the tangent session, not the parent session.
  3. RED: Add tests proving parent send queue, active run, tasks panel, and cancellation state do not bleed into tangent state.
  4. GREEN: Render tangent turn activity and errors in the tangent takeover only.
  5. REFACTOR: Keep session hooks parameterized by the active displayed session instead of copying parent state.

### Gate 3->4

- [ ] Highlight -> Tangent creates an isolated tangent session.
- [ ] Tangent chat works live through the existing session transport.
- [ ] Back returns to the parent without changing parent prompt context.

### Phase 4: Discovery and Explicit Fold-Back

**Goal:** Tangents can be found from their parent and optionally folded back with user review.

**Gate from previous:** Live isolated tangent flow works.

#### M7: Parent Tangent Discovery

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add read-model tests for listing tangents attached to a parent session.
  2. GREEN: Add a parent-session tangent list/entry affordance that does not clutter the ordinary session sidebar.
  3. RED: Add tests for multiple tangents from one message, tangents from different messages, deleted/archived parent sessions, and missing tangent sessions.
  4. GREEN: Show source quote snippets, recency, status, and open actions for parent-owned tangents.
  5. REFACTOR: Keep tangent discovery separate from archive browser and normal resume filtering.

#### M8: Explicit Fold-Back

- **Dependencies:** M6, M7
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving tangent content never reaches the parent unless fold-back is explicitly invoked.
  2. GREEN: Add a fold-back action that places a selected tangent summary/message/quote into the parent composer for review.
  3. RED: Add tests proving fold-back does not auto-submit and does not inject hidden context.
  4. GREEN: Add confirmation/preview language and row-scoped success/error states.
  5. REFACTOR: Keep fold-back content visible as user-editable composer text or a visible parent message draft.

### Gate 4->5

- [ ] Parent sessions can discover their tangent conversations.
- [ ] Fold-back is explicit, visible, and user-reviewable.
- [ ] No hidden tangent context enters parent prompt assembly.

### Phase 5: Full Validation

**Goal:** Tangents are covered across Storybook, unit, integration, and hermetic e2e behavior.

**Gate from previous:** Discovery and fold-back are wired.

#### M9: Verification Pass

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for highlight -> tangent -> tangent chat -> back -> parent unaffected.
  2. GREEN: Make the e2e pass with fake provider and deterministic session transport.
  3. RED: Add e2e coverage for explicit fold-back to parent composer and cancellation of fold-back.
  4. GREEN: Verify Storybook states, keyboard/focus behavior, reload/reconnect, and inventory filtering.
  5. REFACTOR: Remove placeholder tangent comments and disabled-state dead code from the toolbar.

### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass for tangent behavior.
- [ ] Storybook tangent surfaces are reviewed.
- [ ] Manual EZE confirms selection toolbar, takeover, isolation, return, discovery, and explicit fold-back.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Tangents accidentally become forks | high | medium | Add prompt-assembly tests proving parent history exclusion and keep fork logic separate. | Host/Session |
| Parent agent gets tangent content silently | high | medium | Fold-back only writes visible composer content and never hidden prompt context. | Web/Host |
| Tangent sessions clutter normal navigation | medium | medium | Tag tangents and project separate parent-owned tangent lists from ordinary session lists. | Session/Web |
| Takeover surfaces conflict | medium | medium | Use a single center-column takeover slot and test chooser/archive/detail/tangent exclusivity. | Web |
| Selection source metadata is brittle | medium | medium | Scope to one `data-message-id`; reject cross-message selections and missing source messages. | Web |

## 5. Escape Hatches

1. **If durable tangent metadata is not ready:** keep the toolbar Tangent action Storybook-only and do not ship live creation.
2. **If center takeover state gets crowded:** add a typed takeover router before wiring tangent live, but keep the user-facing behavior unchanged.
3. **If fold-back semantics need more design:** ship isolated tangents and parent discovery first; leave fold-back disabled until the preview/confirmation path is approved.
4. **If tangent inventory filtering is uncertain:** show tangents only from the parent session and omit them from global sidebar/resume until the read-model contract is settled.

## 6. Progress Report Accounting

The progress report is `.plans/37-tangents/progress-report.md`. It tracks only tangent conversations: selection-toolbar activation, isolated tangent sessions, tangent takeover UX, parent-owned tangent discovery, and explicit fold-back. It does not track forks, background subagents, archive browser, model chooser, or tool-detail takeover except as dependencies and UX precedents.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "37-tangents"
```

## 7. Validation Commands

```bash
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web test -- quote-selection-toolbar
pnpm --filter @trevor/web test -- panel
pnpm --filter @trevor/session test
pnpm --filter @trevor/agent-host test
pnpm test -- --project e2e
pnpm typecheck
pnpm biome check
```

## 8. Decisions

Canonical decisions are in `.plans/37-tangents/plan.db`.

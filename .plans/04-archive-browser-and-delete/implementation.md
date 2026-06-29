# Archive Browser and Permanent Delete - Implementation Plan

## 0. Hard Dependencies

- [x] Existing archive metadata lifecycle from D-094 - archived sessions are durable metadata, hidden from normal sidebar/resume views, retained in Richter/session storage, and require unarchive before normal use.
- [x] Existing full model chooser transcript-takeover pattern from D-065 - the chooser replaces the transcript and prompt area, keeps sidebars visible, and uses a top-left back arrow to return to chat.
- [x] Existing Storybook setup in `apps/web` - visual states can be reviewed before live app wiring.

## 1. Architecture

The archive browser is a Storybook-first transcript-takeover surface for archived sessions. It follows the full model chooser UX: opening the archive area replaces the chat transcript and prompt area, leaves the surrounding shell/sidebars available where layout allows, and provides a top-left back arrow to return to chat. It is not a modal, overlay, drawer, or ordinary sidebar row action.

The surface must make the archive context unmistakable. The header, empty state, row metadata, and destructive confirmation all label the area as archived-session management. Normal chat controls stay unavailable while this takeover is open, because this is a management surface, not an active conversation surface.

Archive remains metadata hiding. Unarchive clears the archived flag and returns the session to normal navigation. Permanent delete is a separate strong-confirmation action available only from this archive area. It must not be exposed as an ordinary normal-sidebar action.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Storybook first | Build the visual/read-model contract and review states before live app wiring. |
| Transcript takeover | The browser replaces the transcript/prompt area like `ModelChooser`, with a top-left back arrow. |
| Archive area clarity | Every state must clearly communicate that archived sessions are being managed. |
| Unarchive before normal use | Opening or using an archived session still requires unarchive. |
| Permanent delete is strong-confirmation only | No one-click destructive delete; require explicit confirmation from the archive area. |
| Existing soft-delete event is not hard purge | Current `session.deleted` hides rows; this plan must define the permanent-delete storage operation separately. |

### Boundaries

- `apps/web` owns the Storybook-first archive browser component, transcript-takeover integration, focus behavior, and confirmation UI.
- `packages/session` owns any protocol/read-model additions needed to enumerate archived sessions and express permanent deletion results.
- `apps/session-store` and Richter integration own durable deletion semantics. Permanent delete must remove or tombstone storage consistently enough that deleted sessions do not reappear after reload or reconnect.
- `apps/trevor-cli` may expose parity only if the underlying permanent-delete operation becomes shared. The first UI scope does not require a new CLI command unless the implementation needs a reusable host/store command boundary.

### Observability

Archive browser actions should produce debuggable lifecycle events or structured command results:

- `unarchive` success/failure includes `sessionId`, previous archive state, and failure class.
- permanent-delete attempt/result includes `sessionId`, confirmation mode, storage backend, and failure class, without leaking transcript content.
- UI-visible errors distinguish "already unarchived", "not found", "active/protected", "delete failed", and "permission/confirmation missing".

## 2. Current State

The repo already has archive metadata and filtering. `archiveSession(sessionId, archived)` publishes `session.archived`, archived sessions are excluded from default resume rows, and archived sessions can be restored through the existing `unarchive` action. The durable log is retained.

The repo also has a soft delete helper, `deleteSession(sessionId, deleted)`, which sets `session.deleted` and hides a session from views while retaining the durable log. That is not the permanent-delete operation in this plan.

The model chooser already demonstrates the target layout pattern: a Storybook-first surface that takes over the transcript and prompt area while sidebars remain visible.

## 3. Phases

### Phase 1: Storybook Archive Browser Contract

**Goal:** The archive browser can be reviewed visually before any live session-store wiring.

**Gate from previous:** Existing archive metadata/read models are understood and fixtures can represent archived sessions.

#### M1: Read Model and Fixtures

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add tests or fixture assertions for an `ArchivedSessionRow` read model with title, cwd/project, last activity, event count or summary metadata, active/protected flags, and deletion eligibility.
  2. GREEN: Define shared Storybook fixtures for archived rows, empty state, active/protected rows, stale/not-found rows, and long labels.
  3. RED: Add tests proving non-archived sessions are excluded from archive-browser rows.
  4. GREEN: Implement the pure projection that derives archive-browser rows from session inventory.
  5. REFACTOR: Keep archive-browser display projection separate from default sidebar/resume projection.

#### M2: Storybook Takeover Surface

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for archive overview, empty archive, loading, error, narrow width, both sidebars visible, long labels, many rows, protected row, and delete-confirmation states.
  2. GREEN: Build the presentational archive browser as a transcript-takeover surface matching the model chooser pattern.
  3. GREEN: Add the top-left back arrow, archive-area title, explanatory row labels, search/filter controls if needed, and stable row/action layouts.
  4. RED: Add interaction tests for back, row focus, unarchive action, delete confirmation open/cancel/confirm, and keyboard navigation.
  5. REFACTOR: Share only generic takeover/chrome patterns where they already exist cleanly; do not create a broad abstraction before the archive browser and model chooser prove the same shape.

### Gate 1->2

- [ ] Storybook archive browser states are reviewed at desktop and narrow widths.
- [ ] The archive area is visually unmistakable and cannot be mistaken for normal chat.
- [ ] Back arrow returns to chat without mutating session state.

### Phase 2: Archive Actions and Confirmation Semantics

**Goal:** Unarchive and permanent-delete behavior are precise, testable, and safe before live UI wiring.

**Gate from previous:** Storybook surface approved.

#### M3: Unarchive Flow

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add tests proving unarchive clears the archive flag and removes the row from archive-browser results.
  2. GREEN: Wire archive-browser unarchive action to the existing `session.archived({ archived: false })` path.
  3. RED: Add tests for unarchive failure, already-unarchived race, and not-found session.
  4. GREEN: Render action-local success/failure state without adding transcript messages.
  5. REFACTOR: Keep unarchive action code shared with existing archive lifecycle helpers.

#### M4: Permanent Delete Domain Contract

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/store tests that define what permanent delete means for session inventory, event replay, blobs/artifacts if applicable, and reconnect behavior.
  2. GREEN: Add the minimum host/store command boundary needed to permanently delete an archived session.
  3. RED: Add tests proving permanent delete is rejected for non-archived, active/protected, missing-confirmation, and currently-running sessions.
  4. GREEN: Implement typed failure results for delete rejection and backend failures.
  5. REFACTOR: Keep permanent delete separate from the existing `session.deleted` soft-delete marker.

#### M5: Strong Confirmation UX

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook interaction tests for typed confirmation and cancel paths.
  2. GREEN: Require a deliberate confirmation gesture that includes the session title or a stable delete phrase.
  3. RED: Add tests proving Enter/click cannot confirm while the confirmation input is incomplete.
  4. GREEN: Show delete progress, success removal, and typed error states inline in the archive area.
  5. REFACTOR: Ensure destructive focus handling cannot leak keystrokes to chat, composer, or background surfaces.

### Gate 2->3

- [ ] Delete contract tests pass against the local session-store path.
- [ ] Permanent delete cannot run from normal sidebar/resume/chat surfaces.
- [ ] Confirmation UI is verified in Storybook and cannot submit accidentally.

### Phase 3: Live App Wiring

**Goal:** The archive browser opens from the app shell, replaces the transcript, and safely manages archived sessions.

**Gate from previous:** Storybook and domain contract gates pass.

#### M6: Entry Point and Takeover Routing

- **Dependencies:** M3, M5
- **Effort:** M
- **Tasks:**
  1. RED: Add app-state tests for opening the archive browser and returning to chat through the back arrow.
  2. GREEN: Add the archive browser entry point from the appropriate session/navigation management surface.
  3. RED: Add tests proving the transcript and composer are not interactive while the archive browser takeover is active.
  4. GREEN: Route the live archive read model into the archive browser.
  5. REFACTOR: Keep takeover state compatible with the existing model chooser takeover behavior.

#### M7: Live Action Wiring

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for unarchive removing a row and restoring normal navigation eligibility.
  2. GREEN: Wire live unarchive from the archive browser.
  3. RED: Add web tests for permanent-delete success, rejection, and backend error rendering.
  4. GREEN: Wire live permanent-delete command and result handling.
  5. REFACTOR: Keep action state row-scoped so deleting/unarchiving one row does not blank the whole browser.

### Gate 3->4

- [ ] Archive browser opens and closes from the live app.
- [ ] Unarchive works live and restores the session to normal navigation.
- [ ] Permanent delete works live only after strong confirmation.

### Phase 4: Full Validation

**Goal:** The feature is covered from pure projection through Storybook and live end-to-end behavior.

**Gate from previous:** Live app wiring complete.

#### M8: Verification Pass

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for archived-session discovery, unarchive, and permanent-delete rejection cases.
  2. GREEN: Make e2e pass against local services with fake provider where needed.
  3. RED: Add manual EZE checklist for archive browser visual review and live archive/unarchive/delete flow.
  4. GREEN: Verify Storybook states at desktop and narrow widths.
  5. REFACTOR: Remove stale debug-only affordances if the archive browser supersedes them for ordinary archive management.

### Gate 4

- [ ] Unit, web, integration, and hermetic e2e tests pass for archive-browser behavior.
- [ ] Storybook archive browser review is approved.
- [ ] Manual EZE confirms archived area clarity, back-to-chat behavior, unarchive, and permanent delete.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Permanent delete semantics differ between session-store and Richter | high | medium | Define contract tests before UI wiring; reject hard delete on unsupported backends until implemented. | Host/Store |
| Archive browser feels like normal chat | medium | medium | Use explicit archive title, empty state, row labels, and destructive confirmation copy; Storybook review gate. | Web |
| Delete accidentally affects active or wrong session | high | low | Require archived-only eligibility, row-scoped action state, stable session ids, and strong confirmation. | Web/Host |
| Takeover routing conflicts with model chooser | medium | medium | Reuse the same app-level takeover slot and test switching/closing behavior. | Web |
| Soft delete and permanent delete get conflated | high | medium | Name the permanent-delete command/result distinctly and test that `session.deleted` is not treated as purge. | Host/Session |

## 5. Escape Hatches

1. **If permanent delete cannot be implemented safely across storage backends:** ship archive browser with unarchive only and render delete as unavailable with a clear disabled reason until the store contract lands.
2. **If the takeover slot conflicts with the model chooser:** keep only one active takeover at a time and make opening archive browser close chooser state, then record the broader reusable takeover-slot cleanup separately.
3. **If delete confirmation UX fails review:** keep permanent delete CLI/store-only behind an explicit feature flag until the archive-area confirmation is approved.

## 6. Progress Report Accounting

The progress report is `.plans/04-archive-browser-and-delete/progress-report.md`. It tracks only the archive browser, unarchive-from-archive-area, and permanent-delete flow. Existing D-094 archive metadata, debug slash commands, CLI archive/unarchive, and normal sidebar filtering are completed prior work and are dependencies, not checklist items in this plan.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "04-archive-browser-and-delete"
```

## 7. Validation Commands

```bash
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web test -- archive-browser
pnpm --filter @trevor/session test
pnpm --filter @trevor/session-store test
pnpm test -- --project e2e
pnpm typecheck
pnpm biome check
```

## 8. Decisions

Canonical decisions are in `.plans/04-archive-browser-and-delete/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "04-archive-browser-and-delete"
```


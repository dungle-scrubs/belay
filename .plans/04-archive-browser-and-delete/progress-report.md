# Archive Browser and Permanent Delete - Progress Report

> Current focus: Phase 1, M1 - read model and fixtures.

## 0. Hard Dependencies

- [x] Existing archive metadata lifecycle from D-094.
- [x] Existing full model chooser transcript-takeover pattern from D-065.
- [x] Existing Storybook setup in `apps/web`.

## Phase 1: Storybook Archive Browser Contract

### M1: Read Model and Fixtures

- [x] RED: Add tests or fixture assertions for an `ArchivedSessionRow` read model with title, cwd/project, last activity, event count or summary metadata, active/protected flags, and deletion eligibility
- [x] GREEN: Define shared Storybook fixtures for archived rows, empty state, active/protected rows, stale/not-found rows, and long labels
- [x] RED: Add tests proving non-archived sessions are excluded from archive-browser rows
- [x] GREEN: Implement the pure projection that derives archive-browser rows from session inventory
- [x] REFACTOR: Keep archive-browser display projection separate from default sidebar/resume projection

### M2: Storybook Takeover Surface

- [x] RED: Add Storybook stories for archive overview, empty archive, loading, error, narrow width, both sidebars visible, long labels, many rows, protected row, and delete-confirmation states
- [x] GREEN: Build the presentational archive browser as a transcript-takeover surface matching the model chooser pattern
- [x] GREEN: Add the top-left back arrow, archive-area title, explanatory row labels, search/filter controls if needed, and stable row/action layouts
- [x] RED: Add interaction tests for back, row focus, unarchive action, delete confirmation open/cancel/confirm, and keyboard navigation
- [x] REFACTOR: Share only generic takeover/chrome patterns where they already exist cleanly; do not create a broad abstraction before the archive browser and model chooser prove the same shape

### Gate 1->2

- [ ] Storybook archive browser states are reviewed at desktop and narrow widths
- [ ] The archive area is visually unmistakable and cannot be mistaken for normal chat
- [ ] Back arrow returns to chat without mutating session state

## Phase 2: Archive Actions and Confirmation Semantics

### M3: Unarchive Flow

- [x] RED: Add tests proving unarchive clears the archive flag and removes the row from archive-browser results
- [x] GREEN: Wire archive-browser unarchive action to the existing `session.archived({ archived: false })` path
- [x] RED: Add tests for unarchive failure, already-unarchived race, and not-found session
- [x] GREEN: Render action-local success/failure state without adding transcript messages
- [x] REFACTOR: Keep unarchive action code shared with existing archive lifecycle helpers

### M4: Permanent Delete Domain Contract

- [x] RED: Add protocol/store tests that define what permanent delete means for session inventory, event replay, blobs/artifacts if applicable, and reconnect behavior
- [x] GREEN: Add the minimum host/store command boundary needed to permanently delete an archived session
- [x] RED: Add tests proving permanent delete is rejected for non-archived, active/protected, missing-confirmation, and currently-running sessions
- [x] GREEN: Implement typed failure results for delete rejection and backend failures
- [x] REFACTOR: Keep permanent delete separate from the existing `session.deleted` soft-delete marker

### M5: Strong Confirmation UX

- [x] RED: Add Storybook interaction tests for typed confirmation and cancel paths
- [x] GREEN: Require a deliberate confirmation gesture that includes the session title or a stable delete phrase
- [x] RED: Add tests proving Enter/click cannot confirm while the confirmation input is incomplete
- [x] GREEN: Show delete progress, success removal, and typed error states inline in the archive area
- [x] REFACTOR: Ensure destructive focus handling cannot leak keystrokes to chat, composer, or background surfaces

### Gate 2->3

- [ ] Delete contract tests pass against the local session-store path
- [ ] Permanent delete cannot run from normal sidebar/resume/chat surfaces
- [ ] Confirmation UI is verified in Storybook and cannot submit accidentally

## Phase 3: Live App Wiring

### M6: Entry Point and Takeover Routing

- [x] RED: Add app-state tests for opening the archive browser and returning to chat through the back arrow
- [x] GREEN: Add the archive browser entry point from the appropriate session/navigation management surface
- [x] RED: Add tests proving the transcript and composer are not interactive while the archive browser takeover is active
- [x] GREEN: Route the live archive read model into the archive browser
- [x] REFACTOR: Keep takeover state compatible with the existing model chooser takeover behavior

### M7: Live Action Wiring

- [x] RED: Add web tests for unarchive removing a row and restoring normal navigation eligibility
- [x] GREEN: Wire live unarchive from the archive browser
- [x] RED: Add web tests for permanent-delete success, rejection, and backend error rendering
- [x] GREEN: Wire live permanent-delete command and result handling
- [x] REFACTOR: Keep action state row-scoped so deleting/unarchiving one row does not blank the whole browser

### Gate 3->4

- [ ] Archive browser opens and closes from the live app
- [ ] Unarchive works live and restores the session to normal navigation
- [ ] Permanent delete works live only after strong confirmation

## Phase 4: Full Validation

### M8: Verification Pass

- [ ] RED: Add hermetic e2e coverage for archived-session discovery, unarchive, and permanent-delete rejection cases
- [ ] GREEN: Make e2e pass against local services with fake provider where needed
- [ ] RED: Add manual EZE checklist for archive browser visual review and live archive/unarchive/delete flow
- [ ] GREEN: Verify Storybook states at desktop and narrow widths
- [ ] REFACTOR: Remove stale debug-only affordances if the archive browser supersedes them for ordinary archive management

### Gate 4

- [ ] Unit, web, integration, and hermetic e2e tests pass for archive-browser behavior
- [ ] Storybook archive browser review is approved
- [ ] Manual EZE confirms archived area clarity, back-to-chat behavior, unarchive, and permanent delete

## Summary

- Current cutoff blockers: 52 unchecked implementation/report items.
- Accepted/deferred follow-up: none.
- Superseded/obsolete checklist debt: none.

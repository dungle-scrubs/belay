# Ask User Tool - Progress Report

> Scope: new standalone planner plan for migrating V1 `ask_user` into Trevor V2. It does not modify the canonical Trevor V2 implementation plan.
> Current focus: Phase 1, M1 - Storybook contract and fixtures.

## Summary

- Current cutoff blockers: 67
- Completed: 0
- Deferred follow-up: 2
- Superseded: 0

## Phase 1: Storybook-First Question Surface

### M1: Storybook contract and fixtures

- [ ] RED: Add fixture coverage tests for V1 single-question, grouped-question, multi-select, custom-answer, defer, notes, required-reason, metadata, and preview cases
- [ ] GREEN: Add typed fixture builders for provider-question contracts and answer payloads
- [ ] RED: Add negative fixture tests for invalid group counts and invalid answer shapes
- [ ] GREEN: Add normalization helpers that coerce legacy-like payloads into the V2 view model
- [ ] REFACTOR: Share fixtures between tests and Storybook without duplicating payload literals

### M2: Presentational question surface

- [ ] RED: Add component tests for single-choice rendering and submit state
- [ ] GREEN: Implement the base React question surface and Storybook story
- [ ] RED: Add component tests for multi-select, custom answer, defer, notes, and required reason
- [ ] GREEN: Implement rich choice controls, custom input, notes, and reason flows
- [ ] RED: Add tests for keyboard navigation, focus order, disabled submit, and expiration state
- [ ] GREEN: Complete keyboard and focus behavior
- [ ] RED: Add narrow-width Storybook stories for grouped questions and long labels
- [ ] REFACTOR: Split view-model transforms from presentational components

### Gate 1 to 2

- [ ] Storybook includes approved desktop and narrow-width states
- [ ] Web tests pass for fixture coverage and component behavior
- [ ] No live host or transport dependency is required to render stories
- [ ] User approves the Storybook question surface before live wiring begins

## Phase 2: Protocol and Host Tool Runtime

### M3: Session protocol events

- [ ] RED: Add protocol tests for `provider.question.requested` round trip
- [ ] GREEN: Add typed request constructor and decoder in `packages/session`
- [ ] RED: Add protocol tests for `provider.question.answer` and `provider.question.resolved`
- [ ] GREEN: Add typed answer and resolved constructors and decoders
- [ ] RED: Add forward-compatible decode tests for missing optional fields and unknown metadata
- [ ] REFACTOR: Keep event names and payload keys centralized in protocol tests

### M4: Host ask_user runtime

- [ ] RED: Add host tests proving `ask_user` is registered and `ask_user_question` is absent
- [ ] GREEN: Register the `ask_user` tool schema and prompt guidance
- [ ] RED: Add host tests proving the tool emits a pending question and blocks the active tool call
- [ ] GREEN: Implement pending-question registry and answer promise resolution
- [ ] RED: Add tests for accept, decline, cancel, unknown question id, invalid answer shape, duplicate answer, and run-ended-before-answer
- [ ] GREEN: Validate answer payloads and return structured tool results
- [ ] REFACTOR: Keep provider-specific code out of the generic pending-question runtime

### Gate 2 to 3

- [ ] `pnpm test:unit` passes for protocol and host runtime tests
- [ ] Host logs and diagnostics do not include raw answer bodies by default
- [ ] Local mode and Richter mode share the same event shape
- [ ] Answers resume the active tool call rather than creating user prompts

## Phase 3: Live Web Wiring

### M5: Pending-question projection and prompt integration

- [ ] RED: Add web projection tests for requested, answered, resolved, expired, and duplicate-question event sequences
- [ ] GREEN: Implement pending-question projection from decoded session events
- [ ] RED: Add tests proving composer draft state is suspended and restored around an active question
- [ ] GREEN: Wire pending question state into the prompt/composer area
- [ ] RED: Add transcript tests proving provider questions and answers do not render as normal user messages
- [ ] GREEN: Hide raw question control events from transcript while preserving visible question UI
- [ ] REFACTOR: Keep UI state tab-scoped unless durable draft persistence is explicitly added later

### M6: Answer publishing and resolution

- [ ] RED: Add web tests for answer payload construction across single, multi, custom, defer, notes, and required reason
- [ ] GREEN: Publish `provider.question.answer` through `SessionTransport`
- [ ] RED: Add tests for publish failure, retry, and expired question
- [ ] GREEN: Add retryable error state and expiration handling
- [ ] RED: Add integration tests with a fake provider that blocks on `ask_user`
- [ ] GREEN: Complete host-to-web-to-host resolution flow

### Gate 3 to 4

- [ ] `pnpm test:web` passes
- [ ] Integration test proves the answer resumes the active tool call
- [ ] Transcript contains no duplicate user prompt for the answer
- [ ] Browser state resolves cleanly after cancel or run failure

## Phase 4: Approval Reuse and Final Verification

### M7: Shared approval adapter for handoff

- [ ] RED: Add tests for an approval-flavored question contract with approve, edit, and reject actions
- [ ] GREEN: Add a small adapter that maps approval requests to `ask_user` question contracts
- [ ] RED: Add tests proving approval answers return structured actions to the caller
- [ ] GREEN: Expose the adapter for continuation handoff without coupling it to handoff internals
- [ ] REFACTOR: Keep generic approval copy and handoff-specific copy separate

### M8: E2E and manual validation

- [ ] RED: Add hermetic e2e coverage for a fake provider that calls `ask_user`
- [ ] GREEN: Drive the browser answer flow and prove the provider turn completes
- [ ] RED: Add e2e coverage for cancel and publish failure recovery where feasible
- [ ] GREEN: Complete failure-path handling or document skipped prerequisites with stated reasons
- [ ] RED: Add manual EZE checklist for Storybook approval and live run verification
- [ ] GREEN: Update docs and `/doctor` or debug output only where needed for supportability

### Gate 4 complete

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Manual Storybook review is approved
- [ ] Manual live run proves `ask_user` resumes the active tool call

## Accepted/Deferred Follow-up

- [ ] Persist pending question drafts through browser reload if tab-scoped state proves insufficient
- [ ] Add full-browser Playwright visual coverage once the broader browser e2e lane exists

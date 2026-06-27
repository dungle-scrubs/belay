# Ask User Tool - Implementation Plan

## Execution Protocol

A progress report exists at `.plans/ask-user-tool/progress-report.md`. It lists every current-cutoff behavior for every milestone as a checkbox.

Mandatory rules for agents working on this plan:

1. Before starting a milestone, run `mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "ask-user-tool"` and read that milestone in the progress report.
2. Check each progress-report box as soon as the behavior is implemented and verified.
3. A milestone is not done until every current-cutoff checkbox under it is checked.
4. If implementation discovers missing behavior, add it to the progress report before building it.
5. Deferred follow-up and superseded checklist debt must not count as current blockers.

## Architecture

<!-- D-001 -->
The model-facing tool is `ask_user`. The host registers that exact tool name, validates the model input, emits a provider-question request event, waits for an answer, then returns the answer as the tool result for the same active provider turn.

<!-- D-005 -->
The durable contract is the V2 session event log, not a new database table. `packages/session` owns typed constructors and decoders; `apps/agent-host` owns pending-question runtime and provider tool integration; `apps/web` owns rendering and answer publishing. Local session-store persists events in its existing SQLite event log, and Richter uses the same `SessionTransport` contract.

<!-- D-002 -->
The React surface is built Storybook-first. Live wiring waits behind the Storybook approval gate.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Preserve V1 tool name | Provider registration and tests MUST use `ask_user` |
| Full V1 question richness | Contract cannot be limited to a single prompt and two buttons |
| Event-log source of truth | No local-only side store for pending questions |
| Active tool-call answer routing | Answers do not become `user.message` transcript prompts |
| Storybook-first | UI fixtures and interaction states precede live wiring |

### Boundaries

- `packages/session/src/protocol.ts` owns event names, payload constructors, decoders, and protocol tests.
- `apps/agent-host/src/tools` or the existing tool registry owns the `ask_user` schema and normalized runtime input.
- `apps/agent-host/src/agent` owns blocking the active provider turn until the answer resolves.
- `apps/web/src/components` owns the presentational question surface.
- `apps/web/src/session` or adjacent session hooks own projection from session events to pending question state.
- Storybook stories own visual approval states and do not require a running host.

### Observability

The host SHOULD emit structured debug data for question lifecycle without logging raw answer content by default. Useful facts are `questionId`, run id prefix, tool call id prefix, action, adapter, pending duration, validation failure kind, and resolution outcome. Browser diagnostics SHOULD distinguish "pending", "publish failed", "expired", and "resolved" states.

## Phases

### Phase 1: Storybook-First Question Surface

**Goal:** The complete React question surface is reviewable in Storybook before any live host wiring.

**Gate from previous:** None.

#### M1: Storybook contract and fixtures

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests or story assertions proving fixtures cover V1 single, grouped, multi-select, custom, defer, notes, reason, metadata, and preview cases.
  2. GREEN: Add typed fixture builders for `ProviderQuestionContract` and answer payloads.
  3. RED: Add negative fixture tests for invalid group counts and invalid answer shapes.
  4. GREEN: Add normalization helpers that coerce legacy-like payloads into the V2 view model.
  5. REFACTOR: Keep fixtures shared by tests and Storybook.

#### M2: Presentational question surface

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Add component tests for single-choice, multi-select, custom answer, notes, required reason, defer, keyboard navigation, disabled submit, and expiration.
  2. GREEN: Implement the presentational React surface and Storybook stories.
  3. RED: Add accessibility tests for labels, focus order, keyboard submit, and announced validation errors.
  4. GREEN: Complete keyboard and focus behavior.
  5. REFACTOR: Split view-model transforms from presentational components.

### Gate 1 to 2

- [ ] Storybook includes approved desktop and narrow-width states.
- [ ] Web tests pass for fixture coverage and component behavior.
- [ ] No live host or transport dependency is required to render stories.

### Phase 2: Protocol and Host Tool Runtime

**Goal:** The host can expose `ask_user`, pause a tool call, and resolve it through session events.

**Gate from previous:** Storybook question surface approved.

#### M3: Session protocol events

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for `provider.question.requested`, `provider.question.answer`, and `provider.question.resolved` round trips.
  2. GREEN: Add event constructors and decoders in `packages/session`.
  3. RED: Add forward-compatible decode tests for missing optional fields and unknown metadata.
  4. GREEN: Implement permissive decoding with safe defaults.
  5. REFACTOR: Keep event names and payload keys centralized in protocol tests.

#### M4: Host ask_user runtime

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add host tests proving `ask_user` is registered and `ask_user_question` is not.
  2. GREEN: Register the `ask_user` tool schema and prompt guidance.
  3. RED: Add host tests proving the tool emits a pending question and blocks the active tool call.
  4. GREEN: Implement pending-question registry and answer promise resolution.
  5. RED: Add tests for accept, decline, cancel, unknown question id, invalid answer shape, duplicate answer, and run-ended-before-answer.
  6. GREEN: Validate answer payloads and return structured tool results.
  7. REFACTOR: Keep provider-specific code out of the generic pending-question runtime.

### Gate 2 to 3

- [ ] `pnpm test:unit` passes for protocol and host runtime tests.
- [ ] Host logs and diagnostics do not include raw answer bodies by default.
- [ ] Local mode and Richter mode share the same event shape.

### Phase 3: Live Web Wiring

**Goal:** The browser renders pending questions from the session log and publishes answers without transcript pollution.

**Gate from previous:** Protocol and host runtime are green.

#### M5: Pending-question projection and prompt integration

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add web projection tests for requested, answered, resolved, expired, and duplicate-question event sequences.
  2. GREEN: Implement pending-question projection from decoded session events.
  3. RED: Add tests proving composer draft state is suspended and restored around an active question.
  4. GREEN: Wire pending question state into the prompt/composer area.
  5. RED: Add transcript tests proving provider questions and answers do not render as normal user messages.
  6. GREEN: Hide raw question control events from transcript while preserving visible question UI.
  7. REFACTOR: Keep UI state tab-scoped unless durable draft persistence is explicitly added later.

#### M6: Answer publishing and resolution

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for answer payload construction across single, multi, custom, defer, notes, and required reason.
  2. GREEN: Publish `provider.question.answer` through `SessionTransport`.
  3. RED: Add tests for publish failure, retry, and expired question.
  4. GREEN: Add retryable error state and expiration handling.
  5. RED: Add integration tests with a fake provider that blocks on `ask_user`.
  6. GREEN: Complete host-to-web-to-host resolution flow.

### Gate 3 to 4

- [ ] `pnpm test:web` passes.
- [ ] Integration test proves the answer resumes the active tool call.
- [ ] Transcript contains no duplicate user prompt for the answer.

### Phase 4: Approval Reuse and Final Verification

**Goal:** `ask_user` is ready as the shared user-decision primitive, including handoff approval reuse.

**Gate from previous:** Live web flow is green.

#### M7: Shared approval adapter for handoff

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for an approval-flavored question contract with approve, edit, and reject actions.
  2. GREEN: Add a small adapter that maps approval requests to `ask_user` question contracts.
  3. RED: Add tests proving approval answers return structured actions to the caller.
  4. GREEN: Expose the adapter for continuation handoff without coupling it to handoff internals.
  5. REFACTOR: Keep generic approval copy and handoff-specific copy separate.

#### M8: E2E and manual validation

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for a fake provider that calls `ask_user`.
  2. GREEN: Drive the browser answer flow and prove the provider turn completes.
  3. RED: Add e2e coverage for cancel and publish failure recovery where feasible.
  4. GREEN: Complete failure-path handling or document skipped prerequisites with stated reasons.
  5. RED: Add manual EZE checklist for Storybook approval and live run verification.
  6. GREEN: Update docs and `/doctor` or debug output only where needed for supportability.

### Gate 4 complete

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] Manual Storybook review is approved.
- [ ] Manual live run proves `ask_user` resumes the active tool call.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| The contract grows too broad for the first implementation | high | medium | Preserve V1 fields but implement behavior in staged milestones | planner |
| Question answers accidentally enter transcript as prompts | high | medium | Protocol and transcript tests explicitly forbid this | planner |
| Pending question survives after run cancellation | medium | medium | Host and web expiration tests cover run-ended-before-answer | planner |
| Storybook surface drifts from live surface | medium | medium | Share fixtures and presentational components between Storybook and live wiring | planner |

## Escape Hatches

1. If full rich preview handling blocks core answer flow, ship the contract and render preview fields as plain ASCII text first, then improve layout later.
2. If durable question draft restore is too costly, keep drafts in tab-scoped browser state and leave reload restore as deferred follow-up.
3. If handoff approval needs extra copy, keep it as an adapter over `ask_user` rather than forking the question surface.

## Progress Report Accounting

The progress report is the implementation resume state. Current cutoff blockers count only active unchecked work. Deferred follow-up is excluded from current blockers. Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "ask-user-tool"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:web
pnpm test:integration
pnpm test:e2e
pnpm test
```

## Decisions

Canonical decisions live in `.plans/ask-user-tool/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "ask-user-tool"
```

# Continuation Handoff - Implementation Plan

## 0. Hard Dependencies

- [ ] `01-ask-user-tool` - model-initiated handoff proposals require an explicit approval/edit/reject question surface.

## Execution Protocol

A progress report exists at `.plans/02-continuation-handoff/progress-report.md`. It lists every current-cutoff behavior for every milestone as a checkbox.

Mandatory rules for agents working on this plan:

1. Before starting a milestone, run `mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "02-continuation-handoff"` and read that milestone in the progress report.
2. Check each progress-report box as soon as the behavior is implemented and verified.
3. A milestone is not done until every current-cutoff checkbox under it is checked.
4. If implementation discovers missing behavior, add it to the progress report before building it.
5. Deferred follow-up and superseded checklist debt must not count as current blockers.

## Architecture

<!-- D-001 -->
The user-facing command surface is `/handoff`, `/handoff --generate`, and `/handoff --direct`. Generated mode creates a target prompt from the source-session request; direct mode sends the provided text as the target prompt.

<!-- D-002 -->
The feature is a continuation workflow, not a filesystem lease transfer. Existing host leadership, replacement host spawning, and `session.switch` semantics remain the authority boundary.

<!-- D-004 -->
The source of truth is the shared session event log. The feature adds typed handoff events in `packages/session`, handled by host and web over `SessionTransport`. Local persistence remains the existing session-store SQLite event log.

<!-- D-003 -->
Generated prompt text is visible as generation feedback in the source session but is not a source transcript item. It becomes transcript content only as the target session's first `user.message`.

<!-- D-005 -->
Model-initiated handoff is proposal-only until the user approves.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| V1 parity | Slash commands need generated and direct modes |
| No lease feature | Do not add filesystem ownership transfer semantics |
| Event-log source of truth | Do not create a `handoff_capsules` table |
| Source/target render split | Generated prompt appears only in target transcript |
| Approval required | Model proposal tool cannot execute the switch directly |

### Boundaries

- `packages/session/src/protocol.ts` owns typed handoff events and `session.switch` reason updates if needed.
- `apps/agent-host/src/commands.ts` owns command specs and lightweight parsing.
- `apps/agent-host/src/main.ts` owns orchestration, target session ensuring, host attach/spawn, and `session.switch`.
- `apps/web/src/transcript.ts` owns source transcript hiding and target transcript rendering rules.
- The `01-ask-user-tool` plan owns the generic approval question surface; handoff adapts to it.

### Observability

Handoff diagnostics SHOULD include handoff id, source session id, target session id, mode, generation state, approval action, failure code, and target-ready timing. Logs and diagnostics SHOULD avoid raw generated prompt text by default, since that text may contain user intent or copied context.

## Phases

### Phase 1: Slash Handoff Parity

**Goal:** Direct and generated slash command modes exist behind tests and announce in command inventory.

**Gate from previous:** None.

#### M1: Command protocol and parser

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add parser tests for `/handoff`, `/handoff --generate`, `/handoff --direct`, empty direct prompt, and quoted arguments.
  2. GREEN: Implement command parsing and command inventory spec.
  3. RED: Add protocol tests for handoff request and lifecycle events.
  4. GREEN: Add typed handoff event constructors and decoders.
  5. REFACTOR: Keep handoff argument parsing separate from host orchestration.

#### M2: Direct handoff flow

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add host tests proving direct handoff rejects empty prompts and does not switch.
  2. GREEN: Implement direct prompt validation.
  3. RED: Add host tests proving accepted direct handoff ensures target session before switch.
  4. GREEN: Append target provenance plus target `user.message`, attach or spawn host, and publish `session.switch`.
  5. RED: Add web tests proving source command result and target first prompt render correctly.
  6. REFACTOR: Share target-session switch ordering with existing `/clear` or workspace-switch helpers where practical.

### Gate 1 to 2

- [ ] `/handoff --direct` works without model generation.
- [ ] Direct mode does not write generated-prompt events.
- [ ] Target prompt appears once, in the target session.
- [ ] `pnpm test:unit` passes for command and protocol tests.

### Phase 2: Generated Prompt Timing

**Goal:** Generated handoff prompt creation feels live in the source session and renders only in the target session.

**Gate from previous:** Slash direct flow is green.

#### M3: Source-session generation state

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add host tests proving generated mode emits request and progress events in the source session.
  2. GREEN: Implement generated prompt request orchestration through the provider.
  3. RED: Add tests proving generated prompt text is not emitted as `assistant.completed` transcript content in the source session.
  4. GREEN: Emit sanitized handoff lifecycle events instead of source transcript prompt content.
  5. RED: Add web tests for source-session progress, failed generation, and cancellation.
  6. GREEN: Render source feedback without showing the generated prompt as a transcript item.
  7. REFACTOR: Isolate handoff generation state from the ordinary turn scheduler where possible.

#### M4: Target-session prompt injection

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add host tests proving generated prompt becomes the first target `user.message`.
  2. GREEN: Append target provenance and target prompt event before `session.switch`.
  3. RED: Add tests proving generated prompt is submitted exactly once on duplicate accept or replay.
  4. GREEN: Add idempotency by handoff id and target session id.
  5. RED: Add web tests for following `session.switch` after target prompt is ready.
  6. GREEN: Ensure browser switches only after target session can replay provenance and prompt.
  7. REFACTOR: Keep target prompt injection reusable for model-approved proposals.

### Gate 2 to 3

- [ ] Generated source feedback appears without source transcript duplication.
- [ ] Target session replays provenance and first prompt before running.
- [ ] Duplicate acceptance does not duplicate the target prompt.
- [ ] Generation failure leaves the source session active.

### Phase 3: Model Proposal and Approval

**Goal:** The model can propose a handoff, but execution is gated by explicit user approval.

**Gate from previous:** Generated slash flow is green, and `01-ask-user-tool` approval adapter is available.

#### M5: Handoff proposal tool

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add host tests proving a model proposal tool cannot call `session.switch` directly.
  2. GREEN: Register a proposal-only handoff tool.
  3. RED: Add tests proving proposals include generated prompt, source provenance, and requested mode.
  4. GREEN: Emit handoff proposal events and store proposal state in the session log.
  5. RED: Add tests for malformed proposals and stale proposal ids.
  6. REFACTOR: Keep proposal validation independent from slash command parsing.

#### M6: ask_user approval bridge

- **Dependencies:** M5, `01-ask-user-tool` M7
- **Effort:** M
- **Tasks:**
  1. RED: Add integration tests proving proposal approval uses `ask_user`.
  2. GREEN: Map handoff proposal approval to the shared approval question adapter.
  3. RED: Add tests for approve, edit, reject, and expired approval.
  4. GREEN: Execute approved or edited prompt through the accepted handoff flow.
  5. REFACTOR: Keep approval UI copy in web/story fixtures, not host internals.

### Gate 3 to 4

- [ ] Model proposals require approval before target session creation.
- [ ] Reject leaves the source session active and records rejection.
- [ ] Edited approval uses edited prompt as the target first prompt.
- [ ] The handoff feature does not create a separate approval UI.

### Phase 4: E2E and Polish

**Goal:** Direct, generated, proposal-approved, rejected, and failure flows are verified end to end.

**Gate from previous:** Model proposal approval is green.

#### M7: Transcript, sidebar, and status polish

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for source transcript hiding, target transcript rendering, and provenance display.
  2. GREEN: Polish transcript projection for handoff lifecycle events.
  3. RED: Add web tests for session sidebar updates after handoff switch.
  4. GREEN: Ensure the target session appears and becomes current in navigation.
  5. RED: Add tests for progress and failure copy with long generated prompts.
  6. REFACTOR: Keep long prompt preview layout stable across narrow and wide viewports.

#### M8: E2E and manual validation

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for `/handoff --direct`.
  2. GREEN: Drive direct handoff through target-session switch and prompt submission.
  3. RED: Add hermetic e2e coverage for generated handoff with fake provider.
  4. GREEN: Drive generated handoff through source feedback and target first prompt.
  5. RED: Add e2e coverage for approved and rejected model proposals when `ask_user` is available.
  6. GREEN: Complete proposal e2e or skip with a stated dependency reason.

### Gate 4 complete

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] Manual EZE direct handoff works.
- [ ] Manual EZE generated handoff renders prompt only in the target session.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Generated prompt leaks into source transcript | high | medium | Protocol and web tests explicitly forbid source transcript rendering | planner |
| Session switches before target is replayable | high | medium | Host tests enforce target-ready ordering before `session.switch` | planner |
| Model proposal executes without approval | high | low | Proposal tool cannot call the switch path directly; approval bridge required | planner |
| Duplicate accept creates duplicate target prompts | medium | medium | Idempotency by handoff id and target session id | planner |

## Escape Hatches

1. If generated handoff is blocked by provider orchestration, ship `/handoff --direct` first but keep the plan incomplete.
2. If `01-ask-user-tool` is not ready, slash commands can proceed, but model proposal approval remains blocked and this plan does not reach complete.
3. If target host attach fails, keep the source session active and surface a retryable failure instead of publishing `session.switch`.

## Progress Report Accounting

The progress report is the implementation resume state. Current cutoff blockers count only active unchecked work. Deferred follow-up is excluded from current blockers. Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "02-continuation-handoff"
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

Canonical decisions live in `.plans/02-continuation-handoff/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "02-continuation-handoff"
```

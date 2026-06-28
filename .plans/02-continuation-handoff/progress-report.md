# Continuation Handoff - Progress Report

> Scope: new standalone planner plan for migrating V1 continuation handoff into Trevor V2. It does not modify the canonical Trevor V2 implementation plan.
> Current focus: Phase 2, M3 - source-session generation state (M1 parser + protocol, M2 direct flow done).

## Summary

- Current cutoff blockers: 50
- Completed: 15
- Deferred follow-up: 2
- Superseded: 0

## Phase 1: Slash Handoff Parity

### M1: Command protocol and parser

- [x] RED: Add parser tests for `/handoff`, `/handoff --generate`, `/handoff --direct`, empty direct prompt, and quoted arguments
- [x] GREEN: Implement command parsing and command inventory spec
- [x] RED: Add protocol tests for handoff request and lifecycle events
- [x] GREEN: Add typed handoff event constructors and decoders
- [x] REFACTOR: Keep handoff argument parsing separate from host orchestration

### M2: Direct handoff flow

- [x] RED: Add host tests proving direct handoff rejects empty prompts and does not switch
- [x] GREEN: Implement direct prompt validation
- [x] RED: Add host tests proving accepted direct handoff ensures target session before switch
- [x] GREEN: Append target provenance plus target `user.message`, attach or spawn host, and publish `session.switch`
- [x] RED: Add web tests proving source command result and target first prompt render correctly
- [x] REFACTOR: Share target-session switch ordering with existing `/clear` or workspace-switch helpers where practical

### Gate 1 to 2

- [x] `/handoff --direct` works without model generation
- [x] Direct mode does not write generated-prompt events
- [x] Target prompt appears once, in the target session
- [x] `pnpm test:unit` passes for command and protocol tests

## Phase 2: Generated Prompt Timing

### M3: Source-session generation state

- [ ] RED: Add host tests proving generated mode emits request and progress events in the source session
- [ ] GREEN: Implement generated prompt request orchestration through the provider
- [ ] RED: Add tests proving generated prompt text is not emitted as `assistant.completed` transcript content in the source session
- [ ] GREEN: Emit sanitized handoff lifecycle events instead of source transcript prompt content
- [ ] RED: Add web tests for source-session progress, failed generation, and cancellation
- [ ] GREEN: Render source feedback without showing the generated prompt as a transcript item
- [ ] REFACTOR: Isolate handoff generation state from the ordinary turn scheduler where possible

### M4: Target-session prompt injection

- [ ] RED: Add host tests proving generated prompt becomes the first target `user.message`
- [ ] GREEN: Append target provenance and target prompt event before `session.switch`
- [ ] RED: Add tests proving generated prompt is submitted exactly once on duplicate accept or replay
- [ ] GREEN: Add idempotency by handoff id and target session id
- [ ] RED: Add web tests for following `session.switch` after target prompt is ready
- [ ] GREEN: Ensure browser switches only after target session can replay provenance and prompt
- [ ] REFACTOR: Keep target prompt injection reusable for model-approved proposals

### Gate 2 to 3

- [ ] Generated source feedback appears without source transcript duplication
- [ ] Target session replays provenance and first prompt before running
- [ ] Duplicate acceptance does not duplicate the target prompt
- [ ] Generation failure leaves the source session active

## Phase 3: Model Proposal and Approval

### M5: Handoff proposal tool

- [ ] RED: Add host tests proving a model proposal tool cannot call `session.switch` directly
- [ ] GREEN: Register a proposal-only handoff tool
- [ ] RED: Add tests proving proposals include generated prompt, source provenance, and requested mode
- [ ] GREEN: Emit handoff proposal events and store proposal state in the session log
- [ ] RED: Add tests for malformed proposals and stale proposal ids
- [ ] REFACTOR: Keep proposal validation independent from slash command parsing

### M6: ask_user approval bridge

- [ ] RED: Add integration tests proving proposal approval uses `ask_user`
- [ ] GREEN: Map handoff proposal approval to the shared approval question adapter
- [ ] RED: Add tests for approve, edit, reject, and expired approval
- [ ] GREEN: Execute approved or edited prompt through the accepted handoff flow
- [ ] REFACTOR: Keep approval UI copy in web/story fixtures, not host internals

### Gate 3 to 4

- [ ] Model proposals require approval before target session creation
- [ ] Reject leaves the source session active and records rejection
- [ ] Edited approval uses edited prompt as the target first prompt
- [ ] The handoff feature does not create a separate approval UI

## Phase 4: E2E and Polish

### M7: Transcript, sidebar, and status polish

- [ ] RED: Add web tests for source transcript hiding, target transcript rendering, and provenance display
- [ ] GREEN: Polish transcript projection for handoff lifecycle events
- [ ] RED: Add web tests for session sidebar updates after handoff switch
- [ ] GREEN: Ensure the target session appears and becomes current in navigation
- [ ] RED: Add tests for progress and failure copy with long generated prompts
- [ ] REFACTOR: Keep long prompt preview layout stable across narrow and wide viewports

### M8: E2E and manual validation

- [ ] RED: Add hermetic e2e coverage for `/handoff --direct`
- [ ] GREEN: Drive direct handoff through target-session switch and prompt submission
- [ ] RED: Add hermetic e2e coverage for generated handoff with fake provider
- [ ] GREEN: Drive generated handoff through source feedback and target first prompt
- [ ] RED: Add e2e coverage for approved and rejected model proposals when `ask_user` is available
- [ ] GREEN: Complete proposal e2e or skip with a stated dependency reason

### Gate 4 complete

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Manual EZE direct handoff works
- [ ] Manual EZE generated handoff renders prompt only in the target session

## Accepted/Deferred Follow-up

- [ ] Add optional final review/edit gate for user-invoked generated handoff if automatic switch feels too abrupt
- [ ] Add richer target-session provenance rendering after the first parity cut is working

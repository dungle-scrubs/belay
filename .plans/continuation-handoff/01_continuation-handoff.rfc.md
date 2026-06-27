---
number: "01"
title: "Continuation Handoff"
type: "feature"
status: "Draft"
date: "2026-06-27"
author: "planner"
---

# RFC 01: Continuation Handoff

## Abstract

Trevor V2 needs V1-style continuation handoff so a user or model can create a clean prompt for a fresh session without manual copy and paste. The V2 design preserves typed `/handoff` parity while using the session event log instead of V1 handoff capsule tables. Generated handoff prompts are produced with source-session feedback, rendered only in the target session, and model-initiated handoff requires explicit approval.

## Introduction

V1 handoff builds continuation capsules in the host and accepts them in the TUI as the first prompt in a fresh session. V2 already has immediate host commands, session switching, replacement host spawning, and a shared session event contract. The missing feature is the user-facing handoff command and model-safe proposal path that creates a new-session prompt at the right time.

This RFC covers continuation handoff only. It does not define a filesystem control-lease system, a worktree ownership protocol, or a new durable storage root.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Continuation handoff**: A workflow that turns current-session context and a handoff request into a prompt submitted in a fresh target session.
- **Source session**: The session where `/handoff` is invoked or where the model proposes handoff.
- **Target session**: The fresh session that receives the accepted handoff prompt as its first user prompt.
- **Generated handoff**: A handoff where the model creates the target prompt from a request.
- **Direct handoff**: A handoff where the provided text is the target prompt.
- **Proposal tool**: A model tool that proposes handoff but cannot execute it without user approval.

## Motivation

The user wants the V1 handoff workflow migrated to V2 so they can tell the model to generate a prompt and start a new session without manually typing the command or copying text. The user also wants protection against accidental handoff: model-initiated handoff MUST ask for approval.

V2 has stricter timing requirements than V1 because the browser SHOULD show feedback during generation while avoiding duplicate transcript rendering across source and target sessions.

## Design

<!-- D-001 -->
V2 continuation handoff targets V1 user-facing parity: `/handoff` defaults to generated prompt behavior, `/handoff --generate` is the explicit generated form, and `/handoff --direct` sends the supplied prompt as-is.

<!-- D-002 -->
This is a continuation feature, not filesystem control-lease handoff. The implementation MUST reuse existing leader, replacement-host, and `session.switch` mechanics. It MUST NOT add a new worktree or filesystem ownership protocol as part of the first cut.

<!-- D-004 -->
Handoff state uses session events over `SessionTransport`. Local mode persists those events through the existing session-store SQLite event log; Richter mode uses the same event contract. The feature MUST NOT introduce a V1-style `handoff_capsules` table.

The shared protocol SHOULD add typed events for:

- `handoff.requested`
- `handoff.generating`
- `handoff.generated`
- `handoff.approved`
- `handoff.rejected`
- `handoff.failed`
- `handoff.accepted`

The source session records request, generation progress, generated metadata, approval, rejection, and failure. The target session records provenance and the submitted `user.message`.

<!-- D-003 -->
Generated prompt text is produced in the source session with visible progress feedback, but it MUST NOT render as a source-session transcript item. It renders as the first target-session user prompt only after direct invocation or explicit approval.

<!-- D-005 -->
A model MAY propose handoff through a tool, but the model MUST NOT switch sessions or submit the target prompt without explicit user approval.

<!-- D-007 -->
The model-initiated approval path depends on the `ask-user-tool` plan and SHOULD reuse its approval surface. The slash-command path can be implemented independently, but this handoff plan is not complete until proposal approval uses `ask_user`.

<!-- D-006 -->
For accepted handoff, the host MUST ensure the target session, append target-session provenance and `user.message`, attach or spawn the correct host, and publish `session.switch` only after the target is ready.

## State Machine

```
idle
  -> requested         on /handoff or model proposal
requested
  -> direct_ready      on --direct with non-empty prompt
requested
  -> generating        on generated mode
generating
  -> generated         on prompt generation success
generating
  -> failed            on generation failure or cancellation
generated
  -> approval_pending  on model-initiated proposal
generated
  -> accepted          on user-invoked generated command
approval_pending
  -> accepted          on user approval
approval_pending
  -> rejected          on user rejection
direct_ready
  -> accepted          on direct command validation
accepted
  -> switched          after target session is ready and session.switch is published
failed
  -> idle              after visible failure result
rejected
  -> idle              after visible rejection result
```

Invalid or stale approvals MUST NOT switch sessions. A handoff whose target session already exists MUST be idempotent by handoff id and MUST NOT duplicate the target prompt.

## Error Handling

- **HO001 - Empty direct prompt**: `/handoff --direct` has no prompt. Recovery: emit a failed command result and do not create a target session.
- **HO002 - Generation failed**: The provider cannot generate the target prompt. Recovery: emit a visible source-session failure and leave the current session active.
- **HO003 - Approval rejected**: The user rejects a model proposal. Recovery: resolve the proposal and do not create or switch target sessions.
- **HO004 - Target ensure failed**: The host cannot create or ensure the target session. Recovery: emit failure in source session and do not retire the source host.
- **HO005 - Host attach failed**: Replacement host cannot attach to target. Recovery: do not publish `session.switch`; keep the source session active and surface the failure.
- **HO006 - Duplicate acceptance**: Same handoff id is accepted twice. Recovery: reuse the existing target session if complete; otherwise surface in-progress state.

## Security Considerations

Handoff prompt generation moves model-authored text into a fresh session as a user prompt, so explicit boundaries are required. Generated prompt text MUST be visible for user-invoked generated handoff before switch feedback completes, but it MUST NOT be silently executed from a model proposal without approval. Source provenance SHOULD be stored in sanitized structured fields so the target can show where it came from without exposing raw hidden context. The approval UI MUST make the target prompt inspectable or editable before model-initiated execution.

## Alternatives Considered

1. **Use a host SQLite table for handoff capsules**: Rejected because V2 should preserve local and Richter parity through session events.
2. **Auto-trigger handoff from assistant prose**: Rejected because it could accidentally switch sessions based on ordinary model text.
3. **Render generated prompt in both source and target sessions**: Rejected because the user asked for source feedback without duplicate transcript content.
4. **Bundle filesystem control lease with first cut**: Rejected because the requested feature is prompt/session continuation, not file ownership transfer.

## Implementation Plan

1. Add `/handoff`, `/handoff --generate`, and `/handoff --direct` command parsing and command inventory entries.
2. Add protocol events and transcript projection rules for source feedback without source prompt rendering.
3. Implement direct handoff target-session creation and prompt submission.
4. Implement generated handoff prompt creation with progress feedback and hidden source transcript output.
5. Add model proposal tool gated by `ask_user` approval.
6. Add integration and hermetic e2e coverage for direct, generated, rejected, failed, and duplicate acceptance flows.

## Open Questions

1. Should user-invoked generated handoff require a final review/edit step, or should it switch automatically once generation succeeds?
2. What exact target-session provenance item should render above the first target prompt?
3. Should `/handoff` inherit current provider/reasoning settings from the source session or use current defaults when the target runs?

## References

- Normative: `packages/session/src/protocol.ts` - V2 session events, `user.command`, `command.result`, and `session.switch`.
- Normative: `apps/agent-host/src/main.ts` - existing `/clear`, `/cd`, and workspace switch ordering.
- Normative: `apps/web/src/transcript.ts` - transcript projection rules for command and session-switch events.
- Informative: `/Users/kevin/dev/trevor/packages/agent-host/src/server/rpc/host-commands.ts` - V1 handoff capsule creation.
- Informative: `/Users/kevin/dev/trevor/tui/src/app/handoff.rs` - V1 handoff acceptance into a fresh session.
- Informative: `.plans/ask-user-tool/implementation.md` - planned V2 approval surface for model-initiated handoff.

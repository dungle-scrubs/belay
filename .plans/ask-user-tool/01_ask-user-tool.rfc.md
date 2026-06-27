---
number: "01"
title: "Ask User Tool"
type: "feature"
status: "Draft"
date: "2026-06-27"
author: "planner"
---

# RFC 01: Ask User Tool

## Abstract

Trevor V2 needs the V1 `ask_user` capability so the model can pause an active run, ask the user for a concrete decision, and continue with the answer as a tool result. The V2 version keeps the model-facing tool name and full V1 interaction richness while replacing the TUI rendering surface with a Storybook-first React surface. The feature uses the shared session event protocol so local session-store and Richter deployments behave the same way.

## Introduction

V1 already has a provider-question lane with a rich `ask_user` tool, pending question state, answer routing, and TUI rendering. V2 has the ingredients for the same capability - a shared event protocol in `packages/session`, a host tool loop in `apps/agent-host`, and a React/Storybook frontend in `apps/web` - but it does not yet expose `ask_user` as a working model tool.

This RFC covers the V2 migration of the user-question feature. It does not implement generic browser modal infrastructure, filesystem control, or new persistent state outside the session event log.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **ask_user**: The model-facing tool that asks the human for one or more decisions and returns the selected answer to the active tool call.
- **Provider question**: The host/runtime representation of a pending model-originated user question.
- **Question contract**: The typed payload describing question groups, choices, metadata, previews, custom-answer affordances, and answer shape.
- **Question surface**: The React UI that renders a pending provider question and captures the user's answer.
- **Active tool call**: The model tool invocation that is blocked waiting for a user answer.

## Motivation

The user wants `ask_user` brought forward as a high-priority V2 feature because it unlocks safer agent autonomy. It also becomes the approval primitive for model-initiated continuation handoff. Without it, the model either guesses at ambiguous decisions or falls back to prose questions that are not structurally tied to the active run.

V2 also changes the frontend constraints. React and Storybook give Trevor more rendering control than the V1 TUI, so the feature SHOULD be designed and reviewed visually before live wiring.

## Design

<!-- D-001 -->
The model-facing tool name MUST remain `ask_user`. V2 MUST NOT rename the tool to `ask_user_question`.

<!-- D-002 -->
The implementation is Storybook-first. The first executable slice builds the presentational question surface and fixtures in `apps/web` and pauses before live wiring until the Storybook behavior is approved.

<!-- D-003 -->
The V2 contract targets full V1 user-question functionality: grouped 1 to 5 questions, stable question ids, headers, `kind`, single-select and multi-select choices, custom answers, defer, notes, required reasons, recommendation metadata, impact metadata, risk metadata, badges, and ASCII previews.

The shared protocol SHOULD add typed event constructors and decoders in `packages/session/src/protocol.ts` for:

- `provider.question.requested`
- `provider.question.answer`
- `provider.question.resolved`

The request event SHOULD carry `questionId`, `runId`, `toolCallId`, `toolName`, `adapter`, and a normalized `questionContract`. The answer event SHOULD carry `questionId`, `action`, optional structured `content`, optional notes, and optional reason. The resolved event SHOULD close the pending question for every participant and provide enough sanitized summary data for transcript or diagnostics.

<!-- D-005 -->
The provider-question lane uses `SessionTransport`. Local mode persists the events through the existing session-store SQLite event log, and Richter mode uses the same event contract. The feature MUST NOT add a separate local-only question table or V1-style app database dependency.

<!-- D-004 -->
An accepted answer resumes the active tool call as a tool result. It MUST NOT be appended as a separate `user.message`, and it MUST NOT create a new prompt in the durable transcript.

<!-- D-006 -->
The system prompt and tool description SHOULD tell models to call `ask_user` only when a concrete missing decision blocks useful progress. The tool SHOULD prefer concrete choices over broad free-form preference gathering unless the user explicitly requested free-form input.

<!-- D-007 -->
The continuation-handoff plan uses this feature as the approval surface for model-initiated handoff proposals.

## State Machine

```
idle
  -> requested        on host emits provider.question.requested
requested
  -> answering        on browser shows current pending question
requested
  -> cancelled        on host resolves or run is cancelled before answer
answering
  -> answered         on browser publishes provider.question.answer accept
answering
  -> declined         on browser publishes provider.question.answer decline
answering
  -> cancelled        on browser publishes provider.question.answer cancel
answered
  -> resolved         on host injects tool result and emits provider.question.resolved
declined
  -> resolved         on host injects decline result and emits provider.question.resolved
cancelled
  -> resolved         on host closes pending question and emits provider.question.resolved when possible
```

Invalid answers for unknown or already resolved `questionId` MUST be rejected with a structured, user-visible error event and MUST NOT resume any tool call.

## Error Handling

- **AQ001 - Unknown question id**: The host receives an answer for a missing pending question. Recovery: emit a structured error and leave active runs unchanged.
- **AQ002 - Invalid answer payload**: The answer shape does not match the request contract. Recovery: keep the question pending and render validation feedback.
- **AQ003 - Run ended before answer**: The active run was cancelled, failed, or replaced before the answer arrived. Recovery: resolve the UI as expired and do not inject the answer.
- **AQ004 - Transport publish failed**: The browser cannot publish an answer. Recovery: keep the answer draft in UI state and expose retry.
- **AQ005 - Duplicate request**: The host emits the same `questionId` twice. Recovery: treat the latest event as authoritative only if it refers to the same run and tool call; otherwise surface a protocol error.

## Security Considerations

Question text, previews, and choices are model-provided content and MUST be rendered as inert text. The browser MUST NOT interpret preview strings as HTML. Answers can contain user intent and MAY be sensitive, so diagnostics MUST redact raw answer bodies unless the user explicitly inspects the session transcript. The host MUST validate every answer against the pending question contract before returning it to the provider. Tool usage guidance SHOULD prevent `ask_user` from being used as a prompt-injection channel for broad fishing or permission escalation.

## Alternatives Considered

1. **Ask through ordinary assistant prose**: Rejected because the answer would become a normal user prompt and would not resume the active tool call.
2. **Add a separate local SQLite table for pending questions**: Rejected because V2 already owns durable session state through `SessionTransport`, and a local-only table would diverge from Richter behavior.
3. **Ship live wiring before Storybook**: Rejected because the user explicitly wants Storybook approval before implementation.
4. **Rename to `ask_user_question`**: Rejected because V1 compatibility and user preference require `ask_user`.

## Implementation Plan

1. Build the Storybook-first question contract fixtures and presentational React surface.
2. Add protocol constructors, decoders, and tests in `packages/session`.
3. Add host pending-question runtime, model tool registration, and answer injection into the active provider tool call.
4. Wire the web surface to pending provider-question events and answer publishing.
5. Reuse the same surface for continuation-handoff approval.
6. Add unit, web, integration, and hermetic e2e coverage.

## Open Questions

1. Should pending question UI persist its draft through browser reload in the first cut, or is in-memory tab state enough until a later pass?
2. Should declined answers return a structured tool result to the model, or should they cancel the active run?
3. What exact visual density should the approved Storybook surface use for compact side-panel layouts?

## References

- Normative: `packages/session/src/protocol.ts` - V2 Trevor event constructors and decoders.
- Normative: `packages/session/src/transport.ts` - shared local/Richter session transport contract.
- Normative: `apps/agent-host/src/main.ts` - V2 host event handling and command lane.
- Normative: `apps/web/src/transcript.ts` - V2 transcript folding and rendering behavior.
- Informative: `/Users/kevin/dev/trevor/packages/agent-host/src/server/rpc/provider-questions.ts` - V1 pending provider-question runtime.
- Informative: `/Users/kevin/dev/trevor/tui/src/app/user_question.rs` - V1 TUI user-question state and answer routing.

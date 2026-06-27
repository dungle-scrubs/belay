---
number: 01
title: "DeepSeek Provider Reliability and Diagnostics"
type: protocol
status: Draft
author: Trevor V2
date: 2026-06-26
---

# RFC-01: DeepSeek Provider Reliability and Diagnostics

## Abstract

This RFC defines how Trevor should classify, recover from, persist, and render DeepSeek/pi-ai provider failures. The observed failures are not a routing problem: one DeepSeek run died after a small thinking-only partial and persisted only `stream failed`, another leaked raw DSML-like tool-call markup into visible prose, and live usage input moved backward because provider-reported input was not full prompt context. The proposed change adds typed provider diagnostics, provider-boundary classification, a safe partial-stream retry policy, malformed tool-output detection, richer budget-stop semantics, and user-visible diagnostics. It preserves existing event compatibility while adding structured fields for new host and web behavior.

## Introduction

Trevor currently normalizes provider failures too aggressively. In the observed DeepSeek session `opchain-20260626-150533z-c3ce69a0`, the first run emitted `assistant.completed` with an empty answer and `error: "stream failed"` after only about 40 thinking characters. The persisted event lost the upstream cause, provider phase, retryability, and whether retry would have been safe. A later run stopped after the 32-step tool budget and rendered raw DSML-like `<tool_calls>` / `<invoke>` text in the transcript, which made a provider protocol failure look like ordinary assistant prose.

The current implementation already has useful foundations: typed `ProviderUnavailable` / `ProviderAuthError`, generic retryable-outage classification, `assistant.reconnecting`, `assistant.progress`, step-limit completion flags, and `/doctor` provider surfaces. The missing piece is a provider-specific diagnostic contract that keeps DeepSeek quirks at the adapter boundary and gives the loop and UI structured data instead of prose.

<!-- D-003 --> This plan is subordinate to the canonical Trevor V2 plan at `.plans/trevor-v2/implementation.md`. If this RFC conflicts with the canonical plan, the canonical plan wins. This RFC MUST NOT reintroduce the dropped routing engine or model-led routing classification; it only covers provider reliability, diagnostics, malformed provider output, and UI surfacing.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Provider diagnostic**: A structured, sanitized explanation of a provider incident, correlated to a run and model step.
- **Provider phase**: The part of a turn where the incident happened, such as `build_model`, `request_start`, `thinking`, `text`, `tool_call`, `usage`, `done`, or `synthesis`.
- **Safe retry**: A retry that cannot duplicate visible assistant text, tool execution, file mutations, or external side effects.
- **Thinking-only partial**: A stream partial containing only reasoning/thinking deltas and no visible assistant text, tool calls, or tool results.
- **Protocol leak**: Provider text that resembles the tool-call protocol but did not arrive as a typed `tool_call` event.
- **Budget stop**: A turn where Trevor forces a final answer because either the step backstop or context-pressure gate was reached.

## Protocol Overview

### Current Flow

1. A user message selects `provider: "deepseek"`.
2. The host runs `runAgent`, which calls the pi-ai-backed provider adapter.
3. The adapter maps pi-ai events to `ProviderEvent`.
4. The loop emits assistant deltas, thinking, tool events, usage, and completion.
5. If the provider stream fails, `publishTurn` currently emits a terminal `assistant.completed.error` string.

This loses important detail when the failure is provider-specific or occurs after a small safe partial.

### Target Flow

<!-- D-001 --> The terminal and retry-status events SHOULD carry a provider diagnostic envelope in addition to existing compatibility fields. The existing `assistant.completed.error` string MUST remain so old clients keep rendering failures.

<!-- D-002 --> Provider-specific detection MUST live at the provider boundary as layered rules below the generic pi-ai classifier. The agent loop and web UI MUST consume typed diagnostics and MUST NOT string-match DeepSeek-specific phrases directly.

High-level target flow:

```text
pi-ai event/error
  -> generic pi-ai classifier
  -> provider-specific classifier, e.g. DeepSeek
  -> ProviderUnavailable / ProviderAuthError with diagnostic
  -> agent loop safe-retry decision
  -> assistant.reconnecting or assistant.completed with diagnostic
  -> web renders typed status, /doctor exposes last incident
```

## Message Formats

### Provider Diagnostic

New shared schema, owned in `packages/session`, used by host and web:

```ts
export interface ProviderDiagnostic {
  readonly provider: string;
  readonly model: string;
  readonly phase: ProviderPhase;
  readonly reason: ProviderIncidentReason;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: string;
  readonly detail: string;
  readonly rawDetail?: string;
  readonly attempt: number;
  readonly streamed: {
    readonly thinkingChars: number;
    readonly textChars: number;
    readonly toolCalls: number;
    readonly toolResults: number;
  };
}
```

`rawDetail` is OPTIONAL and MUST be sanitized before it is published to a durable session. It MUST NOT include credentials, request bodies, headers, full prompt text, or file contents.

Suggested reason values:

```ts
type ProviderIncidentReason =
  | "transport"
  | "auth"
  | "quota"
  | "rate_limit"
  | "context"
  | "malformed_tool_output"
  | "empty"
  | "timeout"
  | "provider_protocol"
  | "unknown";
```

Suggested phase values:

```ts
type ProviderPhase =
  | "build_model"
  | "request_start"
  | "thinking"
  | "text"
  | "tool_call"
  | "usage"
  | "done"
  | "synthesis";
```

### Event Compatibility

`assistant.completed` SHOULD gain an optional `diagnostic` field:

```ts
events.assistantCompleted({
  runId,
  text,
  error: "deepseek unavailable: stream closed during thinking",
  diagnostic: {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    phase: "thinking",
    reason: "transport",
    retryable: true,
    safeToRetry: true,
    detail: "stream closed during thinking before visible output",
    attempt: 3,
    streamed: { thinkingChars: 40, textChars: 0, toolCalls: 0, toolResults: 0 }
  }
});
```

`assistant.reconnecting` SHOULD gain an optional `diagnostic` field for live retry markers. Old clients can continue using `detail`.

Budget-stop completion SHOULD retain `stepLimit` and MAY add:

```ts
stop: {
  cause: "step_backstop" | "context_gate" | "provider_protocol_anomaly";
  steps: number;
  detail: string;
}
```

## State Machine

Provider step state:

```text
idle
  -> streaming              on provider.stream started
streaming
  -> retry_wait             on retryable failure and safe retry
  -> terminal_error         on non-retryable failure
  -> terminal_error         on retryable failure but unsafe retry
  -> protocol_anomaly       on malformed tool-call markup as text
  -> done                   on provider done
retry_wait
  -> streaming              after bounded backoff
protocol_anomaly
  -> streaming              if tools enabled and nudge budget available
  -> done_with_anomaly      if forced final answer or nudge budget spent
done
  -> tool_execution         if typed tool calls exist
  -> final_answer           if no typed tool calls exist
tool_execution
  -> streaming              after tool results commit
```

<!-- D-004 --> A dropped stream after partial output MAY be retried only when the partial is safe: no typed tool calls, no tool results, no visible assistant text, no file mutation, and no other side-effect boundary. Thinking-only partials SHOULD be retried with a retry marker instead of ending as terminal `stream failed`.

## Error Handling

Error code range:

- `DPR-1xx`: provider transport and upstream availability.
- `DPR-2xx`: auth, quota, and rate limits.
- `DPR-3xx`: provider protocol shape and malformed tool output.
- `DPR-4xx`: budget-stop and context diagnostics.
- `DPR-5xx`: observability or diagnostic persistence failures.

Concrete errors:

- `DPR-101 - stream_dropped_before_visible_output`
  - Severity: warning while retries remain, error after retry budget.
  - Recovery: retry if `safeToRetry` is true and attempt budget remains.
  - Escalation: terminal diagnostic after retry budget.

- `DPR-102 - stream_dropped_after_side_effect`
  - Severity: error.
  - Recovery: no automatic retry.
  - Escalation: terminal diagnostic explaining retry was unsafe.

- `DPR-201 - provider_auth_or_quota`
  - Severity: error.
  - Recovery: no retry unless upstream explicitly says transient rate limit.
  - Escalation: `/doctor` provider finding with next action.

- `DPR-301 - malformed_tool_output`
  - Severity: warning if recovered by nudge, error/anomaly if terminal.
  - Recovery: if tools are still enabled, nudge once to use typed tool calls or answer without protocol markup.
  - Escalation: render transcript anomaly block.

- `DPR-401 - budget_stop_without_cause`
  - Severity: warning.
  - Recovery: add typed stop cause and UI copy.
  - Escalation: none.

<!-- D-005 --> DeepSeek output that looks like raw tool-call protocol markup but did not arrive as typed `tool_call` events MUST be classified as a provider protocol anomaly. The host SHOULD nudge once when tools are still enabled. The web SHOULD render terminal leaked markup as an anomaly block rather than ordinary prose.

<!-- D-006 --> Step-budget termination SHOULD carry a typed stop cause that distinguishes the 32-step backstop from context-pressure gating and provider protocol anomalies. The existing `stepLimit` number MUST remain for compatibility.

## Security Considerations

Provider diagnostics cross a trust boundary: they originate from upstream provider errors and model output, then become durable session events. The host MUST sanitize diagnostics before publishing them. Diagnostics MUST NOT include API keys, auth headers, request bodies, full prompt text, full tool result contents, or filesystem data beyond paths already visible in the transcript.

Malformed provider output is untrusted model text. The web MUST continue sanitizing markdown HTML, and any anomaly renderer MUST render protocol snippets as escaped text or structured fields, never as trusted HTML. Provider-specific classifiers MUST avoid turning arbitrary model text into executable tool calls; leaked DSML text is evidence of a malformed provider response, not an instruction to run tools.

Retry policy affects side effects. The loop MUST NOT automatically retry after a tool call, tool result, file mutation, shell command, or visible assistant text has crossed the durable boundary. Thinking-only partial retry is allowed because it does not affect workspace state or user-visible answer content.

## Versioning

This is an additive protocol change. Existing `assistant.completed.error`, `assistant.reconnecting.detail`, `assistant.completed.stepLimit`, `assistant.progress.usage`, and `assistant.progress.breakdown` remain valid.

New fields are OPTIONAL at decode time. Old events without diagnostics decode to `undefined`. New clients SHOULD prefer structured fields when present and fall back to existing string fields when absent.

## Implementation Notes

<!-- D-008 --> `usage.input` from a provider is a reported provider value, not always full prompt context. The host and web SHOULD floor context-used calculations at Trevor's prompt or breakdown estimate when providers underreport cached or billable input.

The first DeepSeek failure in the observed session is a concrete regression fixture candidate:

- `assistant.started` for `deepseek-v4-pro`.
- `assistant.completed` with empty `text`, about 40 thinking chars in breakdown, and `error: "stream failed"`.
- No tool calls, no visible answer text, no side effects.

The DSML leak screenshot is a second fixture candidate:

- Final assistant text contains raw tool-call protocol-like markup.
- Completion carries `stepLimit: 32`.
- The visible UI renders leaked protocol markup as normal text.

## Open Questions

1. Should terminal protocol leaks be hidden from the main answer by default, or shown in a collapsed anomaly block for postmortem inspection?
2. Should DeepSeek-specific classifiers live in a table keyed by provider id, or should each `PiKeyProvider` provide a small classifier hook?
3. Should `/doctor` show only the latest provider incident per provider, or a bounded recent incident list?

## References

### Normative

- [Trevor V2 canonical implementation plan](../trevor-v2/implementation.md) - project scope and dropped routing decisions.
- [Provider adapter](../../apps/agent-host/src/providers/pi-ai.ts) - pi-ai event mapping and generic provider error normalization.
- [Agent loop](../../apps/agent-host/src/agent/loop.ts) - retry, step-budget, recovery, and tool execution behavior.
- [Trevor session protocol](../../packages/session/src/protocol.ts) - shared event constructors and decoders.

### Informative

- [Transcript fold](../../apps/web/src/transcript.ts) - web view model for assistant errors, usage, and progress.
- [Panel host](../../apps/web/src/components/panel/PanelHost.tsx) - current error, no-reply, and step-limit rendering.

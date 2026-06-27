---
number: 01
title: "Adaptive Turn Termination"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-06-27
---

# RFC-01: Adaptive Turn Termination

## Abstract

Trevor's agent loop currently treats a fixed step count as a terminal answer
condition. That was intended as a runaway backstop after D-051/D-053, but the
DeepSeek 1M-context run `opchain-20260626-125838z-34a7fc20` stopped at the
32-step limit while using only about 9% of its context window. This RFC replaces
the universal `n >= MAX_STEPS` completion rule with a typed, adaptive turn
termination policy. The policy separates context pressure, loop health, provider
anomalies, and legacy step limits; publishes a self-describing stop cause; and
requires host, protocol, web, doctor, integration, and end-to-end tests before
the plan is complete.

## Introduction

The original pressure-gate intent was:

1. Context pressure around 80% should make the host synthesize or recover before
   it runs out of window.
2. A fixed step count should only catch runaway loops.
3. Budget exits should be visible instead of silently ending the stream.

The current implementation collapses those concerns. `apps/agent-host/src/agent/loop.ts`
uses `MAX_STEPS = 32` and terminates when either `n >= MAX_STEPS` or the context
pressure gate is crossed. The completion protocol only carries `stepLimit`, and
the web renders this as "answered after the 32-step tool budget". For large-window
models and tool-heavy work, a fixed step limit becomes the everyday governor even
when the turn is still making progress and context pressure is low.

This RFC is in scope for:

- Stop-cause protocol fields on assistant completion events.
- A pure, tested turn termination evaluator in the host.
- Host loop behavior for context pressure, step backstop, loop stalls, provider
  protocol anomalies, and legacy events.
- Web, transcript, `/doctor`, and log surfaces that explain what stopped and what
  the user can do next.
- Regression fixtures for the observed DeepSeek 32-step, 9% context stop.

This RFC is out of scope for:

- Reintroducing the dropped routing engine or model-led routing classification.
- Provider-specific thresholds in the generic loop or React UI.
- A full automatic multi-turn continuation system. This plan can expose a clear
  pause or continuation affordance, but it does not have to invent a new
  background planner.

## Terminology

- **Turn stop cause**: A typed reason for why the host stopped a run or turn. The
  host MUST persist this reason when it can determine one.
- **Context pressure**: Input usage divided by provider context window. When this
  crosses the configured pressure fraction, the host SHOULD synthesize or recover
  because the prompt is close to the model window.
- **Step backstop**: A high, fixed circuit breaker for loop runaway. It MUST NOT
  be treated as evidence that the model answered successfully.
- **Loop stalled**: Repeated tool or provider cycles that show little or no new
  progress. This SHOULD be detected by loop-health signals, not by the raw step
  count alone.
- **Provider protocol anomaly**: A provider output that looks like malformed tool
  protocol, transport corruption, or another provider-boundary incident.
- **Legacy completion**: An older `assistant.completed` event with `stepLimit` but
  no typed stop cause. Readers MUST continue to decode it.
- **Self-documenting policy**: A policy whose types, module comments, doctor
  output, test names, and user-facing copy explain the axes and decisions without
  requiring source archaeology.

## Protocol Overview

The host owns termination policy. Providers report stream events, tool calls,
usage, diagnostics, and errors. The agent loop records state about each step and
asks a pure evaluator whether to continue, synthesize, pause, recover, or fail.
The turn publisher persists the typed stop information in the session log. The
web and doctor surfaces render the persisted data; they do not infer causes from
provider strings or hardcoded step counts.

```text
provider stream
  -> host loop step state
  -> TurnTerminationPolicy.evaluate(state)
  -> loop action: continue | synthesize | pause | recover | fail
  -> assistant.completed { stepLimit?, stop? }
  -> transcript, PanelHost, /doctor, logs
```

The generic loop MUST consume typed provider diagnostics. Provider-specific
classification, such as DeepSeek/pi-ai protocol leak detection, stays at the
provider boundary or diagnostic layer.

## Message Formats

`assistant.completed` keeps its existing shape and adds an optional `stop`
object. `stepLimit` remains for backward compatibility.

```json
{
  "type": "assistant.completed",
  "runId": "2a141752-c743-4bb9-8e5b-83de2e5cbfe8",
  "stepLimit": 32,
  "stop": {
    "cause": "step_backstop",
    "action": "paused",
    "summary": "Paused at the step backstop before context pressure.",
    "steps": 32,
    "context": {
      "inputTokens": 89022,
      "contextWindow": 1000000,
      "pressure": 0.089
    },
    "diagnosticRef": null
  }
}
```

Initial stop causes:

| Cause | Meaning | Expected action |
|---|---|---|
| `answered` | The model produced an ordinary final answer | Complete normally |
| `context_pressure` | Context usage crossed the configured pressure gate | Synthesize or recover |
| `step_backstop` | The high runaway backstop fired without context pressure | Pause and explain |
| `loop_stalled` | The loop repeated with little progress | Pause and explain |
| `provider_protocol_anomaly` | Provider output or stream shape was malformed | Surface diagnostic |
| `overflow` | Context overflow recovery exhausted its budget | Fail visibly |
| `no_reply` | The provider completed without assistant content | Fail or prompt recovery |
| `cancelled` | The user or host cancelled the run | Stop visibly |
| `interrupted` | The host runtime interrupted the stream | Stop visibly |
| `error` | Any other terminal host/provider error | Fail visibly |

The exact shared TypeScript shape SHOULD live in `packages/session/src/protocol.ts`
with comments on every cause.

## State Machine

The policy evaluates a turn as a sequence of loop observations.

```text
running
  -> continue              when progress is healthy and no pressure gate fired
  -> synthesize            when context_pressure fires and synthesis is safe
  -> pause                 when step_backstop or loop_stalled fires at low context
  -> recover               when overflow recovery has a safe remaining rung
  -> fail                  when error, no_reply, unsafe anomaly, or exhausted recovery fires
  -> cancelled/interrupted when external cancellation wins
```

The evaluator MUST consider at least:

- Step count and configured hard ceiling.
- Context input tokens, context window, and pressure fraction.
- Provider usage confidence or fallback estimate.
- Tool call count, tool name repetition, and tool result novelty where available.
- Whether visible assistant text has already streamed.
- Whether any mutating tool has run.
- Provider diagnostic reason, retryability, and phase.
- Elapsed time only as a guardrail, not as the primary completion signal.

The fixed ceiling MAY still exist, but it MUST be labeled and handled as a
circuit breaker. It MUST NOT render as an ordinary final answer at low context.

## Error Handling

The host MUST publish enough stop data to answer "what stopped this turn" after a
page refresh. Error handling follows these precedence rules:

1. User cancellation and host interruption beat all other causes.
2. Terminal provider or tool errors beat budget explanations.
3. Provider protocol anomalies beat generic step backstop when an anomaly is
   observed in the same step.
4. Context pressure beats step backstop when both are true.
5. Loop stalled beats raw step backstop when the stall detector can explain the
   loop pattern.
6. Legacy events with only `stepLimit` decode and render as legacy step budget,
   not as confirmed adaptive policy output.

Recovery behavior MUST be explicit. If the host can synthesize safely, it should
do so. If it cannot, it should pause with a next action instead of pretending that
the model answered.

## Security Considerations

Stop policy must not expose prompt bodies, secrets, command output, or provider
credentials in diagnostic summaries. Provider anomalies may include sanitized
snippets or bounded hashes, but user-visible copy MUST be safe to persist in the
session log. Mutating-tool awareness is required because retrying or continuing
after side effects can duplicate external changes.

Provider-specific classification remains at the provider boundary. React and the
generic loop MUST NOT parse raw provider prose for security-sensitive behavior.

## Versioning

This change is additive. Existing clients and stored sessions continue to decode
because `stepLimit` remains optional and unchanged. New readers MUST handle:

- `assistant.completed` with no `stop` object.
- `assistant.completed` with `stepLimit` only.
- Unknown future `stop.cause` values by rendering a generic stop note.
- Missing context details when a provider did not report usage.

No Richter schema migration is required because Trevor events are payload data in
the durable event log.

## Implementation Notes

The evaluator should be a small pure module, likely
`apps/agent-host/src/agent/turn-policy.ts`, with table-driven tests. The loop
should pass observations into the evaluator rather than spreading stop logic
across stream callbacks. `turn-termination.ts` should become a presentation and
precedence adapter over typed stop causes, not the source of policy truth.

The observed DeepSeek fixture is:

- Session: `opchain-20260626-125838z-34a7fc20`
- Run: `2a141752-c743-4bb9-8e5b-83de2e5cbfe8`
- Completion: `assistant.completed`, `stepLimit: 32`
- Usage: input 89,022, output 18,382, context window 1,000,000
- Pressure: about 8.9%, so the 80% pressure gate correctly did not fire
- Problem: the fixed step backstop ended the run and rendered like a normal
  completed answer

This fixture MUST be represented in tests without live DeepSeek network access.

Self-documentation requirements:

- The shared protocol type comments explain each stop cause.
- The host policy module comment explains policy axes and invariants.
- Test names describe the behavior in user terms.
- `/doctor` and transcript copy show cause and next action.
- The implementation plan notes how this plan relates to the canonical Trevor V2
  plan and the DeepSeek provider diagnostics plan.

## Open Questions

1. Should the first implementation add a dedicated "continue from stop" command,
   or should it only make the paused state explicit and let the user submit a
   follow-up prompt?
2. Which progress signals are reliable enough for the first loop-stalled
   detector: tool result novelty, task list deltas, transcript growth, or a
   narrower repeated-tool heuristic?
3. Should `stepLimit` eventually be renamed in the UI to "step backstop" while
   keeping the wire field for compatibility?

## References

- Normative: `.plans/trevor-v2/implementation.md`, especially context-overflow
  recovery decisions D-034 to D-038 and the dropped routing-engine scope.
- Normative: `.plans/deepseek-provider-reliability/implementation.md`, with this
  plan taking ownership of generic budget-stop causes.
- Normative: `apps/agent-host/src/agent/loop.ts`.
- Normative: `packages/session/src/protocol.ts`.
- Normative: `apps/agent-host/src/turn-termination.ts`.
- Informative: observed DeepSeek session
  `opchain-20260626-125838z-34a7fc20`.

# DeepSeek Provider Reliability and Diagnostics - Progress Report

> Current focus: complete - all current-cutoff milestones done (M0-M9)
> Source plan: [implementation.md](./implementation.md)

## Summary

- Total features: 45
- Completed: 45
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 3
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### Phase 1 - Reproduce and classify

#### M0: Baseline context-meter fix

- [x] Keep the already-applied DeepSeek usage floor so underreported provider input does not move the ctx meter backward

#### M1: Evidence fixtures and characterization tests

- [x] Export or recreate the first DeepSeek stream-failed fixture as a deterministic host test
- [x] Export or recreate the raw DSML-like protocol leak fixture as a deterministic host or web test
- [x] Add a usage fixture where provider input is tiny but breakdown input is large
- [x] Add a regression test proving generic `stream failed` loses phase, detail, retryability, and safety data
- [x] Add a regression test proving the current step-budget footnote lacks a typed stop cause

#### M2: Shared diagnostic schema

- [x] Add protocol tests for optional diagnostic decode on `assistant.completed`
- [x] Add protocol tests for optional diagnostic decode on `assistant.reconnecting`
- [x] Define the shared provider diagnostic, incident reason, and phase types
- [x] Preserve old event compatibility when diagnostics are absent
- [x] Add sanitization coverage for diagnostic detail fields

### Phase 2 - Provider classification and safe retry

#### M3: Provider-boundary classifiers

- [x] Add classifier tests for DeepSeek transport loss
- [x] Add classifier tests for DeepSeek auth, quota, and rate-limit signals
- [x] Add classifier tests for DeepSeek context and unknown errors
- [x] Carry diagnostics through typed provider errors
- [x] Keep provider-specific classifier logic out of the agent loop and web UI

#### M4: Thinking-only partial retry

- [x] Add an agent-loop test where a thinking-only failed first attempt retries and succeeds
- [x] Add unsafe-retry tests for visible text, typed tool calls, tool results, and mutating tool boundaries
- [x] Track streamed partial counters for retry safety
- [x] Emit diagnostic reconnecting markers for safe partial retries
- [x] Extract retry-safety state into a small typed helper

#### M5: Budget-stop causes

- [x] Add protocol tests for optional budget stop cause while preserving `stepLimit`
- [x] Distinguish step backstop from context gate in the loop
- [x] Distinguish provider protocol anomaly as a budget-stop contributor
- [x] Publish stop cause on terminal completion
- [x] Render clearer budget-stop UI copy in the transcript

### Phase 3 - Malformed provider protocol text

#### M6: Protocol-leak detector and host nudge

- [x] Add detector tests for DSML-like tool-call markup
- [x] Add detector negative tests for ordinary XML, HTML, and code snippets
- [x] Detect malformed provider protocol text after a model step with no typed tool calls
- [x] Nudge once when tools are enabled and no unsafe boundary has crossed
- [x] Keep the detector provider-aware without adding provider-specific checks to React

#### M7: Web anomaly rendering

- [x] Add web tests for assistant messages with protocol-anomaly diagnostics
- [x] Fold diagnostics into assistant message view models
- [x] Render provider anomaly alerts with escaped leaked markup
- [x] Keep ordinary assistant markdown rendering unchanged
- [x] Share alert copy only where it reduces real duplication

### Phase 4 - Doctor, logging, and EZE verification

#### M8: Provider incident observability

- [x] Add `/doctor` tests for latest DeepSeek incident and sanitized upstream detail
- [x] Store bounded latest incident state per provider
- [x] Add structured provider-incident logs keyed by runId, provider, model, phase, reason, retryability, and attempt
- [x] Render `/doctor` provider findings for auth/quota, transport, malformed protocol, and unsafe retry
- [x] Verify debug info never includes credentials, prompt bodies, headers, or full tool result contents

#### M9: Verification and regression lane

- [x] Add a hermetic fake-provider e2e or integration test for DeepSeek-style thinking-only retry
- [x] Verify the DSML leak fixture renders as a provider anomaly in web tests
- [x] Verify the first-failure fixture no longer produces bare `stream failed`
- [x] Run lint, typecheck, unit, web, integration, and e2e lanes

## Accepted/Deferred Follow-Up

- [ ] Keep a bounded recent provider incident list in `/doctor` instead of only the latest incident
- [ ] Build a provider incident export command for postmortem sharing
- [ ] Add provider-specific classifiers for GLM and MiniMax if they show distinct failure shapes

# DeepSeek Provider Reliability and Diagnostics - Progress Report

> Current focus: Phase 1 - Reproduce and classify
> Source plan: [implementation.md](./implementation.md)

## Summary

- Total features: 45
- Completed: 1
- Remaining: 44
- Current cutoff blockers: 44
- Accepted/deferred follow-up: 3
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### Phase 1 - Reproduce and classify

#### M0: Baseline context-meter fix

- [x] Keep the already-applied DeepSeek usage floor so underreported provider input does not move the ctx meter backward

#### M1: Evidence fixtures and characterization tests

- [ ] Export or recreate the first DeepSeek stream-failed fixture as a deterministic host test
- [ ] Export or recreate the raw DSML-like protocol leak fixture as a deterministic host or web test
- [ ] Add a usage fixture where provider input is tiny but breakdown input is large
- [ ] Add a regression test proving generic `stream failed` loses phase, detail, retryability, and safety data
- [ ] Add a regression test proving the current step-budget footnote lacks a typed stop cause

#### M2: Shared diagnostic schema

- [ ] Add protocol tests for optional diagnostic decode on `assistant.completed`
- [ ] Add protocol tests for optional diagnostic decode on `assistant.reconnecting`
- [ ] Define the shared provider diagnostic, incident reason, and phase types
- [ ] Preserve old event compatibility when diagnostics are absent
- [ ] Add sanitization coverage for diagnostic detail fields

### Phase 2 - Provider classification and safe retry

#### M3: Provider-boundary classifiers

- [ ] Add classifier tests for DeepSeek transport loss
- [ ] Add classifier tests for DeepSeek auth, quota, and rate-limit signals
- [ ] Add classifier tests for DeepSeek context and unknown errors
- [ ] Carry diagnostics through typed provider errors
- [ ] Keep provider-specific classifier logic out of the agent loop and web UI

#### M4: Thinking-only partial retry

- [ ] Add an agent-loop test where a thinking-only failed first attempt retries and succeeds
- [ ] Add unsafe-retry tests for visible text, typed tool calls, tool results, and mutating tool boundaries
- [ ] Track streamed partial counters for retry safety
- [ ] Emit diagnostic reconnecting markers for safe partial retries
- [ ] Extract retry-safety state into a small typed helper

#### M5: Budget-stop causes

- [ ] Add protocol tests for optional budget stop cause while preserving `stepLimit`
- [ ] Distinguish step backstop from context gate in the loop
- [ ] Distinguish provider protocol anomaly as a budget-stop contributor
- [ ] Publish stop cause on terminal completion
- [ ] Render clearer budget-stop UI copy in the transcript

### Phase 3 - Malformed provider protocol text

#### M6: Protocol-leak detector and host nudge

- [ ] Add detector tests for DSML-like tool-call markup
- [ ] Add detector negative tests for ordinary XML, HTML, and code snippets
- [ ] Detect malformed provider protocol text after a model step with no typed tool calls
- [ ] Nudge once when tools are enabled and no unsafe boundary has crossed
- [ ] Keep the detector provider-aware without adding provider-specific checks to React

#### M7: Web anomaly rendering

- [ ] Add web tests for assistant messages with protocol-anomaly diagnostics
- [ ] Fold diagnostics into assistant message view models
- [ ] Render provider anomaly alerts with escaped leaked markup
- [ ] Keep ordinary assistant markdown rendering unchanged
- [ ] Share alert copy only where it reduces real duplication

### Phase 4 - Doctor, logging, and EZE verification

#### M8: Provider incident observability

- [ ] Add `/doctor` tests for latest DeepSeek incident and sanitized upstream detail
- [ ] Store bounded latest incident state per provider
- [ ] Add structured provider-incident logs keyed by runId, provider, model, phase, reason, retryability, and attempt
- [ ] Render `/doctor` provider findings for auth/quota, transport, malformed protocol, and unsafe retry
- [ ] Verify debug info never includes credentials, prompt bodies, headers, or full tool result contents

#### M9: Verification and regression lane

- [ ] Add a hermetic fake-provider e2e or integration test for DeepSeek-style thinking-only retry
- [ ] Verify the DSML leak fixture renders as a provider anomaly in web tests
- [ ] Verify the first-failure fixture no longer produces bare `stream failed`
- [ ] Run lint, typecheck, unit, web, integration, and e2e lanes

## Accepted/Deferred Follow-Up

- [ ] Keep a bounded recent provider incident list in `/doctor` instead of only the latest incident
- [ ] Build a provider incident export command for postmortem sharing
- [ ] Add provider-specific classifiers for GLM and MiniMax if they show distinct failure shapes

# DeepSeek Provider Reliability and Diagnostics - Implementation Plan

> This is a focused plan for the DeepSeek/pi-ai issues observed on 2026-06-26. <!-- D-003 --> It is subordinate to the canonical Trevor V2 plan at `.plans/trevor-v2/implementation.md`; if they disagree, the canonical plan wins. This plan does not revive the dropped routing engine or model-led routing classification.

## Architecture

Trevor should treat provider incidents as typed runtime data, not as text appended at the end of a turn. The adapter classifies upstream events and errors, the loop decides whether retry is safe, the protocol persists a structured diagnostic, and the web renders that diagnostic without knowing provider-specific strings.

```text
DeepSeek/pi-ai upstream
  -> apps/agent-host/src/providers/pi-ai.ts
  -> provider-specific classifier
  -> ProviderError with diagnostic
  -> apps/agent-host/src/agent/loop.ts safe-retry state
  -> apps/agent-host/src/turn.ts event publication
  -> packages/session/src/protocol.ts decode
  -> apps/web transcript and doctor surfaces
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-003 --> Canonical Trevor V2 plan remains authoritative | This work cannot add routing-engine behavior or model-led classification. |
| <!-- D-001 --> Existing error strings stay compatible | `assistant.completed.error` remains present when a terminal failure occurs. |
| <!-- D-002 --> Provider-specific logic stays at provider boundary | The loop and web consume typed diagnostics instead of matching DeepSeek prose. |
| <!-- D-004 --> Retry must be side-effect safe | Thinking-only partials can retry; visible text, tool calls, tool results, and mutations cannot. |
| <!-- D-008 --> Provider usage can underreport context | Context meters and budget gates need Trevor-owned floors. |

### Boundaries

- `packages/session/src/protocol.ts` owns the shared diagnostic wire shape, optional decode, and event constructors.
- `apps/agent-host/src/providers/error-classifier.ts` owns generic pi-ai classification plus provider-specific classifier dispatch.
- `apps/agent-host/src/providers/pi-ai.ts` owns mapping pi-ai stream events/errors into provider events and diagnostic-bearing provider errors.
- `apps/agent-host/src/agent/loop.ts` owns retry safety, step-budget causes, and malformed protocol-output nudging.
- `apps/agent-host/src/turn.ts` owns publishing diagnostics on completion, reconnecting, progress, and budget stop events.
- `apps/web/src/transcript.ts` owns folding diagnostics into assistant message view models.
- `apps/web/src/components/panel/PanelHost.tsx` owns rendering provider incidents, protocol anomalies, and richer stop-cause notes.

### Observability

<!-- D-007 --> Provider incidents must be observable by `runId` across structured logs, assistant events, `/doctor`, and the transcript UI. Each incident should preserve provider, model, phase, reason, retryability, safe-to-retry verdict, attempt count, sanitized upstream detail, and streamed partial counts. The diagnostic path must be testable without depending on raw stderr.

## Phases

### Phase 1: Reproduce and classify

**Goal:** The DeepSeek failures from the screenshots become deterministic fixtures with failing tests before implementation changes.

**Gate from previous:** None.

#### M0: Baseline context-meter fix

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. GREEN: Keep the already-applied usage floor that clamps reported input to Trevor's prompt or breakdown estimate.
  2. GREEN: Keep `fmtCtx(1_000_000) -> "1M"` because context windows are token counts, not bytes.
  3. REFACTOR: When implementing this plan, centralize the shared chars-per-token estimate if another web caller needs it.

#### M1: Evidence fixtures and characterization tests

- **Dependencies:** M0
- **Effort:** M
- **Tasks:**
  1. RED: Add a host fixture for the first DeepSeek run that streamed thinking-only partial content and ended as generic `stream failed`.
  2. RED: Add a host or web fixture for DeepSeek leaking DSML-like tool-call markup into final text.
  3. RED: Add a usage fixture where DeepSeek reports tiny `usage.input` while breakdown input is large.
  4. RED: Add a test proving the current completion loses provider phase, upstream detail, retryability, and safe-retry state.
  5. RED: Add a web test proving the current step-budget footnote cannot distinguish step backstop, context gate, or provider anomaly.

#### M2: Shared diagnostic schema

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for optional `ProviderDiagnostic` decode on `assistant.completed`.
  2. GREEN: Define `ProviderDiagnostic`, `ProviderIncidentReason`, and `ProviderPhase` in `packages/session`.
  3. GREEN: Add optional `diagnostic` to `assistant.completed` and `assistant.reconnecting` constructors and decoders.
  4. GREEN: Preserve old events with no diagnostic and old clients reading `error`.
  5. REFACTOR: Keep diagnostic sanitization helpers close to protocol or provider boundary, not in React.

### Phase 2: Provider classification and safe retry

**Goal:** DeepSeek failures classify into actionable diagnostics, and thinking-only transport drops retry instead of terminally failing.

**Gate from previous:** Phase 1 tests fail for the intended reasons.

#### M3: Provider-boundary classifiers

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add classifier tests for DeepSeek transport loss, auth/quota/rate-limit text, context errors, and unknown errors.
  2. GREEN: Extend `ProviderUnavailable` / `ProviderAuthError` or adjacent wrapper data to carry diagnostics.
  3. GREEN: Layer DeepSeek-specific rules under the generic pi-ai classifier.
  4. GREEN: Ensure `pi-ai.ts` emits diagnostics without leaking provider conditionals into the loop or web.
  5. REFACTOR: Keep classifier rule ordering explicit so generic auth/context handling stays stable.

#### M4: Thinking-only partial retry

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add an agent-loop test where the first DeepSeek attempt emits thinking only, then fails retryably, and the second attempt succeeds.
  2. RED: Add a loop test proving visible text, tool calls, tool results, and mutating tools make retry unsafe.
  3. GREEN: Track streamed partial counters in `connectStep`.
  4. GREEN: Allow retry after thinking-only partials while emitting a diagnostic `assistant.reconnecting` marker.
  5. REFACTOR: Make safe-retry state a small typed helper instead of boolean drift inside the stream closure.

#### M5: Budget-stop causes

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for optional budget stop cause while preserving `stepLimit`.
  2. GREEN: Distinguish `step_backstop`, `context_gate`, and `provider_protocol_anomaly` in the loop.
  3. GREEN: Publish stop cause on terminal completion.
  4. GREEN: Render a clearer UI note than only `answered after the 32-step tool budget`.
  5. REFACTOR: Keep turn-termination precedence consistent with `turn-termination.ts`.

### Phase 3: Malformed provider protocol text

**Goal:** Raw DSML-like tool-call markup is detected as a provider anomaly, retried/nudged when safe, and never rendered as ordinary prose without explanation.

**Gate from previous:** Diagnostic schema and retry state are available.

#### M6: Protocol-leak detector and host nudge

- **Dependencies:** M3, M4
- **Effort:** M
- **Tasks:**
  1. RED: Add detector tests for DSML-like `<tool_calls>`, `<invoke>`, and parameter markup.
  2. RED: Add negative tests for ordinary XML/HTML/code snippets that should remain prose.
  3. GREEN: Detect malformed provider protocol text after a model step with no typed tool calls.
  4. GREEN: Nudge once when tools are still enabled, asking the model to use typed tool calls or answer without protocol markup.
  5. REFACTOR: Keep the detector provider-aware enough for DeepSeek while generic enough for future pi-ai providers.

#### M7: Web anomaly rendering

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for assistant messages with a protocol-anomaly diagnostic.
  2. GREEN: Fold diagnostics into `AssistantMessage` in `transcript.ts`.
  3. GREEN: Render a provider anomaly alert with escaped leaked markup in a collapsed or bounded block.
  4. GREEN: Keep normal markdown rendering unchanged for ordinary assistant text.
  5. REFACTOR: Share alert copy between terminal error, anomaly, no-reply, and budget-stop surfaces where it reduces duplication.

### Phase 4: Doctor, logging, and EZE verification

**Goal:** Provider incidents are visible after replay, diagnosable from `/doctor`, and covered by end-to-end tests.

**Gate from previous:** Host and web surfaces render diagnostic events.

#### M8: Provider incident observability

- **Dependencies:** M2, M3, M4, M6, M7
- **Effort:** M
- **Tasks:**
  1. RED: Add `/doctor` tests for latest DeepSeek incident and sanitized upstream detail.
  2. GREEN: Store bounded latest incident state per provider in the host.
  3. GREEN: Add structured logs for provider incidents keyed by runId, provider, model, phase, reason, retryability, and attempt.
  4. GREEN: Render `/doctor` provider findings for auth/quota, transport, malformed protocol, and unsafe retry.
  5. REFACTOR: Ensure debug info cannot include credentials or prompt bodies.

#### M9: Verification and regression lane

- **Dependencies:** M8
- **Effort:** S
- **Tasks:**
  1. RED: Add a hermetic e2e or integration test for the DeepSeek-style thinking-only retry with a fake provider.
  2. GREEN: Verify the DSML leak fixture renders as a provider anomaly in jsdom/web tests.
  3. GREEN: Verify the first-failure fixture no longer produces bare `stream failed`.
  4. REFACTOR: Add a short troubleshooting note to the plan or `/doctor` copy only if it prevents future source spelunking.

### Gate 1 -> 2

- [ ] Phase 1 characterization tests fail on current behavior.
- [ ] The fixtures do not depend on live DeepSeek network access.

### Gate 2 -> 3

- [ ] Diagnostics decode and render for old and new events.
- [ ] Safe retry has tests for both allowed and forbidden partial-stream cases.
- [ ] Provider-specific classifiers are isolated from React.

### Gate 3 -> 4

- [ ] DSML-like protocol leaks are detected without catching ordinary code snippets.
- [ ] UI anomaly rendering is escaped and bounded.

### Final Gate

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:web`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:e2e`
- [ ] Manual EZE: reproduce the original DeepSeek failure fixture or a fake-provider equivalent and confirm the transcript explains the incident.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Retrying after partial output duplicates side effects | high | medium | Only retry thinking-only partials and test unsafe boundaries. | agent-host |
| Classifier misses a real DeepSeek error shape | medium | high | Keep unknown fallback diagnostic and add fixtures as incidents appear. | providers |
| Protocol leak detector catches legitimate code/XML | medium | medium | Require tool-call-like markers plus provider/phase context; add negative tests. | agent-host/web |
| Diagnostic includes sensitive upstream data | high | low | Sanitize at provider boundary and test redaction. | providers |
| Web gets provider-specific conditionals | medium | medium | Web consumes typed `reason` and `phase` only. | web |

## Escape Hatches

1. If DeepSeek error shapes are too unstable for provider-specific rules, keep only generic typed diagnostics plus a DeepSeek `unknown` bucket and rely on incident fixtures to expand later.
2. If partial-stream retry proves risky beyond thinking-only partials, keep the retry scope at exactly thinking-only and preserve all other partial failures as terminal diagnostics.
3. If DSML leak detection has false positives, disable host nudging and keep only web anomaly rendering until the detector is precise enough.

## Progress Report Accounting

The progress report for this plan is `.plans/deepseek-provider-reliability/progress-report.md`. It treats only current-cutoff checkboxes as blockers. Deferred follow-up is excluded from current blockers. Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "deepseek-provider-reliability"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:web
pnpm test:integration
pnpm test:e2e
```

## Decisions

Canonical decisions live in `.plans/deepseek-provider-reliability/plan.db`.

- <!-- D-001 --> Provider diagnostic envelope.
- <!-- D-002 --> Provider-specific classification.
- <!-- D-003 --> Scope and canonical plan relationship.
- <!-- D-004 --> Partial-stream retry policy.
- <!-- D-005 --> Malformed provider protocol text.
- <!-- D-006 --> Budget termination diagnostics.
- <!-- D-007 --> Provider observability.
- <!-- D-008 --> Usage semantics.

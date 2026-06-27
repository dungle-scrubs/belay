# Dynamic Turn Budget - Implementation Plan

## Architecture

<!-- D-016 --> Turn budgeting belongs in the agent-host turn policy layer, not in providers and not in the web UI. Providers supply facts; the host decides whether another tool round is justified.

### Current Shape

The current loop has these relevant pieces:

- `apps/agent-host/src/agent/loop.ts` owns the model/tool loop and currently declares `MAX_STEPS = 32`.
- `apps/agent-host/src/agent/turn-policy.ts` evaluates stop conditions from `steps`, `maxSteps`, `inputTokens`, `contextWindow`, `contextBudgetFraction`, and repeated-tool state.
- Providers emit `usage.contextWindow` and `usage.input` per model step.
- The UI renders typed `TurnStop` notes from `assistant.completed`.

### Target Shape

<!-- D-017 --> Add `apps/agent-host/src/agent/turn-budget.ts` as a pure policy helper. It computes:

- `effectiveMaxSteps`: the adaptive budget used by `evaluateTurnTermination`
- `emergencyMaxSteps`: a separate absolute ceiling for invalid telemetry or runaway loops
- `reason`: a short diagnostic string for stop summaries and tests
- `factors`: structured debug facts such as context tier, pressure, repeated-tool penalty, provider kind, reasoning penalty, and telemetry quality

<!-- D-018 --> `loop.ts` should stop passing a static `MAX_STEPS` into `evaluateTurnTermination`. It should compute a `TurnBudget` each step from current facts and pass `budget.effectiveMaxSteps`.

<!-- D-019 --> `turn-policy.ts` should remain pure and should not import providers. It can accept optional budget metadata for clearer debug text, but it should not know the full derivation algorithm.

### Budget Inputs

<!-- D-020 --> The first implementation uses inputs already available inside `runAgent`: provider id, provider kind, model id, reasoning level, step count, latest input tokens, latest context window, repeated tool name, and repeated tool rounds.

<!-- D-021 --> Context window is the strongest scale signal. The initial heuristic should use tiers instead of a provider-specific table:

| Served context window | Base healthy step budget |
|---:|---:|
| unknown or <= 0 | 32 |
| < 32k | 24 |
| 32k to < 128k | 32 |
| 128k to < 512k | 48 |
| 512k to < 1M | 64 |
| >= 1M | 96 |

<!-- D-022 --> Context pressure should shrink the remaining budget as the prompt approaches the context gate. At low pressure the context tier controls; near the gate, context pressure wins.

<!-- D-023 --> Repeated same-tool rounds should reduce budget aggressively after the existing loop-stall threshold starts approaching.

<!-- D-024 --> High reasoning effort should apply a small penalty because each step is slower and more expensive, but it must not collapse large-context work back to 32.

### Observability

<!-- D-025 --> Every typed stop caused by an adaptive budget should include enough context to explain the decision: steps used, effective budget, context pressure, context window, repeated-tool rounds, and the policy reason.

<!-- D-026 --> Debug logs should include structured budget factors under the existing provider or agent debug scope so a postmortem can distinguish "healthy large-context budget exhausted" from "telemetry missing fallback".

### Boundaries

<!-- D-027 --> No web UI component computes budget. The UI only renders stop data and diagnostics emitted by the host.

<!-- D-028 --> Provider descriptors do not need a new schema field in Phase 1. The served context window from usage is enough to remove the static 32-step cap for large-context models.

## Phases

### Phase 1: Pure Budget Policy

**Goal:** A pure function derives model-aware step budgets from existing facts.

#### M1: Budget Derivation Module

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add `turn-budget.test.ts` cases for unknown context, small context, 128k, 512k, and 1M context tiers.
  2. GREEN: Implement `deriveTurnBudget` in `turn-budget.ts`.
  3. RED: Add tests for context pressure shrinking budget near the gate.
  4. GREEN: Add pressure scaling.
  5. RED: Add tests for repeated-tool and high-reasoning penalties.
  6. GREEN: Add penalties while preserving a higher budget for 1M low-pressure turns.
  7. REFACTOR: Keep constants named and documented so the heuristic is easy to tune.

#### M2: Emergency Ceiling Contract

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add tests proving invalid or missing telemetry falls back to a conservative budget and never disables the ceiling.
  2. GREEN: Return both `effectiveMaxSteps` and `emergencyMaxSteps`.
  3. RED: Add tests proving the emergency ceiling is higher than the ordinary fallback but finite.
  4. GREEN: Wire emergency metadata into the budget result.
  5. REFACTOR: Make telemetry-quality classification explicit.

### Gate 1 to 2

- [ ] Budget derivation tests pass.
- [ ] No provider or UI code imports the budget module.
- [ ] The 1M context, low-pressure case produces a budget greater than 32.

### Phase 2: Agent Loop Integration

**Goal:** The model/tool loop uses the derived budget instead of the static 32-step limit.

#### M3: Replace Static `MAX_STEPS` Usage

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Update loop tests so a DeepSeek-like 1M context, low-pressure loop does not pause at 32.
  2. GREEN: Compute `deriveTurnBudget` inside `step(n)` and pass `effectiveMaxSteps` into `evaluateTurnTermination`.
  3. RED: Add a test that unknown context still pauses at the conservative fallback.
  4. GREEN: Preserve fallback behavior for unknown usage.
  5. REFACTOR: Rename `MAX_STEPS` to make any remaining hard cap clearly an emergency ceiling.

#### M4: Preserve Existing Stop Semantics

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add tests proving context pressure still synthesizes before adaptive step budget exhaustion.
  2. GREEN: Keep context pressure precedence in `evaluateTurnTermination`.
  3. RED: Add tests proving repeated-tool stall still pauses before a generous context-derived budget.
  4. GREEN: Preserve repeated-tool stall precedence.
  5. REFACTOR: Keep `turn-policy.ts` focused on stop selection, not budget derivation.

### Gate 2 to 3

- [ ] `apps/agent-host/src/agent/loop.test.ts` covers large-context continuation beyond 32.
- [ ] Existing context-pressure, loop-stall, provider-diagnostic, and empty-reply tests still pass.
- [ ] No hard-coded user-facing "32-step" claim remains except legacy tests or fixtures.

### Phase 3: Diagnostics and UI Clarity

**Goal:** A paused turn explains the adaptive budget decision clearly.

#### M5: Stop Summary and Debug Metadata

- **Dependencies:** M3, M4
- **Effort:** S
- **Tasks:**
  1. RED: Add host tests for stop summaries that mention the effective budget and reason without leaking raw internals.
  2. GREEN: Extend stop summary construction with budget reason and key facts.
  3. RED: Add debug-log or structured-event tests if the existing logging harness supports it.
  4. GREEN: Emit budget factors through the existing debug path.
  5. REFACTOR: Keep public stop text concise and put verbose facts in debug metadata.

#### M6: Web Regression Coverage

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Add or update web transcript tests for the new adaptive stop summary.
  2. GREEN: Render the existing typed stop note without special-casing static wording.
  3. REFACTOR: Avoid adding a new UI panel unless stop text proves insufficient.

### Gate 3 to 4

- [ ] A replayed adaptive pause clearly explains why it paused.
- [ ] The transcript row test does not depend on the old literal "32-step" wording.
- [ ] Debug data can distinguish context-derived budget exhaustion from unknown-telemetry fallback.

### Phase 4: Validation

**Goal:** The new policy is verified against representative provider sizes.

#### M7: Representative Fixture Matrix

- **Dependencies:** M1 through M6
- **Effort:** M
- **Tasks:**
  1. RED: Add fixture tests for small local context, 128k cloud context, and 1M DeepSeek-like context.
  2. GREEN: Ensure each fixture pauses or continues according to policy.
  3. RED: Add a regression test for "1M context at 14% pressure does not stop at 32".
  4. GREEN: Tune the heuristic if needed.
  5. REFACTOR: Document tuning constants in `turn-budget.ts`.

### Final Gate

- [ ] `pnpm --filter @trevor/agent-host test -- loop.test.ts turn-policy.test.ts turn-budget.test.ts`
- [ ] `pnpm --filter @trevor/agent-host typecheck`
- [ ] `pnpm --filter @trevor/web test -- transcript-row-view.test.tsx`
- [ ] `pnpm --filter @trevor/web typecheck`
- [ ] `pnpm biome check` on touched files
- [ ] Pre-commit gate passes before commit

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---:|---|---|
| Adaptive budget allows a bad loop to run too long | high | medium | Keep loop-stall precedence and finite emergency ceiling | agent-host |
| Unknown or incorrect usage telemetry creates unsafe budgets | high | medium | Treat missing telemetry as conservative and log telemetry quality | agent-host |
| Large-context models spend too much time before pausing | medium | medium | Apply reasoning and repeated-tool penalties; tune with fixtures | agent-host |
| Stop summaries become too verbose | low | medium | Keep UI text concise; put structured factors in debug logs | web and host |

## Escape Hatches

1. **If usage telemetry is unreliable:** fall back to the conservative unknown-context budget and log telemetry-quality fallback.
2. **If large-context budgets are too permissive:** lower the top context tier while keeping the derivation model-aware.
3. **If heuristic tuning becomes provider-specific:** add a provider/model budget override table after Phase 1 proves the generic heuristic is insufficient.

## Validation Commands

```bash
pnpm --filter @trevor/agent-host test -- loop.test.ts turn-policy.test.ts turn-budget.test.ts
pnpm --filter @trevor/agent-host typecheck
pnpm --filter @trevor/web test -- transcript-row-view.test.tsx
pnpm --filter @trevor/web typecheck
pnpm biome check apps/agent-host/src/agent/turn-budget.ts apps/agent-host/src/agent/turn-budget.test.ts apps/agent-host/src/agent/loop.ts apps/agent-host/src/agent/loop.test.ts apps/agent-host/src/agent/turn-policy.ts apps/agent-host/src/agent/turn-policy.test.ts apps/web/src/components/chat/transcript-row-view.tsx apps/web/src/components/chat/transcript-row-view.test.tsx
```

## Decisions

Canonical decisions are in `.plans/dynamic-turn-budget/plan.db`. Inline markers in this document reference those decisions.


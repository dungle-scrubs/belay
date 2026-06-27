# Adaptive Turn Termination - Implementation Plan

> This plan is subordinate to the canonical Trevor V2 plan at
> `.plans/trevor-v2/implementation.md`. If they disagree, the canonical plan
> wins. This plan owns generic turn-termination policy; the DeepSeek provider
> reliability plan keeps provider-boundary diagnostics and protocol-leak work.

## Outcome

Trevor should stop turns because a typed policy says what happened, not because
a model happened to use 32 tool rounds. A fixed step ceiling remains as a
runaway circuit breaker, but low-context step backstops pause with diagnostics
instead of rendering as normal answers. Context pressure, loop stalls, provider
protocol anomalies, overflow, no-reply, cancellation, interruption, and ordinary
answers become distinct stop causes across the host, protocol, transcript,
doctor, and tests.

## Decisions

| Decision | Claim |
|---|---|
| D-001 | Stop causes are typed protocol data, not prose inferred by the web. |
| D-002 | Context pressure and loop health are separate axes. Context pressure may synthesize; low-context loop-health stops pause or diagnose. |
| D-003 | `MAX_STEPS` remains only a high circuit breaker. It cannot be the everyday governor or a signal that work is complete. |
| D-004 | The host gets a pure `TurnTerminationPolicy` evaluator with inspectable inputs and deterministic tests. |
| D-005 | `assistant.completed` keeps `stepLimit` for compatibility and adds an optional typed `stop` object. |
| D-006 | Legacy sessions decode and render without migration. Unknown future stop causes render as generic stop notes. |
| D-007 | Provider-specific classification stays at the provider boundary. The generic loop and React UI consume typed diagnostics. |
| D-008 | The policy is self-documenting through protocol comments, module comments, test names, doctor output, and transcript copy. |
| D-009 | The DeepSeek 32-step, 9% context run is a required regression fixture. |
| D-010 | Completion requires lint, typecheck, unit, web, integration, and hermetic e2e gates. |

## Architecture

```text
provider usage/events/errors
  -> agent loop observations
  -> TurnTerminationPolicy.evaluate(observation)
  -> action: continue | synthesize | pause | recover | fail
  -> assistant.completed { stepLimit?, stop? }
  -> transcript fold, PanelHost note, /doctor finding, structured logs
```

The policy module owns decisions. The loop supplies observations and performs the
chosen action. The protocol carries the cause. The web and doctor render the
cause and next action.

### Boundaries

- `packages/session/src/protocol.ts` owns `TurnStopCause`, `TurnStopAction`, and
  the optional `assistant.completed.stop` wire shape.
- `apps/agent-host/src/agent/turn-policy.ts` owns the pure evaluator, policy
  invariants, and debug snapshots.
- `apps/agent-host/src/agent/loop.ts` owns wiring observations into the evaluator
  and performing continue/synthesize/pause/recover/fail actions.
- `apps/agent-host/src/turn.ts` owns publishing typed completion stop data.
- `apps/agent-host/src/turn-termination.ts` owns precedence and display text for
  terminal run summaries.
- `apps/agent-host/src/doctor/*` owns persisted diagnostic summaries and next
  actions.
- `apps/web/src/transcript.ts` owns folding stop data into assistant view models.
- `apps/web/src/components/panel/PanelHost.tsx` owns user-facing transcript notes.

### Initial Stop Causes

| Cause | Host action | User-facing meaning |
|---|---|---|
| `answered` | Complete | The model produced a normal answer. |
| `context_pressure` | Synthesize or recover | The context window is close to full. |
| `step_backstop` | Pause | The high circuit breaker fired before context pressure. |
| `loop_stalled` | Pause | The loop repeated without enough progress. |
| `provider_protocol_anomaly` | Diagnose or fail | Provider output looked malformed or leaked protocol. |
| `overflow` | Recover or fail | Context overflow recovery exhausted its budget. |
| `no_reply` | Fail or prompt recovery | Provider ended with no assistant content. |
| `cancelled` | Stop | User or host cancellation won. |
| `interrupted` | Stop | Runtime interruption won. |
| `error` | Fail | Generic terminal error. |

## Observability

Every non-`answered` stop should be traceable by `runId`. The host should log and
persist:

- `runId`, provider, model, and session id.
- `cause`, `action`, and a bounded summary.
- `steps`, tool rounds, repeated tool names, and whether mutating tools ran.
- `inputTokens`, `contextWindow`, pressure fraction, and usage source.
- Provider diagnostic reason and phase when present.
- Next action, such as continue, reduce context, inspect provider, or retry later.

Diagnostics must not include prompt bodies, secret values, credentials, or full
tool results.

## Phases

### Phase 1: Characterize Current Failure

**Goal:** Current behavior fails targeted tests before policy changes.

#### M1: Session and event fixtures

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add a DeepSeek-like low-context fixture with 32 steps, 89,022 input
     tokens, 1,000,000 context window, and `assistant.completed.stepLimit`.
  2. RED: Add a high-context fixture that crosses the 80% pressure gate in fewer
     steps.
  3. RED: Add a repeated-tool fixture that represents a true loop stall.
  4. RED: Add a legacy completion fixture with `stepLimit` and no `stop` object.
  5. RED: Add a web characterization test showing the current UI cannot
     distinguish these cases.

#### M2: Current host behavior characterization

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Prove the low-context 32-step fixture currently completes as a generic
     step-budget answer.
  2. RED: Prove the context-pressure path has no typed cause.
  3. RED: Prove `turn-termination.ts` can only report `step_limit`.
  4. RED: Prove `/doctor` cannot explain why the run stopped.

### Phase 2: Protocol and Pure Policy

**Goal:** Shared types and a deterministic evaluator exist before the loop is
rewired.

#### M3: Shared stop schema

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for `assistant.completed.stop` decode and encode.
  2. GREEN: Add `TurnStopCause`, `TurnStopAction`, and `TurnStop` schema.
  3. GREEN: Keep `stepLimit` optional and backward compatible.
  4. GREEN: Decode legacy events with no `stop` object.
  5. REFACTOR: Comment each stop cause in the shared protocol source.

#### M4: Pure termination evaluator

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Context pressure returns `context_pressure` and a synthesize action.
  2. RED: Low-context max-step backstop returns `step_backstop` and a pause
     action, not an ordinary answer.
  3. RED: Repeated no-progress tool cycles return `loop_stalled`.
  4. RED: Provider diagnostics can return `provider_protocol_anomaly`.
  5. GREEN: Add debug snapshots that explain the selected cause and rejected
     alternatives.

### Phase 3: Host Loop Integration

**Goal:** The loop uses the policy and publishes typed stop causes.

#### M5: Loop actions

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add loop tests for context-pressure synthesis.
  2. RED: Add loop tests for low-context step backstop pause.
  3. RED: Add loop tests for loop-stalled pause.
  4. GREEN: Replace direct `n >= MAX_STEPS || overContext` termination with the
     evaluator result.
  5. REFACTOR: Keep provider-specific strings out of the generic loop.

#### M6: Completion publication and host diagnostics

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add `turn.ts` tests proving `assistant.completed.stop` is published.
  2. RED: Add `turn-termination.ts` precedence tests for every stop cause.
  3. RED: Add doctor snapshot tests for latest non-answered stop.
  4. GREEN: Add structured logs for stop causes and next action.
  5. REFACTOR: Ensure old `stepLimit`-only events still render deterministically.

### Phase 4: Web and Self-Documentation

**Goal:** The browser and docs make the stop reason understandable after replay.

#### M7: Transcript rendering

- **Dependencies:** M3, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add transcript tests for old `stepLimit` events.
  2. RED: Add transcript tests for every new stop cause used by the host.
  3. RED: Add `PanelHost` tests for context pressure, step backstop, loop stall,
     and provider anomaly copy.
  4. GREEN: Render low-context step backstop as paused or stopped, not normal
     answer completion.
  5. REFACTOR: Keep note rendering bounded so long diagnostics cannot break the
     transcript layout.

#### M8: Self-documenting surfaces

- **Dependencies:** M7
- **Effort:** S
- **Tasks:**
  1. GREEN: Add a module comment to `turn-policy.ts` explaining policy axes.
  2. GREEN: Add comments to shared protocol cause definitions.
  3. GREEN: Add `/doctor` next-action text for step backstop, context pressure,
     loop stall, provider anomaly, and overflow.
  4. GREEN: Update the canonical Trevor V2 plan with a short cross-reference to
     this adaptive termination plan.
  5. GREEN: Keep test names and fixture names tied to the observed user-visible
     behaviors.

### Phase 5: Full Verification

**Goal:** The plan is fully tested by the end with unit, web, integration, and
hermetic e2e coverage.

#### M9: Integration and e2e fixtures

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add a fake-provider integration or e2e run for the DeepSeek-like
     32-step, 9% context case.
  2. RED: Add a fake-provider run for high-context pressure.
  3. RED: Add a provider-anomaly run if the provider diagnostics plan has landed
     the typed diagnostic shape.
  4. GREEN: Verify replay preserves stop cause and UI copy after refresh.
  5. REFACTOR: Keep fixtures hermetic and independent of live DeepSeek.

#### M10: Release gates

- **Dependencies:** M9
- **Effort:** S
- **Tasks:**
  1. GREEN: `pnpm lint`
  2. GREEN: `pnpm typecheck`
  3. GREEN: `pnpm test:unit`
  4. GREEN: `pnpm test:web`
  5. GREEN: `pnpm test:integration`
  6. GREEN: `pnpm test:e2e`
  7. GREEN: Manual EZE replay check for prompt submission, refresh, and stop
     rendering on a local session.

## Completion Criteria

- The low-context 32-step DeepSeek fixture no longer looks like a normal final
  answer.
- The 80% context gate still fires for genuine context pressure.
- Legacy stored sessions render without migration.
- `/doctor` can explain the latest non-answered stop by cause and next action.
- The stop policy is documented in code, tests, protocol comments, and this plan.
- All final gates in M10 pass.

## Deferred Follow-Up

- Automatic multi-turn continuation after a pause.
- Rich UI controls for continue, compress, retry, and cancel beyond the first
  necessary affordance.
- Provider-specific anomaly classifiers for providers beyond DeepSeek/pi-ai.
- Long-term metrics dashboards for stop causes across sessions.

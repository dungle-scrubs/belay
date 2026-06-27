# Tool-Call Guardrails - Implementation Plan

## 0. Hard Dependencies

None.

## Architecture

<!-- D-002 --> Tool-call guardrails are a pure, per-turn controller in `apps/agent-host/src/agent/tool-guardrails.ts`. The controller observes tool calls and results, tracks redacted fingerprints and counts, and returns typed decisions. It does not execute tools, mutate conversation history, publish events, read global config, persist lessons, or decide permissions.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-003 --> No output cache | Store only per-turn fingerprints and counters. Never replay prior tool output or skip execution because a cached result exists. |
| <!-- D-004 --> Same input can change over time | Repeated argument fingerprints are only a signal. No-progress detection requires the same read-only call to return the same result fingerprint repeatedly. |
| <!-- D-001 --> Failures can resolve with the same args | A later success clears the exact-failure state for that tool-call signature. Repeated failures are advisory unless hard stops are explicitly enabled. |
| <!-- D-005 --> Redacted public surface | Events, logs, and UI markers expose tool name, action, count, reason code, and short fingerprints only. Raw args and raw output stay out of telemetry. |

### Boundaries

<!-- D-006 --> Tool purity comes from Trevor's registry, not hardcoded Hermes-style name lists. Use `Tool.readOnly` and the derived read-only registry as the source of truth. Tools omitted from `readOnly` are treated as dynamic or mutating barriers and excluded from same-result no-progress detection by default.

<!-- D-007 --> `runAgent` owns integration. It calls the guardrail before and after tool execution, decides whether to append provider-visible guidance to a tool result, emits any redacted guardrail/progress event, and handles optional synthetic blocked results. The controller only returns data.

### Observability

<!-- D-008 --> Guardrail observability is structured and redacted: decision action (`allow`, `warn`, `block`, `halt`), reason code, tool name, count, args fingerprint, optional result/failure fingerprint, and run id. The UI can show that a tool path is repeating without exposing the underlying command, path, query, or output.

---

## Phases

### Phase 1: Pure Controller

**Goal:** Trevor can classify repeated tool-call patterns in memory without affecting execution.

#### M1: Fingerprints And State

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add unit tests for stable canonical argument hashing with sorted JSON keys and non-object fallback behavior.
  2. GREEN: Implement argument canonicalization and sha256 fingerprint helpers.
  3. RED: Add unit tests proving only fingerprints and counters are stored, not raw args or raw results.
  4. GREEN: Implement the per-turn state shape keyed by tool name plus args fingerprint.
  5. REFACTOR: Keep helper names explicit: `argsFingerprint`, `resultFingerprint`, and `failureFingerprint`, never "cache".

#### M2: Failure Tracking

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add tests for repeated exact failure warnings after the configured threshold.
  2. GREEN: Classify V2 tool failures from the local `error: ...` result convention and track exact failure fingerprints.
  3. RED: Add tests proving a same-args success clears previous exact-failure state.
  4. GREEN: Clear failure state on success and keep same-tool broader failure pressure advisory only.
  5. REFACTOR: Keep failure classification local to the tool boundary instead of scanning transcript prose.

#### M3: Read-Only No-Progress Tracking

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add tests for read-only same-args same-result warning after repeated identical result fingerprints.
  2. GREEN: Track result fingerprints only for read-only tools.
  3. RED: Add tests proving same args with different results does not count as no progress.
  4. GREEN: Reset same-result counts when a result fingerprint changes.
  5. RED: Add tests proving `process`, `bash`, write/edit tools, task tools, and unmarked dynamic tools are excluded from same-result detection.
  6. GREEN: Use registry-derived read-only metadata as the purity source of truth.

### Gate 1 to 2

- [ ] Pure controller unit tests pass.
- [ ] No raw arguments or raw outputs are stored in controller state.
- [ ] Dynamic/mutating tools are excluded from no-progress comparisons.

### Phase 2: Loop Integration

**Goal:** Guardrail decisions become model-visible guidance and inspectable redacted events without changing default tool execution semantics.

#### M4: Warn-First Integration

- **Dependencies:** M1, M2, M3
- **Effort:** M
- **Tasks:**
  1. RED: Add `runAgent` tests proving repeated exact failures append concise guidance to the current tool result.
  2. GREEN: Call the controller after tool execution and append guidance for `warn` decisions.
  3. RED: Add tests proving repeated read-only same-result warnings are appended without suppressing tool execution.
  4. GREEN: Append no-progress guidance that tells the model to use the existing result or change query/strategy.
  5. REFACTOR: Keep guidance text action-oriented and avoid telling the model to stop using tools entirely.

#### M5: Redacted Event Surface

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add host/web protocol tests for a redacted `tool.guardrail` or equivalent progress event.
  2. GREEN: Emit the event with decision action, reason code, count, tool name, and fingerprints only.
  3. RED: Add tests proving raw args and raw output are absent from emitted events.
  4. GREEN: Render the event in the transcript or diagnostics surface without exposing sensitive values.
  5. REFACTOR: Reuse existing turn/run correlation fields instead of inventing a parallel identity scheme.

#### M6: Optional Hard Stops

- **Dependencies:** M4, M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving hard-stop behavior is disabled by default.
  2. GREEN: Add an explicit runtime/config option for synthetic blocked results.
  3. RED: Add tests proving hard stops require repeated same failure/result with no intervening success or different result.
  4. GREEN: Return a synthetic retryable tool result only when hard stops are enabled and thresholds are met.
  5. RED: Add integration tests proving a guarded loop still reaches forced synthesis or a typed terminal reason.
  6. GREEN: Compose hard-stop decisions with the existing turn-termination policy.

### Gate 2 to Done

- [ ] `pnpm test --project unit` passes for guardrail and loop tests.
- [ ] Relevant web/protocol tests pass if the event surface changes.
- [ ] No output cache exists.
- [ ] Existing `loop_stalled`, context-pressure, and step-backstop behavior remains covered.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| False positive blocks a legitimate dynamic retry | high | medium | Exclude non-read-only tools from same-result detection and keep hard stops opt-in. | agent-host |
| Same args recover after transient failure | high | medium | Clear exact failure state on success; warn by default instead of blocking. | agent-host |
| Sensitive args or output leak through telemetry | high | low | Emit fingerprints only and test absence of raw values. | session/web |
| Guidance causes the model to stop using tools entirely | medium | medium | Phrase warnings as change-query/change-strategy guidance, not tool prohibition. | agent-host |

---

## Escape Hatches

1. **If warnings reduce task completion quality:** keep the pure controller and event telemetry, but disable provider-visible guidance by default.
2. **If hard stops prove brittle:** remove the runtime option and keep only warnings plus typed terminal loop diagnostics.
3. **If result fingerprinting is too expensive for large outputs:** hash the already-capped model-facing tool result, not the uncapped raw output.

---

## Validation Commands

```bash
pnpm test --project unit
pnpm test --project web
pnpm typecheck
```

---

## Decisions

Canonical decisions are in `.plans/07-tool-call-guardrails/plan.db`. Key decisions referenced in this document use `<!-- D-NNN -->` markers.

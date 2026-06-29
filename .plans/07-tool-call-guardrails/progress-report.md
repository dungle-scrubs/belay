# Tool-Call Guardrails - Progress Report

## Summary

> Current focus: M4: Warn-First Integration
- Current cutoff blockers: 20 unchecked (19 done)
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### M1: Fingerprints And State

- [x] RED: Add unit tests for stable canonical argument hashing with sorted JSON keys and non-object fallback behavior.
- [x] GREEN: Implement argument canonicalization and sha256 fingerprint helpers.
- [x] RED: Add unit tests proving only fingerprints and counters are stored, not raw args or raw results.
- [x] GREEN: Implement the per-turn state shape keyed by tool name plus args fingerprint.
- [x] REFACTOR: Keep helper names explicit: `argsFingerprint`, `resultFingerprint`, and `failureFingerprint`, never "cache".

### M2: Failure Tracking

- [x] RED: Add tests for repeated exact failure warnings after the configured threshold.
- [x] GREEN: Classify V2 tool failures from the local `error: ...` result convention and track exact failure fingerprints.
- [x] RED: Add tests proving a same-args success clears previous exact-failure state.
- [x] GREEN: Clear failure state on success and keep same-tool broader failure pressure advisory only.
- [x] REFACTOR: Keep failure classification local to the tool boundary instead of scanning transcript prose.

### M3: Read-Only No-Progress Tracking

- [x] RED: Add tests for read-only same-args same-result warning after repeated identical result fingerprints.
- [x] GREEN: Track result fingerprints only for read-only tools.
- [x] RED: Add tests proving same args with different results does not count as no progress.
- [x] GREEN: Reset same-result counts when a result fingerprint changes.
- [x] RED: Add tests proving `process`, `bash`, write/edit tools, task tools, and unmarked dynamic tools are excluded from same-result detection.
- [x] GREEN: Use registry-derived read-only metadata as the purity source of truth.

### Gate 1 to 2

- [x] Pure controller unit tests pass.
- [x] No raw arguments or raw outputs are stored in controller state.
- [x] Dynamic/mutating tools are excluded from no-progress comparisons.

### M4: Warn-First Integration

- [ ] RED: Add `runAgent` tests proving repeated exact failures append concise guidance to the current tool result.
- [ ] GREEN: Call the controller after tool execution and append guidance for `warn` decisions.
- [ ] RED: Add tests proving repeated read-only same-result warnings are appended without suppressing tool execution.
- [ ] GREEN: Append no-progress guidance that tells the model to use the existing result or change query/strategy.
- [ ] REFACTOR: Keep guidance text action-oriented and avoid telling the model to stop using tools entirely.

### M5: Redacted Event Surface

- [ ] RED: Add host/web protocol tests for a redacted `tool.guardrail` or equivalent progress event.
- [ ] GREEN: Emit the event with decision action, reason code, count, tool name, and fingerprints only.
- [ ] RED: Add tests proving raw args and raw output are absent from emitted events.
- [ ] GREEN: Render the event in the transcript or diagnostics surface without exposing sensitive values.
- [ ] REFACTOR: Reuse existing turn/run correlation fields instead of inventing a parallel identity scheme.

### M6: Optional Hard Stops

- [ ] RED: Add tests proving hard-stop behavior is disabled by default.
- [ ] GREEN: Add an explicit runtime/config option for synthetic blocked results.
- [ ] RED: Add tests proving hard stops require repeated same failure/result with no intervening success or different result.
- [ ] GREEN: Return a synthetic retryable tool result only when hard stops are enabled and thresholds are met.
- [ ] RED: Add integration tests proving a guarded loop still reaches forced synthesis or a typed terminal reason.
- [ ] GREEN: Compose hard-stop decisions with the existing turn-termination policy.

### Gate 2 to Done

- [ ] `pnpm test --project unit` passes for guardrail and loop tests.
- [ ] Relevant web/protocol tests pass if the event surface changes.
- [ ] No output cache exists.
- [ ] Existing `loop_stalled`, context-pressure, and step-backstop behavior remains covered.

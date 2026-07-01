# Loop Command Surface - Progress Report

## Summary

> Current focus: M4: confirmation flow (draft->pending->running via protocol events) + loop store
- Current cutoff blockers: 38 unchecked
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### M1: Command Family Contract

- [x] RED: Add unit tests for `/loop` and `/loops` command-family discovery, aliases, examples, and protocol action metadata.
- [x] GREEN: Implement the shared command-family contract with names, aliases, grammar keywords, control verbs, examples, and preview metadata.
- [x] RED: Add tests proving non-web clients can submit explicit command text and receive structured command results without helper UI.
- [x] GREEN: Route explicit command submissions through host-owned command handling.
- [x] REFACTOR: Keep command metadata UI-neutral and free of host-rendered rows, chips, colors, or layouts.

### M2: Parser Grammar

- [x] RED: Add parser tests for creation with optional `new`, runner aliases, optional `durable`, and keywords `max`, `every`, `until`, `timeout`, and `do`.
- [x] GREEN: Implement deterministic parsing for creation commands with parsed fields and token kinds.
- [x] RED: Add parser tests for `/loop list`, `/loops`, `stop`, `pause`, `resume`, `delete`, `run-now`, and provisional `clear`.
- [x] GREEN: Implement control command parsing and stable loop id extraction.
- [x] REFACTOR: Keep the parser pure so web preview and host submit validation can share it.

### M3: Quote, Duration, And Diagnostics

- [x] RED: Add tests for double-quoted spans, single-token unquoted `do` and `until`, escaped quote behavior if supported, and unterminated quote diagnostics.
- [x] GREEN: Implement quote handling and single-token fallback behavior.
- [x] RED: Add tests for compact duration units and retained or rejected bare-number semantics.
- [x] GREEN: Implement duration parsing and normalization.
- [x] RED: Add tests for missing action, missing bound, invalid `max`, invalid duration, empty `until`, empty action, and unknown tokens.
- [x] GREEN: Return structured diagnostics, missing requirements, used/available keywords, and `ready`.
- [x] REFACTOR: Keep diagnostic messages stable enough for tests and UI copy.

### Gate 1 to 2

- [x] Parser unit tests cover creation, controls, quotes, durations, and diagnostics.
- [x] Shared preview output has no UI rendering details.
- [x] Explicit slash-command handling has no model involvement.

### M4: Loop Domain And Lifecycle

- [x] RED: Add host-domain tests for draft/pending confirmation, running, paused, stopped, completed, failed, and deleted states.
- [x] GREEN: Implement the loop domain model, lifecycle transitions, stop reasons, and state guards.
- [x] RED: Add validation tests requiring an action plus `max`, `until`, `every`, or `timeout`.
- [x] GREEN: Enforce bounded recurring work before activation.
- [ ] RED: Add tests for confirm/edit/cancel before activation.
- [ ] GREEN: Implement confirmation flow through structured command/session protocol events.
- [x] REFACTOR: Keep draft validation separate from execution scheduling.

### M5: Runner Execution

- [ ] RED: Add integration tests for current-session prompt loops.
- [ ] GREEN: Execute current-session prompt loop bodies through the ordinary turn/session path.
- [ ] RED: Add integration tests for background-agent prompt loops.
- [ ] GREEN: Execute background prompt loop bodies through the background-agent path without blocking the active session.
- [ ] RED: Add integration tests for process command loops, timeouts, cancellation, and redaction.
- [ ] GREEN: Execute process loop bodies through the existing command/process safety boundary.
- [ ] REFACTOR: Share execution correlation and diagnostics with existing run/process infrastructure.

### M6: Scheduling, Persistence, And Controls

- [ ] RED: Add tests for `every` cadence with exactly one active timer per loop.
- [ ] GREEN: Implement loop scheduling and next-run calculation.
- [ ] RED: Add tests for `run-now`, pause, resume, stop, delete, and list controls.
- [ ] GREEN: Implement control commands and status events.
- [ ] RED: Add restart tests proving durable loops retain last-known status and next-run time.
- [ ] GREEN: Persist durable loop state in the approved Trevor storage root.
- [ ] REFACTOR: Keep transient and durable loop state clearly separated.

### Gate 2 to 3

- [ ] Host loop lifecycle, runner, persistence, and control integration tests pass.
- [ ] Every loop has a visible bound/cadence and explicit controls.
- [ ] Durable loop restart behavior is covered by tests.

### M7: Existing Web Helper Integration

- [ ] RED: Audit existing web loop parser/helper tests and add failing coverage only for missing slash menu, committed helper, or preview states.
- [ ] GREEN: Preserve the existing helper while routing it through the shared command contract/preview output.
- [ ] RED: Add regression tests for existing syntax highlighting, used/available keyword guide, missing-field hints, ready state, and inventory controls if any are story-only.
- [ ] GREEN: Fill only the missing UI behavior around runner/max/every/until/timeout/action/durability rows.
- [ ] RED: Add tests proving inventory controls submit structured command/session protocol events instead of mutating local fixture state.
- [ ] GREEN: Replace fixture-only inventory control behavior with live protocol wiring.
- [ ] REFACTOR: Keep the existing helper accessible and responsive while removing duplicated validation rules from web-only code.

### M8: Evals And End-To-End Coverage

- [ ] RED: Add hermetic e2e coverage for headless create, confirm, list, pause, resume, stop, delete, and run-now flows.
- [ ] GREEN: Make the command/session protocol drive all loop controls without web-only paths.
- [ ] RED: Add e2e coverage for process/current/background runner behavior with fake or hermetic dependencies.
- [ ] GREEN: Stabilize runner behavior and lifecycle events under deterministic test timing.
- [ ] RED: Add evals or prompt tests proving the model does not invent hidden recurring work and points users to explicit `/loop` commands.
- [ ] GREEN: Add prompt guidance for explicit command use and deferred natural-language drafting boundaries.
- [ ] REFACTOR: Keep natural-language draft tests skipped or absent until that deferred layer is intentionally picked up.

### Gate 3 to Done

- [ ] `pnpm test --project unit` passes for parser and domain tests.
- [ ] `pnpm test --project integration` passes for host runtime and persistence tests.
- [ ] `pnpm test --project web` passes for helper behavior.
- [ ] `pnpm test --project e2e` passes for hermetic loop command flows.
- [ ] No natural-language loop creation ships in the first command-surface implementation.

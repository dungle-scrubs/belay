# Loop Command Surface - Implementation Plan

## 0. Hard Dependencies

- [ ] `01-ask-user-tool` - confirmation-gated loop drafts need a reusable user confirmation surface.
- [ ] `03-filesystem-root-taxonomy` - durable loop state uses the approved Trevor storage root.

## Architecture

<!-- D-001 --> `/loop` is a host-owned recurring work feature with a UI-neutral command-family contract, not a Trevor web-only macro. The host owns parsing, validation, confirmation, scheduling, lifecycle, persistence, status events, cancellation, and safety enforcement. Any client that can send command/session-protocol events must be able to create and control loops without the rich Trevor web helper.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-002 --> Authoritative host parse | The web can import the shared parser for live preview, but the host re-parses and validates on submit. |
| <!-- D-003 --> Deterministic slash path | Explicit `/loop` text does not involve a model. Natural-language drafting is a later confirmation-gated layer. |
| <!-- D-004 --> Bounded recurring work | Loop creation requires an action plus at least one deterministic bound or cadence: `max`, `until`, `every`, or `timeout`. |
| <!-- D-005 --> UI-neutral preview | Parser output carries tokens, fields, missing requirements, diagnostics, used/available keywords, examples, and readiness; clients own rendering. |

### Command Contract

<!-- D-006 --> Define `/loop` and `/loops` as one command family with names, aliases, grammar keywords, control verbs, tokenization, diagnostics, examples, preview metadata, and protocol actions. Creation supports optional `new`, runner aliases `current`, `session`, `background`, and `process`, optional `durable`, and the grammar keywords `max`, `every`, `until`, `timeout`, and `do`. Controls include `/loop list`, `/loops`, `/loop stop <id>`, `/loop pause <id>`, `/loop resume <id>`, `/loop delete <id>`, `/loop run-now <id>`, and `/loop clear` only if clear remains useful at implementation time.

<!-- D-007 --> Quote and duration rules are explicit. Double-quoted spans are single values; unquoted `do` and `until` values are single-token only. Durations accept compact units such as `ms`, `s`, `sec`, `m`, `min`, `h`, and `hr`; bare numeric durations default to seconds only if the retained V1 behavior is intentionally kept.

<!-- D-008 --> Validation diagnostics distinguish missing action, missing bound, invalid `max`, invalid duration, empty `until`, empty action, and unknown tokens. The parser returns command mode, token kinds, parsed fields, used keywords, available keywords, missing requirements, diagnostics, and `ready`.

### Runtime Semantics

<!-- D-009 --> Carry forward runner categories for current-session prompt, background-agent prompt, and process command. Loop bodies are prompt text or shell command text. Lifecycle states are draft/pending confirmation, running, paused, stopped, completed, failed, and deleted. Stop reasons include max-iterations, until-satisfied, timeout, cancelled/stopped, and error. Cadence loops have one active timer per loop and support `run-now`.

<!-- D-010 --> Process loops run through the same command/process safety boundary, timeout, cancellation, redaction, status events, and diagnostics as other host command execution. Durable loops survive restart with last-known status and next-run time intact.

### Web Helper

<!-- D-011 --> Trevor web already has most of the rich helper surface: the loop command descriptor and parser live under `apps/web/src/commands`, and the builder, keyword guide, helper, inventory, tests, and stories live under `apps/web/src/components/chat/loop`. The remaining UI work is an audit and integration pass: preserve the existing helper, move/share any contract pieces the host must authoritatively own, wire live protocol data where stories currently use fixtures, and fill only the missing behavior tests. The helper is important UX, but it is not required for other clients.

### Deferred Layer

<!-- D-012 --> Natural-language loop creation is deferred. A later agent tool may identify repeated-work requests and return a structured semantic loop draft, but it must infer only stated fields, compile through the same validator, ask for clarification when action or bound is missing, and require confirm/edit/cancel before activation. It must never start recurring work directly.

### Observability

<!-- D-013 --> Loop observability must expose structured status, lifecycle transitions, stop reasons, runner type, cadence/bound state, next-run time, cancellation, and process-safety diagnostics without leaking redacted process output or hidden prompt text. The UI and logs need enough detail to explain why a loop is pending, running, paused, failed, stopped, or complete.

---

## Phases

### Phase 1: Command Contract And Parser

**Goal:** Trevor can parse, preview, and validate `/loop` commands without executing recurring work.

#### M1: Command Family Contract

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add unit tests for `/loop` and `/loops` command-family discovery, aliases, examples, and protocol action metadata.
  2. GREEN: Implement the shared command-family contract with names, aliases, grammar keywords, control verbs, examples, and preview metadata.
  3. RED: Add tests proving non-web clients can submit explicit command text and receive structured command results without helper UI.
  4. GREEN: Route explicit command submissions through host-owned command handling.
  5. REFACTOR: Keep command metadata UI-neutral and free of host-rendered rows, chips, colors, or layouts.

#### M2: Parser Grammar

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add parser tests for creation with optional `new`, runner aliases, optional `durable`, and keywords `max`, `every`, `until`, `timeout`, and `do`.
  2. GREEN: Implement deterministic parsing for creation commands with parsed fields and token kinds.
  3. RED: Add parser tests for `/loop list`, `/loops`, `stop`, `pause`, `resume`, `delete`, `run-now`, and provisional `clear`.
  4. GREEN: Implement control command parsing and stable loop id extraction.
  5. REFACTOR: Keep the parser pure so web preview and host submit validation can share it.

#### M3: Quote, Duration, And Diagnostics

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for double-quoted spans, single-token unquoted `do` and `until`, escaped quote behavior if supported, and unterminated quote diagnostics.
  2. GREEN: Implement quote handling and single-token fallback behavior.
  3. RED: Add tests for compact duration units and retained or rejected bare-number semantics.
  4. GREEN: Implement duration parsing and normalization.
  5. RED: Add tests for missing action, missing bound, invalid `max`, invalid duration, empty `until`, empty action, and unknown tokens.
  6. GREEN: Return structured diagnostics, missing requirements, used/available keywords, and `ready`.
  7. REFACTOR: Keep diagnostic messages stable enough for tests and UI copy.

### Gate 1 to 2

- [ ] Parser unit tests cover creation, controls, quotes, durations, and diagnostics.
- [ ] Shared preview output has no UI rendering details.
- [ ] Explicit slash-command handling has no model involvement.

### Phase 2: Host Runtime

**Goal:** The host can create, confirm, run, control, persist, and observe bounded loops.

#### M4: Loop Domain And Lifecycle

- **Dependencies:** M1, M2, M3
- **Effort:** L
- **Tasks:**
  1. RED: Add host-domain tests for draft/pending confirmation, running, paused, stopped, completed, failed, and deleted states.
  2. GREEN: Implement the loop domain model, lifecycle transitions, stop reasons, and state guards.
  3. RED: Add validation tests requiring an action plus `max`, `until`, `every`, or `timeout`.
  4. GREEN: Enforce bounded recurring work before activation.
  5. RED: Add tests for confirm/edit/cancel before activation.
  6. GREEN: Implement confirmation flow through structured command/session protocol events.
  7. REFACTOR: Keep draft validation separate from execution scheduling.

#### M5: Runner Execution

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add integration tests for current-session prompt loops.
  2. GREEN: Execute current-session prompt loop bodies through the ordinary turn/session path.
  3. RED: Add integration tests for background-agent prompt loops.
  4. GREEN: Execute background prompt loop bodies through the background-agent path without blocking the active session.
  5. RED: Add integration tests for process command loops, timeouts, cancellation, and redaction.
  6. GREEN: Execute process loop bodies through the existing command/process safety boundary.
  7. REFACTOR: Share execution correlation and diagnostics with existing run/process infrastructure.

#### M6: Scheduling, Persistence, And Controls

- **Dependencies:** M4, M5
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for `every` cadence with exactly one active timer per loop.
  2. GREEN: Implement loop scheduling and next-run calculation.
  3. RED: Add tests for `run-now`, pause, resume, stop, delete, and list controls.
  4. GREEN: Implement control commands and status events.
  5. RED: Add restart tests proving durable loops retain last-known status and next-run time.
  6. GREEN: Persist durable loop state in the approved Trevor storage root.
  7. REFACTOR: Keep transient and durable loop state clearly separated.

### Gate 2 to 3

- [ ] Host loop lifecycle, runner, persistence, and control integration tests pass.
- [ ] Every loop has a visible bound/cadence and explicit controls.
- [ ] Durable loop restart behavior is covered by tests.

### Phase 3: Web Helper And Verification

**Goal:** Trevor web gives a rich helper UI while all capabilities remain protocol-accessible headlessly.

#### M7: Existing Web Helper Integration

- **Dependencies:** M1, M2, M3
- **Effort:** M
- **Tasks:**
  1. RED: Audit existing web loop parser/helper tests and add failing coverage only for missing slash menu, committed helper, or preview states.
  2. GREEN: Preserve the existing helper while routing it through the shared command contract/preview output.
  3. RED: Add regression tests for existing syntax highlighting, used/available keyword guide, missing-field hints, ready state, and inventory controls if any are story-only.
  4. GREEN: Fill only the missing UI behavior around runner/max/every/until/timeout/action/durability rows.
  5. RED: Add tests proving inventory controls submit structured command/session protocol events instead of mutating local fixture state.
  6. GREEN: Replace fixture-only inventory control behavior with live protocol wiring.
  7. REFACTOR: Keep the existing helper accessible and responsive while removing duplicated validation rules from web-only code.

#### M8: Evals And End-To-End Coverage

- **Dependencies:** M4, M5, M6, M7
- **Effort:** L
- **Tasks:**
  1. RED: Add hermetic e2e coverage for headless create, confirm, list, pause, resume, stop, delete, and run-now flows.
  2. GREEN: Make the command/session protocol drive all loop controls without web-only paths.
  3. RED: Add e2e coverage for process/current/background runner behavior with fake or hermetic dependencies.
  4. GREEN: Stabilize runner behavior and lifecycle events under deterministic test timing.
  5. RED: Add evals or prompt tests proving the model does not invent hidden recurring work and points users to explicit `/loop` commands.
  6. GREEN: Add prompt guidance for explicit command use and deferred natural-language drafting boundaries.
  7. REFACTOR: Keep natural-language draft tests skipped or absent until that deferred layer is intentionally picked up.

### Gate 3 to Done

- [ ] `pnpm test --project unit` passes for parser and domain tests.
- [ ] `pnpm test --project integration` passes for host runtime and persistence tests.
- [ ] `pnpm test --project web` passes for helper behavior.
- [ ] `pnpm test --project e2e` passes for hermetic loop command flows.
- [ ] No natural-language loop creation ships in the first command-surface implementation.

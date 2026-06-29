# Hooks Runtime - Implementation Plan

## 0. Hard Dependencies

- [ ] `01-ask-user-tool` - project/user hook approval requires an explicit user approval surface before trusted execution.
- [ ] `03-filesystem-root-taxonomy` - hook trust/approval state uses the approved Trevor config/state roots.

## Architecture

Hooks are a narrow host-owned command-hook runtime at explicit lifecycle boundaries. They are not a plugin system, not a routing mechanism, and not a hidden mutation layer. <!-- D-001 --> The first cut exposes exactly two hook events: `PreToolUse` before a tool executes and `Stop` before a run finalizes a terminal assistant result. <!-- D-002 -->

Hook handlers are command handlers with explicit `args` arrays, low default timeouts, bounded stdout/stderr, secret redaction, and trust hashes. <!-- D-005 --><!-- D-006 --> Hook failures are observable but non-blocking unless a hook explicitly returns a blocking decision. <!-- D-007 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Narrow lifecycle scope | First cut is `PreToolUse` and `Stop` only. <!-- D-002 --> |
| Command handlers only | Hooks execute configured commands with `args` arrays and no shell splitting by default. <!-- D-005 --> |
| Explicit trust | Project/user hooks require approval using sha256 trust hashes over normalized config and local script contents. <!-- D-006 --> |
| Non-blocking by default | Command failure, invalid JSON, and timeout are diagnostics unless the hook returns an explicit blocking decision. <!-- D-007 --> |
| No broad plugin surface | Excludes `PostToolUse`, native extensions, routing hooks, long-running daemons, arbitrary plugin APIs, hidden mutation, and default shell splitting. <!-- D-008 --> |
| Visible diagnostics | Decisions, trust state, missing scripts, slow handlers, timeouts, and migration findings surface through events and Doctor. <!-- D-009 --> |

### Hook Semantics

#### PreToolUse

`PreToolUse` fires before a tool executes. Its payload includes session id, run id, turn id, cwd, caller kind, tool name, tool input, and tool metadata.

It can return:

- `allow`
- `deny`
- `halt`
- bounded `context`
- narrowly scoped `updatedInput` for explicitly supported tool-input fields only

`updatedInput` must never rewrite hidden state or bypass tool validation. <!-- D-003 -->

#### Stop

`Stop` fires before final assistant completion. Its payload includes session id, run id, turn id, cwd, terminal reason, final assistant text, and a compact tool/change summary when available.

It can return:

- allow completion
- halt completion with a user-visible reason
- bounded context requesting at most one continuation or synthesis pass

It cannot mutate files, rewrite prior events, apply tools directly, or create unbounded continuation loops. <!-- D-004 -->

### Boundaries

Owned by this plan:

- hook config discovery across supported roots
- trust hashing and approval state
- command execution harness with timeout/output caps/redaction
- `PreToolUse` decision enforcement
- `Stop` decision enforcement and one-pass continuation
- visible events, transcript markers, and Doctor diagnostics
- migration diagnostics for legacy executable `HOOK.md`

Not owned by this plan:

- `PostToolUse`
- model-routing hooks
- native extension dispatch
- arbitrary plugin APIs
- long-running hook daemons
- hidden file mutation
- command-file shell interpolation beyond explicit hook command execution

### Observability

Hooks are policy and context machinery, so they must be auditable:

- emit visible hook events for allow/deny/halt/context/update/timeout/error decisions
- record redacted structured logs for handler execution, duration, exit status, timeout, invalid JSON, and trust state
- Doctor reports configured hooks, missing scripts, changed trust hashes, unapproved hooks, slow handlers, repeated timeouts, and legacy `HOOK.md` migration findings <!-- D-009 -->

## Phases

### Phase 1: Contract and Discovery

**Goal:** Trevor has a stable hook config model, discovery order, trust model, and event contracts before execution is wired into turns.

**Gate from previous:** none.

#### M1: Hook Config and Discovery

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add config schema tests for `PreToolUse` and `Stop` hook definitions.
  2. GREEN: Define hook config with handler id, event type, command, args array, timeout, enabled state, and scope. <!-- D-005 -->
  3. RED: Add tests for local/project/user/shared discovery order and disabled/malformed entries.
  4. GREEN: Implement bounded config discovery with clear source provenance. <!-- D-001 -->
  5. RED: Add tests proving unknown hook event types are rejected or ignored with diagnostics.
  6. GREEN: Accept only `PreToolUse` and `Stop` in the first cut. <!-- D-002 -->
  7. REFACTOR: Keep discovery separate from execution and decision enforcement.

#### M2: Trust Hashes and Approval State

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add trust-hash tests over normalized config plus referenced local script contents.
  2. GREEN: Compute stable sha256 trust hashes for executable hook definitions. <!-- D-006 -->
  3. RED: Add tests for changed config, changed script contents, missing scripts, and unapproved hooks.
  4. GREEN: Store approval state in the Trevor config/state root chosen by existing storage taxonomy.
  5. RED: Add tests proving project/user hooks never execute before approval.
  6. GREEN: Gate execution on approval while still reporting diagnostics. <!-- D-006 -->
  7. REFACTOR: Keep trust storage inspectable and path-redacted in logs.

### Gate 1 -> 2

- [ ] Hook config schema accepts only first-cut event types.
- [ ] Discovery is deterministic and source-attributed.
- [ ] Trust hashes change when config or referenced scripts change.
- [ ] Unapproved hooks do not execute.

### Phase 2: Command Execution Harness

**Goal:** Hook commands run safely with deterministic input/output boundaries and redaction.

**Gate from previous:** Gate 1 passes.

#### M3: Handler Execution and Output Contract

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add command execution tests for `args` arrays without shell splitting.
  2. GREEN: Implement the hook command runner with explicit executable plus args. <!-- D-005 -->
  3. RED: Add timeout tests using fake time or controllable child processes.
  4. GREEN: Enforce low default timeouts and per-hook timeout overrides within safe bounds.
  5. RED: Add stdout/stderr cap tests and invalid JSON tests.
  6. GREEN: Cap stdout/stderr and parse structured hook decisions from JSON output.
  7. RED: Add secret-redaction tests for env-like values, auth headers, tokens, and paths.
  8. GREEN: Redact sensitive output in logs, events, and Doctor details. <!-- D-009 -->

#### M4: Failure and Diagnostic Semantics

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add tests proving command failure, invalid JSON, and timeout are non-blocking by default.
  2. GREEN: Convert failures into diagnostic hook results without failing the user turn. <!-- D-007 -->
  3. RED: Add tests proving explicit deny/halt decisions still block.
  4. GREEN: Preserve explicit blocking decisions from successful hook outputs. <!-- D-007 -->
  5. RED: Add tests for repeated timeout and slow-handler counters.
  6. GREEN: Track slow/repeated failures for Doctor diagnostics.
  7. REFACTOR: Keep runtime errors typed and observable.

### Gate 2 -> 3

- [ ] Hook commands run with explicit args and no implicit shell splitting.
- [ ] Timeouts and output caps are enforced.
- [ ] Secrets are redacted from logs/events/Doctor.
- [ ] Failures are non-blocking unless the hook explicitly blocks.

### Phase 3: PreToolUse Enforcement

**Goal:** `PreToolUse` hooks can inspect and narrowly influence tool execution before a tool runs.

**Gate from previous:** Gate 2 passes.

#### M5: PreToolUse Payload and Decisions

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add loop/tool-executor tests proving `PreToolUse` receives session/run/turn ids, cwd, caller kind, tool name, tool input, and metadata.
  2. GREEN: Build the `PreToolUse` payload at the tool boundary. <!-- D-003 -->
  3. RED: Add allow tests proving normal tool execution proceeds unchanged.
  4. GREEN: Wire `allow` as a transparent pass-through.
  5. RED: Add deny tests proving tool execution is skipped and the model receives a clear denied result.
  6. GREEN: Implement `deny` as visible, model-facing tool denial without executing the tool.
  7. RED: Add halt tests proving the turn stops with a visible reason.
  8. GREEN: Implement `halt` as a terminal hook decision.

#### M6: Context and Updated Input

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for bounded context injection before a tool executes.
  2. GREEN: Allow `PreToolUse` to add bounded context to the tool result or immediate model context. <!-- D-003 -->
  3. RED: Add tests for supported `updatedInput` fields on explicitly allowed tools.
  4. GREEN: Apply `updatedInput` only for supported fields before normal tool validation. <!-- D-003 -->
  5. RED: Add tests proving hidden state, unsupported fields, and validation bypass attempts are rejected.
  6. GREEN: Reject unsupported input rewrites and emit diagnostics.
  7. REFACTOR: Keep input update policy tool-specific and reviewable.

### Gate 3 -> 4

- [ ] `PreToolUse` runs before eligible tool execution.
- [ ] Allow, deny, and halt decisions are enforced.
- [ ] Context additions are bounded.
- [ ] Input updates cannot bypass validation or rewrite hidden state.

### Phase 4: Stop Hook and Continuation

**Goal:** `Stop` hooks can review finalization and request at most one continuation/synthesis pass.

**Gate from previous:** Gate 3 passes.

#### M7: Stop Payload and Finalization Decisions

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add turn tests proving `Stop` receives terminal reason, final assistant text, cwd, ids, and compact tool/change summary.
  2. GREEN: Build and dispatch `Stop` payload before final completion. <!-- D-004 -->
  3. RED: Add allow tests proving completion proceeds unchanged.
  4. GREEN: Wire allow as transparent finalization.
  5. RED: Add halt tests proving completion is blocked with a visible reason.
  6. GREEN: Implement halt as a visible terminal hook outcome.
  7. REFACTOR: Keep Stop result handling separate from provider/tool execution.

#### M8: One-Pass Continuation

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for a Stop hook returning bounded context requesting continuation.
  2. GREEN: Run at most one continuation/synthesis pass with tools constrained as appropriate. <!-- D-004 -->
  3. RED: Add tests proving a second Stop continuation request is ignored or rejected.
  4. GREEN: Enforce a hard one-continuation budget.
  5. RED: Add tests proving Stop cannot mutate files, rewrite prior events, or apply tools directly.
  6. GREEN: Keep Stop continuation as model context only, never direct mutation.
  7. REFACTOR: Record continuation reason in visible events and diagnostics.

### Gate 4 -> 5

- [ ] `Stop` runs before final assistant completion.
- [ ] Stop allow/halt/continue decisions are enforced.
- [ ] Continuation is bounded to at most one pass.
- [ ] Stop hooks cannot mutate files or rewrite events.

### Phase 5: Visibility, Doctor, and Verification

**Goal:** Hooks are inspectable, diagnosable, and covered by tests/e2e before being considered ready.

**Gate from previous:** Gate 4 passes.

#### M9: Events, Transcript, and Doctor

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for visible hook decision events.
  2. GREEN: Emit hook events for allow, deny, halt, context, updated-input, timeout, error, unapproved, and trust-changed states. <!-- D-009 -->
  3. RED: Add transcript/web tests for denied/halted hook decisions.
  4. GREEN: Render visible hook status without dumping secrets.
  5. RED: Add Doctor tests for configured hooks, missing handlers, missing scripts, changed trust hashes, slow handlers, repeated timeouts, unapproved hooks, and legacy `HOOK.md`.
  6. GREEN: Wire hook diagnostics into Doctor's hooks area. <!-- D-009 -->
  7. REFACTOR: Keep default Doctor output concise with full/detail escape hatches.

#### M10: Exclusions and Full Verification

- **Dependencies:** M9
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving `PostToolUse`, native extension dispatch, model-routing hooks, long-running daemons, arbitrary plugin APIs, hidden mutation, and default shell splitting are unavailable. <!-- D-008 -->
  2. GREEN: Keep excluded surfaces absent from schemas, discovery, prompt guidance, and runtime.
  3. RED: Add migration tests for legacy executable `HOOK.md` diagnostics without execution.
  4. GREEN: Report legacy migration guidance through Doctor.
  5. GREEN: Run host unit tests, protocol tests, web tests, integration tests, lint, typecheck, and hermetic e2e.
  6. GREEN: Manual EZE repro: approve a project hook, deny one tool, allow another, halt one final answer, and verify Doctor/trust diagnostics.
  7. REFACTOR: Record exact verification commands and any accepted follow-up.

### Done Gate

- [ ] Only `PreToolUse` and `Stop` hooks exist.
- [ ] Hooks execute through trusted command handlers with args arrays.
- [ ] Deny/halt/continue decisions work and are visible.
- [ ] Failure and timeout behavior is observable and non-blocking by default.
- [ ] Doctor diagnostics cover hooks accurately.
- [ ] Excluded broad plugin surfaces remain absent.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Hooks become an unreviewed plugin API | high | medium | Keep schemas limited to `PreToolUse` and `Stop`; test excluded surfaces are absent. <!-- D-008 --> | implementer |
| Hook commands leak secrets | high | medium | Redact stdout/stderr/logs/events/Doctor and cap outputs. <!-- D-009 --> | implementer |
| Changed local scripts run silently | high | medium | Require approval and trust hashes over config plus script contents. <!-- D-006 --> | implementer |
| Hook failures make turns flaky | medium | medium | Treat failures/timeouts as non-blocking diagnostics unless explicit blocking decision exists. <!-- D-007 --> | implementer |
| `updatedInput` bypasses validation | high | low | Apply only supported fields before normal validation and reject hidden/unsupported changes. <!-- D-003 --> | implementer |
| Stop continuation loops | high | low | Enforce at most one continuation/synthesis pass. <!-- D-004 --> | implementer |

## Escape Hatches

1. **If trust UX is not ready:** discovery can report unapproved hooks through Doctor while execution remains disabled.
2. **If `updatedInput` is risky:** ship `PreToolUse` with allow/deny/halt/context first and defer input updates.
3. **If Stop continuation is too invasive:** ship Stop allow/halt first and keep continuation as a follow-up decision.

## Progress Report Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "25-hooks-runtime"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test -- --project unit
pnpm test -- --project integration
pnpm test -- --project web
pnpm test -- --project e2e
```

## Decisions

Canonical decisions are in `.plans/25-hooks-runtime/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "25-hooks-runtime"
```

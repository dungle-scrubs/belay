# Hooks Runtime - Progress Report

## Summary

- Current focus: M1 - Hook Config and Discovery
- Current cutoff blockers: 94
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 0

## Current Cutoff Blockers

### Phase 1: Contract and Discovery

#### M1: Hook Config and Discovery

- [ ] RED: Add config schema tests for `PreToolUse` and `Stop` hook definitions.
- [ ] GREEN: Define hook config with handler id, event type, command, args array, timeout, enabled state, and scope.
- [ ] RED: Add tests for local/project/user/shared discovery order and disabled/malformed entries.
- [ ] GREEN: Implement bounded config discovery with clear source provenance.
- [ ] RED: Add tests proving unknown hook event types are rejected or ignored with diagnostics.
- [ ] GREEN: Accept only `PreToolUse` and `Stop` in the first cut.
- [ ] REFACTOR: Keep discovery separate from execution and decision enforcement.

#### M2: Trust Hashes and Approval State

- [ ] RED: Add trust-hash tests over normalized config plus referenced local script contents.
- [ ] GREEN: Compute stable sha256 trust hashes for executable hook definitions.
- [ ] RED: Add tests for changed config, changed script contents, missing scripts, and unapproved hooks.
- [ ] GREEN: Store approval state in the Trevor config/state root chosen by existing storage taxonomy.
- [ ] RED: Add tests proving project/user hooks never execute before approval.
- [ ] GREEN: Gate execution on approval while still reporting diagnostics.
- [ ] REFACTOR: Keep trust storage inspectable and path-redacted in logs.

### Gate 1 -> 2

- [ ] Hook config schema accepts only first-cut event types.
- [ ] Discovery is deterministic and source-attributed.
- [ ] Trust hashes change when config or referenced scripts change.
- [ ] Unapproved hooks do not execute.

### Phase 2: Command Execution Harness

#### M3: Handler Execution and Output Contract

- [ ] RED: Add command execution tests for `args` arrays without shell splitting.
- [ ] GREEN: Implement the hook command runner with explicit executable plus args.
- [ ] RED: Add timeout tests using fake time or controllable child processes.
- [ ] GREEN: Enforce low default timeouts and per-hook timeout overrides within safe bounds.
- [ ] RED: Add stdout/stderr cap tests and invalid JSON tests.
- [ ] GREEN: Cap stdout/stderr and parse structured hook decisions from JSON output.
- [ ] RED: Add secret-redaction tests for env-like values, auth headers, tokens, and paths.
- [ ] GREEN: Redact sensitive output in logs, events, and Doctor details.

#### M4: Failure and Diagnostic Semantics

- [ ] RED: Add tests proving command failure, invalid JSON, and timeout are non-blocking by default.
- [ ] GREEN: Convert failures into diagnostic hook results without failing the user turn.
- [ ] RED: Add tests proving explicit deny/halt decisions still block.
- [ ] GREEN: Preserve explicit blocking decisions from successful hook outputs.
- [ ] RED: Add tests for repeated timeout and slow-handler counters.
- [ ] GREEN: Track slow/repeated failures for Doctor diagnostics.
- [ ] REFACTOR: Keep runtime errors typed and observable.

### Gate 2 -> 3

- [ ] Hook commands run with explicit args and no implicit shell splitting.
- [ ] Timeouts and output caps are enforced.
- [ ] Secrets are redacted from logs/events/Doctor.
- [ ] Failures are non-blocking unless the hook explicitly blocks.

### Phase 3: PreToolUse Enforcement

#### M5: PreToolUse Payload and Decisions

- [ ] RED: Add loop/tool-executor tests proving `PreToolUse` receives session/run/turn ids, cwd, caller kind, tool name, tool input, and metadata.
- [ ] GREEN: Build the `PreToolUse` payload at the tool boundary.
- [ ] RED: Add allow tests proving normal tool execution proceeds unchanged.
- [ ] GREEN: Wire `allow` as a transparent pass-through.
- [ ] RED: Add deny tests proving tool execution is skipped and the model receives a clear denied result.
- [ ] GREEN: Implement `deny` as visible, model-facing tool denial without executing the tool.
- [ ] RED: Add halt tests proving the turn stops with a visible reason.
- [ ] GREEN: Implement `halt` as a terminal hook decision.

#### M6: Context and Updated Input

- [ ] RED: Add tests for bounded context injection before a tool executes.
- [ ] GREEN: Allow `PreToolUse` to add bounded context to the tool result or immediate model context.
- [ ] RED: Add tests for supported `updatedInput` fields on explicitly allowed tools.
- [ ] GREEN: Apply `updatedInput` only for supported fields before normal tool validation.
- [ ] RED: Add tests proving hidden state, unsupported fields, and validation bypass attempts are rejected.
- [ ] GREEN: Reject unsupported input rewrites and emit diagnostics.
- [ ] REFACTOR: Keep input update policy tool-specific and reviewable.

### Gate 3 -> 4

- [ ] `PreToolUse` runs before eligible tool execution.
- [ ] Allow, deny, and halt decisions are enforced.
- [ ] Context additions are bounded.
- [ ] Input updates cannot bypass validation or rewrite hidden state.

### Phase 4: Stop Hook and Continuation

#### M7: Stop Payload and Finalization Decisions

- [ ] RED: Add turn tests proving `Stop` receives terminal reason, final assistant text, cwd, ids, and compact tool/change summary.
- [ ] GREEN: Build and dispatch `Stop` payload before final completion.
- [ ] RED: Add allow tests proving completion proceeds unchanged.
- [ ] GREEN: Wire allow as transparent finalization.
- [ ] RED: Add halt tests proving completion is blocked with a visible reason.
- [ ] GREEN: Implement halt as a visible terminal hook outcome.
- [ ] REFACTOR: Keep Stop result handling separate from provider/tool execution.

#### M8: One-Pass Continuation

- [ ] RED: Add tests for a Stop hook returning bounded context requesting continuation.
- [ ] GREEN: Run at most one continuation/synthesis pass with tools constrained as appropriate.
- [ ] RED: Add tests proving a second Stop continuation request is ignored or rejected.
- [ ] GREEN: Enforce a hard one-continuation budget.
- [ ] RED: Add tests proving Stop cannot mutate files, rewrite prior events, or apply tools directly.
- [ ] GREEN: Keep Stop continuation as model context only, never direct mutation.
- [ ] REFACTOR: Record continuation reason in visible events and diagnostics.

### Gate 4 -> 5

- [ ] `Stop` runs before final assistant completion.
- [ ] Stop allow/halt/continue decisions are enforced.
- [ ] Continuation is bounded to at most one pass.
- [ ] Stop hooks cannot mutate files or rewrite events.

### Phase 5: Visibility, Doctor, and Verification

#### M9: Events, Transcript, and Doctor

- [ ] RED: Add protocol tests for visible hook decision events.
- [ ] GREEN: Emit hook events for allow, deny, halt, context, updated-input, timeout, error, unapproved, and trust-changed states.
- [ ] RED: Add transcript/web tests for denied/halted hook decisions.
- [ ] GREEN: Render visible hook status without dumping secrets.
- [ ] RED: Add Doctor tests for configured hooks, missing handlers, missing scripts, changed trust hashes, slow handlers, repeated timeouts, unapproved hooks, and legacy `HOOK.md`.
- [ ] GREEN: Wire hook diagnostics into Doctor's hooks area.
- [ ] REFACTOR: Keep default Doctor output concise with full/detail escape hatches.

#### M10: Exclusions and Full Verification

- [ ] RED: Add tests proving `PostToolUse`, native extension dispatch, model-routing hooks, long-running daemons, arbitrary plugin APIs, hidden mutation, and default shell splitting are unavailable.
- [ ] GREEN: Keep excluded surfaces absent from schemas, discovery, prompt guidance, and runtime.
- [ ] RED: Add migration tests for legacy executable `HOOK.md` diagnostics without execution.
- [ ] GREEN: Report legacy migration guidance through Doctor.
- [ ] GREEN: Run host unit tests, protocol tests, web tests, integration tests, lint, typecheck, and hermetic e2e.
- [ ] GREEN: Manual EZE repro: approve a project hook, deny one tool, allow another, halt one final answer, and verify Doctor/trust diagnostics.
- [ ] REFACTOR: Record exact verification commands and any accepted follow-up.

### Done Gate

- [ ] Only `PreToolUse` and `Stop` hooks exist.
- [ ] Hooks execute through trusted command handlers with args arrays.
- [ ] Deny/halt/continue decisions work and are visible.
- [ ] Failure and timeout behavior is observable and non-blocking by default.
- [ ] Doctor diagnostics cover hooks accurately.
- [ ] Excluded broad plugin surfaces remain absent.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

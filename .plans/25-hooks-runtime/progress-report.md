# Hooks Runtime - Progress Report

## Summary

- Current focus: complete - all milestones done
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 94

## Current Cutoff Blockers

### Phase 1: Contract and Discovery

#### M1: Hook Config and Discovery

- [x] RED: Add config schema tests for `PreToolUse` and `Stop` hook definitions.
- [x] GREEN: Define hook config with handler id, event type, command, args array, timeout, enabled state, and scope.
- [x] RED: Add tests for local/project/user/shared discovery order and disabled/malformed entries.
- [x] GREEN: Implement bounded config discovery with clear source provenance.
- [x] RED: Add tests proving unknown hook event types are rejected or ignored with diagnostics.
- [x] GREEN: Accept only `PreToolUse` and `Stop` in the first cut.
- [x] REFACTOR: Keep discovery separate from execution and decision enforcement.

#### M2: Trust Hashes and Approval State

- [x] RED: Add trust-hash tests over normalized config plus referenced local script contents.
- [x] GREEN: Compute stable sha256 trust hashes for executable hook definitions.
- [x] RED: Add tests for changed config, changed script contents, missing scripts, and unapproved hooks.
- [x] GREEN: Store approval state in the Trevor config/state root chosen by existing storage taxonomy.
- [x] RED: Add tests proving project/user hooks never execute before approval.
- [x] GREEN: Gate execution on approval while still reporting diagnostics.
- [x] REFACTOR: Keep trust storage inspectable and path-redacted in logs.

### Gate 1 -> 2

- [x] Hook config schema accepts only first-cut event types.
- [x] Discovery is deterministic and source-attributed.
- [x] Trust hashes change when config or referenced scripts change.
- [x] Unapproved hooks do not execute.

### Phase 2: Command Execution Harness

#### M3: Handler Execution and Output Contract

- [x] RED: Add command execution tests for `args` arrays without shell splitting.
- [x] GREEN: Implement the hook command runner with explicit executable plus args.
- [x] RED: Add timeout tests using fake time or controllable child processes.
- [x] GREEN: Enforce low default timeouts and per-hook timeout overrides within safe bounds.
- [x] RED: Add stdout/stderr cap tests and invalid JSON tests.
- [x] GREEN: Cap stdout/stderr and parse structured hook decisions from JSON output.
- [x] RED: Add secret-redaction tests for env-like values, auth headers, tokens, and paths.
- [x] GREEN: Redact sensitive output in logs, events, and Doctor details.

#### M4: Failure and Diagnostic Semantics

- [x] RED: Add tests proving command failure, invalid JSON, and timeout are non-blocking by default.
- [x] GREEN: Convert failures into diagnostic hook results without failing the user turn.
- [x] RED: Add tests proving explicit deny/halt decisions still block.
- [x] GREEN: Preserve explicit blocking decisions from successful hook outputs.
- [x] RED: Add tests for repeated timeout and slow-handler counters.
- [x] GREEN: Track slow/repeated failures for Doctor diagnostics.
- [x] REFACTOR: Keep runtime errors typed and observable.

### Gate 2 -> 3

- [x] Hook commands run with explicit args and no implicit shell splitting.
- [x] Timeouts and output caps are enforced.
- [x] Secrets are redacted from logs/events/Doctor.
- [x] Failures are non-blocking unless the hook explicitly blocks.

### Phase 3: PreToolUse Enforcement

#### M5: PreToolUse Payload and Decisions

- [x] RED: Add loop/tool-executor tests proving `PreToolUse` receives session/run/turn ids, cwd, caller kind, tool name, tool input, and metadata.
- [x] GREEN: Build the `PreToolUse` payload at the tool boundary.
- [x] RED: Add allow tests proving normal tool execution proceeds unchanged.
- [x] GREEN: Wire `allow` as a transparent pass-through.
- [x] RED: Add deny tests proving tool execution is skipped and the model receives a clear denied result.
- [x] GREEN: Implement `deny` as visible, model-facing tool denial without executing the tool.
- [x] RED: Add halt tests proving the turn stops with a visible reason.
- [x] GREEN: Implement `halt` as a terminal hook decision.

#### M6: Context and Updated Input

- [x] RED: Add tests for bounded context injection before a tool executes.
- [x] GREEN: Allow `PreToolUse` to add bounded context to the tool result or immediate model context.
- [x] RED: Add tests for supported `updatedInput` fields on explicitly allowed tools.
- [x] GREEN: Apply `updatedInput` only for supported fields before normal tool validation.
- [x] RED: Add tests proving hidden state, unsupported fields, and validation bypass attempts are rejected.
- [x] GREEN: Reject unsupported input rewrites and emit diagnostics.
- [x] REFACTOR: Keep input update policy tool-specific and reviewable.

### Gate 3 -> 4

- [x] `PreToolUse` runs before eligible tool execution.
- [x] Allow, deny, and halt decisions are enforced.
- [x] Context additions are bounded.
- [x] Input updates cannot bypass validation or rewrite hidden state.

### Phase 4: Stop Hook and Continuation

#### M7: Stop Payload and Finalization Decisions

- [x] RED: Add turn tests proving `Stop` receives terminal reason, final assistant text, cwd, ids, and compact tool/change summary.
- [x] GREEN: Build and dispatch `Stop` payload before final completion.
- [x] RED: Add allow tests proving completion proceeds unchanged.
- [x] GREEN: Wire allow as transparent finalization.
- [x] RED: Add halt tests proving completion is blocked with a visible reason.
- [x] GREEN: Implement halt as a visible terminal hook outcome.
- [x] REFACTOR: Keep Stop result handling separate from provider/tool execution.

#### M8: One-Pass Continuation

- [x] RED: Add tests for a Stop hook returning bounded context requesting continuation.
- [x] GREEN: Run at most one continuation/synthesis pass with tools constrained as appropriate.
- [x] RED: Add tests proving a second Stop continuation request is ignored or rejected.
- [x] GREEN: Enforce a hard one-continuation budget.
- [x] RED: Add tests proving Stop cannot mutate files, rewrite prior events, or apply tools directly.
- [x] GREEN: Keep Stop continuation as model context only, never direct mutation.
- [x] REFACTOR: Record continuation reason in visible events and diagnostics.

### Gate 4 -> 5

- [x] `Stop` runs before final assistant completion.
- [x] Stop allow/halt/continue decisions are enforced.
- [x] Continuation is bounded to at most one pass.
- [x] Stop hooks cannot mutate files or rewrite events.

### Phase 5: Visibility, Doctor, and Verification

#### M9: Events, Transcript, and Doctor

- [x] RED: Add protocol tests for visible hook decision events.
- [x] GREEN: Emit hook events for allow, deny, halt, context, updated-input, timeout, error, unapproved, and trust-changed states.
- [x] RED: Add transcript/web tests for denied/halted hook decisions.
- [x] GREEN: Render visible hook status without dumping secrets.
- [x] RED: Add Doctor tests for configured hooks, missing handlers, missing scripts, changed trust hashes, slow handlers, repeated timeouts, unapproved hooks, and legacy `HOOK.md`.
- [x] GREEN: Wire hook diagnostics into Doctor's hooks area.
- [x] REFACTOR: Keep default Doctor output concise with full/detail escape hatches.

#### M10: Exclusions and Full Verification

- [x] RED: Add tests proving `PostToolUse`, native extension dispatch, model-routing hooks, long-running daemons, arbitrary plugin APIs, hidden mutation, and default shell splitting are unavailable.
- [x] GREEN: Keep excluded surfaces absent from schemas, discovery, prompt guidance, and runtime.
- [x] RED: Add migration tests for legacy executable `HOOK.md` diagnostics without execution.
- [x] GREEN: Report legacy migration guidance through Doctor.
- [x] GREEN: Run host unit tests, protocol tests, web tests, integration tests, lint, typecheck, and hermetic e2e.
- [x] GREEN: Manual EZE repro: approve a project hook, deny one tool, allow another, halt one final answer, and verify Doctor/trust diagnostics.
- [x] REFACTOR: Record exact verification commands and any accepted follow-up.

##### M10 Verification Record (2026-07-02)

Exact commands run at the M9+M10 cutoff, all green:

```bash
pnpm lint                          # biome check + filename policy - clean
pnpm typecheck                     # tsgo across all workspaces - clean
pnpm test                          # ALL projects: unit + integration + web + e2e
tests/browser/update-storybook-baselines.sh   # regenerated in the pinned container (Hooks
                                              # doctor story + panel snapshots changed; 8 PNGs)
tests/browser/check-storybook-baselines.sh    # container drift check over the committed PNGs - clean
```

Manual EZE (headless, scripted through the testing surface; temporary
`apps/agent-host/test/hooks/eze-manual.test.ts`, run then deleted): a scratch workspace with a
real `.trevor/hooks.json`, two real node hook scripts (`tool-guard.mjs` denies bash / allows
read; `final-review.mjs` halts Stop), a legacy `.trevor/hooks/old-fmt/HOOK.md`, approvals
written via the approval store API (`computeHookTrustFingerprint` + `approveHook` +
`saveHookApprovals` - the approval UX surface is the ask-user tool integration, satisfied at
the API level per the plan 01 dependency), then one fake-provider turn through `publishTurn`.
Observed: doctor pre-approval showed `2 awaiting approval` + the `hooks.approval` and
`hooks.legacy` warnings; post-approval showed `2 approved`; the turn emitted
`hook.decision` deny (bash) with the model-facing denial result, ran read normally with NO
allow event, and emitted `hook.decision` halt (Stop) with the `hook_halt` stop on the
completion (final text intact); doctor afterwards showed `2 approved`, `3 runs` in the debug
histogram, and the legacy migration finding.

### Done Gate

- [x] Only `PreToolUse` and `Stop` hooks exist.
- [x] Hooks execute through trusted command handlers with args arrays.
- [x] Deny/halt/continue decisions work and are visible.
- [x] Failure and timeout behavior is observable and non-blocking by default.
- [x] Doctor diagnostics cover hooks accurately.
- [x] Excluded broad plugin surfaces remain absent.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

# Command Shell Interpolation - Progress Report

## Summary

- Current focus: M1 - Skill Interpolation Provenance
- Current cutoff blockers: 55
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 5

## 0. Hard Dependencies

- [x] Skill shell interpolation already exists in `apps/agent-host/src/skills.ts` through `TREVOR_SKILL_SHELL`.
- [x] Shell interpolation uses the shared `runCommand` floor in `apps/agent-host/src/tools/run-shell.ts`: always-prevented command classification, timeout, and output cap.
- [x] The prompt shell lane is distinct from interpolation; leading `!` in the composer is a user-owned immediate command, not prompt/file expansion.
- [x] `.plans/19-capability-manifest-and-trevor-expert` keeps general interpolation separate from `trevor-export` and `trevor-expert`.
- [x] Runtime secret resolution has been dropped from V2; this plan must not reintroduce `op://` or secret-command interpolation.

## Current Cutoff Blockers

### Phase 1: Contract and Current-State Lockdown

#### M1: Skill Interpolation Provenance

- [ ] RED: Add or strengthen tests proving skill interpolation is off by default and `!` lines remain literal.
- [ ] GREEN: Preserve current `TREVOR_SKILL_SHELL` behavior.
- [ ] RED: Add tests for enabled skill interpolation covering `!cmd`, fenced command blocks, refused commands, timeout/error output, and output caps.
- [ ] GREEN: Preserve `runCommand()` as the execution floor.
- [ ] REFACTOR: Extract shared interpolation parsing only after tests lock existing skill behavior.

#### M2: Command File Definition and Trust Contract

- [ ] RED: Add contract tests for command-file discovery roots and which files are eligible for interpolation.
- [ ] GREEN: Define the V2 command-file concept, root provenance, trusted status, and disabled/untrusted behavior.
- [ ] RED: Add tests proving TypeScript immediate slash commands do not use interpolation.
- [ ] GREEN: Keep interpolation strictly attached to file-loaded command definitions.
- [ ] REFACTOR: Document prompt shell lane, skill interpolation, and command-file interpolation as separate concepts.

#### Gate 1->2

- [ ] Existing skill interpolation behavior remains unchanged.
- [ ] Command-file scope is explicit.
- [ ] Untrusted or ineligible files cannot trigger interpolation.

### Phase 2: Shared Interpolation Engine

#### M3: Shared Parser and Renderer

- [ ] RED: Add pure parser tests for literal text, `!cmd` lines, markdown image `![...]`, fenced command blocks, unterminated fences, adjacent blocks, and escaped/literal examples.
- [ ] GREEN: Extract a shared interpolation parser/renderer that preserves skill behavior.
- [ ] RED: Add tests proving output order and line preservation remain stable.
- [ ] GREEN: Render interpolated output with bounded command results and clear error markers.
- [ ] REFACTOR: Keep shell execution dependency injected so parser tests do not run shell commands.

#### M4: Execution Policy and Gating

- [ ] RED: Add config tests proving command interpolation defaults disabled.
- [ ] GREEN: Add an explicit command interpolation gate, initially `TREVOR_COMMAND_SHELL=1` or equivalent naming that does not accidentally enable skill interpolation.
- [ ] RED: Add tests for enabled, disabled, untrusted root, command refusal, timeout, non-zero exit, output cap, and redaction/cap metadata.
- [ ] GREEN: Route all command execution through `runCommand()` or the shared shell floor.
- [ ] REFACTOR: Centralize interpolation policy names and diagnostics so skills/commands cannot drift.

#### Gate 2->3

- [ ] Shared interpolation parser is tested without shell.
- [ ] Command interpolation remains disabled by default.
- [ ] All command execution uses the same safety floor as skill interpolation.

### Phase 3: Command-File Integration

#### M5: Command Loader Integration

- [ ] RED: Add command-loader tests for a trusted command file with literal content while the gate is off.
- [ ] GREEN: Keep disabled-gate command files literal.
- [ ] RED: Add command-loader tests for enabled interpolation with `!cmd` and fenced blocks.
- [ ] GREEN: Apply interpolation during command-file load/expand, before the file body is used.
- [ ] REFACTOR: Keep command handler registration separate from file-body expansion.

#### M6: Failure Handling and Diagnostics

- [ ] RED: Add tests for refused interpolation command, shell timeout, command failure, unavailable shell, and output truncation.
- [ ] GREEN: Return bounded inline error markers or command-file diagnostics without crashing command discovery.
- [ ] RED: Add tests proving interpolation diagnostics redact secrets and do not include raw large output.
- [ ] GREEN: Emit structured diagnostics with file provenance, gate state, command count, status, duration, and cap state.
- [ ] REFACTOR: Make diagnostics inspectable through `/doctor` or debug output when practical.

#### Gate 3->4

- [ ] Trusted command files interpolate only when enabled.
- [ ] Disabled or untrusted command files remain literal or denied.
- [ ] Interpolation failures are bounded, visible, and non-crashing.

### Phase 4: UI/Prompt Safety and Verification

#### M7: Prompt and Export Boundary Tests

- [ ] RED: Add prompt-production tests proving interpolated command output is capped before entering any prompt or command expansion.
- [ ] GREEN: Apply caps at the interpolation boundary, not later in provider code.
- [ ] RED: Add tests proving command interpolation does not reintroduce runtime secret resolution or `op://` handling.
- [ ] GREEN: Treat secret-like material as ordinary shell output subject to redaction/caps; do not add secret fetch semantics.
- [ ] REFACTOR: Keep `trevor-export` direct host access independent from the global interpolation gate.

#### M8: End-to-End Verification

- [ ] RED: Add integration tests for disabled and enabled command-file interpolation through the real command loader.
- [ ] GREEN: Verify exact expansion, refusal, cap, and diagnostics behavior.
- [ ] RED: Add regression tests proving prompt shell `!` and immediate slash commands are unaffected.
- [ ] GREEN: Run unit, integration, typecheck, and lint for command/skill interpolation paths.
- [ ] REFACTOR: Record exact verification commands and manual trust-gate behavior in the progress report.

#### Done Gate

- [ ] Skill interpolation behavior is unchanged.
- [ ] Command-file interpolation is disabled by default.
- [ ] Trusted command files can use whole-line `!cmd` and fenced command blocks when enabled.
- [ ] All interpolation commands use the shared shell safety floor.
- [ ] Prompt shell lane and immediate slash commands are unaffected.
- [ ] Runtime secret resolution is not reintroduced.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

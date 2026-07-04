# Command Shell Interpolation - Progress Report

## Summary

- Current focus: Done - all milestones landed
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 1
- Superseded/obsolete checklist debt: 0
- Completed current work: 55

## 0. Hard Dependencies

- [x] Skill shell interpolation already exists in `apps/agent-host/src/skills.ts` through `TREVOR_SKILL_SHELL`.
- [x] Shell interpolation uses the shared `runCommand` floor in `apps/agent-host/src/tools/run-shell.ts`: always-prevented command classification, timeout, and output cap.
- [x] The prompt shell lane is distinct from interpolation; leading `!` in the composer is a user-owned immediate command, not prompt/file expansion.
- [x] `.plans/14-capability-manifest-and-trevor-expert` keeps general interpolation separate from `trevor-export` and `trevor-expert`.
- [x] Runtime secret resolution has been dropped from V2; this plan must not reintroduce `op://` or secret-command interpolation.
- [x] Reorg (plan 22.1): the shared interpolation engine lives in `commands/` (`interpolation-engine.ts`, `command-file.ts`), imported by `skills/` via `@host/*`.

## Current Cutoff Blockers

None. All milestones complete and verified (lint + typecheck + full vitest green).

### Phase 1: Contract and Current-State Lockdown

#### M1: Skill Interpolation Provenance

- [x] RED: tests proving skill interpolation is off by default and `!` lines remain literal (skills.test.ts; interpolation.test.ts source-provenance suite).
- [x] GREEN: current `TREVOR_SKILL_SHELL` behavior preserved (skills.ts `skillShellExecutor` runs the same runCommand floor).
- [x] RED: tests for enabled skill interpolation - `!cmd`, fenced blocks, refused commands, error output, and output caps (interpolation-engine.test.ts "shared execution floor").
- [x] GREEN: `runCommand()` preserved as the execution floor for the skill lane.
- [x] REFACTOR: shared interpolation parsing extracted to `interpolation-engine.ts`; skills.ts now calls it.

#### M2: Command File Definition and Trust Contract

- [x] RED: contract tests for command-file roots + interpolation eligibility (command-file.test.ts trust suite).
- [x] GREEN: V2 command-file concept defined (`CommandFile`, `CommandFileRootKind`, `isTrustedRoot`) - builtin/project/user trusted, else denied.
- [x] RED: tests proving immediate TypeScript slash commands do not interpolate (interpolation-e2e.test.ts regression).
- [x] GREEN: interpolation attached strictly to file-loaded bodies (`expandCommandFile`), never the command registry.
- [x] REFACTOR: prompt shell lane / skill interpolation / command-file interpolation documented as separate concepts (module headers + provenance types).

#### Gate 1->2

- [x] Existing skill interpolation behavior remains unchanged.
- [x] Command-file scope is explicit.
- [x] Untrusted or ineligible files cannot trigger interpolation.

### Phase 2: Shared Interpolation Engine

#### M3: Shared Parser and Renderer

- [x] RED: pure parser tests - literal text, `!cmd`, markdown image `![...]`, fenced blocks, unterminated fences, adjacent blocks, mid-line `!` (interpolation-engine.test.ts).
- [x] GREEN: shared parser/renderer extracted, preserving skill behavior.
- [x] RED: order + line-preservation tests (renderInterpolation suite).
- [x] GREEN: bounded command results + clear error/refusal markers.
- [x] REFACTOR: shell execution injected (`SegmentExecutor`) so parser tests run no shell.

#### M4: Execution Policy and Gating

- [x] RED: config tests proving command interpolation defaults disabled (interpolation.test.ts).
- [x] GREEN: explicit command-file gate reuses `TREVOR_ENABLE_INTERPOLATION` (plan-14 gate); distinct from the skill gate (`INTERPOLATION_GATE_ENV`).
- [x] RED: tests for enabled/disabled/untrusted/refusal/failure/output-cap/redaction metadata (command-file.test.ts).
- [x] GREEN: allow-listed command execution routed through the in-process runner; skill lane still via `runCommand`.
- [x] REFACTOR: policy names + diagnostics centralized in interpolation.ts; skills/commands can't drift (runner drift guard).

#### Gate 2->3

- [x] Shared interpolation parser is tested without shell.
- [x] Command interpolation remains disabled by default.
- [x] All command execution uses the same safety floor / gated in-process dispatch.

### Phase 3: Command-File Integration

#### M5: Command Loader Integration

- [x] RED: loader test - trusted file, gate off, literal (command-file.test.ts).
- [x] GREEN: disabled-gate command files stay literal.
- [x] RED: loader tests for enabled `!cmd` + fenced blocks.
- [x] GREEN: interpolation applied during expand, before the body is used (`expandCommandFile`).
- [x] REFACTOR: handler registration (commands.ts) kept separate from file-body expansion (command-file.ts).

#### M6: Failure Handling and Diagnostics

- [x] RED: tests for refusal, failure (ok:false), and output truncation (command-file.test.ts).
- [x] GREEN: bounded inline markers, never a crash (typed, non-throwing path).
- [x] RED: tests proving diagnostics redact secrets and carry no raw output.
- [x] GREEN: structured `InterpolationDiagnostic` with provenance, gate state, target, status, bytes, truncation, duration.
- [x] REFACTOR: diagnostics are plain records the loader returns; a `/doctor` surfacing is a recorded follow-up.

#### Gate 3->4

- [x] Trusted command files interpolate only when enabled.
- [x] Disabled or untrusted command files remain literal or denied.
- [x] Interpolation failures are bounded, visible, and non-crashing.

### Phase 4: UI/Prompt Safety and Verification

#### M7: Prompt and Export Boundary Tests

- [x] RED: prompt-production caps proven at the interpolation boundary (boundInterpolationOutput; command-file cap test).
- [x] GREEN: caps applied at the interpolation boundary, not later.
- [x] RED: tests proving no `op://`/secret resolution is reintroduced (interpolation-boundary.test.ts).
- [x] GREEN: secret-like output treated as ordinary text - redacted + capped, never fetched.
- [x] REFACTOR: `/trevor-export` direct host access proven independent of the interpolation gate.

#### M8: End-to-End Verification

- [x] RED: integration tests for disabled + enabled command-file interpolation through the real runner (interpolation-e2e.test.ts).
- [x] GREEN: exact expansion, refusal, cap, and diagnostics verified.
- [x] RED: regression proving prompt shell `!` and immediate slash commands are unaffected.
- [x] GREEN: unit + integration + typecheck + lint green for command/skill interpolation paths.
- [x] REFACTOR: verification commands + manual trust-gate behavior recorded below.

#### Done Gate

- [x] Skill interpolation behavior is unchanged.
- [x] Command-file interpolation is disabled by default.
- [x] Trusted command files can use whole-line `!cmd` and fenced command blocks when enabled.
- [x] All interpolation commands use the shared shell safety floor / gated in-process dispatch.
- [x] Prompt shell lane and immediate slash commands are unaffected.
- [x] Runtime secret resolution is not reintroduced.

## Verification Commands

```bash
pnpm -C <worktree> lint        # biome + kebab-case filename policy
pnpm -C <worktree> typecheck   # tsgo --noEmit, all packages
pnpm -C <worktree> test        # full vitest: 4258 passed | 6 skipped
```

Manual trust-gate verification (the gated live lane, 3 skipped tests in
`apps/agent-host/test/interpolation-e2e.test.ts`):

```bash
TREVOR_ENABLE_INTERPOLATION=1 pnpm -C <worktree> test:integration \
  apps/agent-host/test/interpolation-e2e.test.ts
```

## Accepted/Deferred Follow-Up

- [ ] Surfacing `InterpolationDiagnostic` records through `/doctor` or debug output (M6 REFACTOR "when
  practical"): the structured records are produced and returned by `expandCommandFile`; wiring them into
  the `/doctor` panel is deferred until a command-file discovery UI exists (there is no on-disk
  command-file loader yet - escape hatch 1). Not a current-cutoff blocker.

## Superseded/Obsolete Checklist Debt

None.

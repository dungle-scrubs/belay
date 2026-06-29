# Command Shell Interpolation - Implementation Plan

## 0. Hard Dependencies

- [x] Skill shell interpolation already exists in `apps/agent-host/src/skills.ts` through `TREVOR_SKILL_SHELL`.
- [x] Shell interpolation uses the shared `runCommand` floor in `apps/agent-host/src/tools/run-shell.ts`: always-prevented command classification, timeout, and output cap.
- [x] The prompt shell lane is distinct from interpolation; leading `!` in the composer is a user-owned immediate command, not prompt/file expansion.
- [x] `.plans/14-capability-manifest-and-trevor-expert` keeps general interpolation separate from `trevor-export` and `trevor-expert`.
- [x] Runtime secret resolution has been dropped from V2; this plan must not reintroduce `op://` or secret-command interpolation.

## 1. Architecture

Command shell interpolation extends the existing skill-file interpolation behavior to trusted command files. A command file may contain a single-line `!cmd` interpolation or a fenced multi-line command block opened with ```` ```! ````; when interpolation is enabled and the file is trusted, Trevor executes those commands through the same bounded host shell path used by skill interpolation and substitutes capped stdout/stderr into the loaded command body. <!-- D-001 -->

This is not the prompt shell lane, not a model tool call, not secret resolution, and not a general runtime macro system. It is load-time expansion of command-file content for explicitly trusted local command definitions. <!-- D-002 -->

General command-file interpolation is risky and defaults disabled. Enabling it requires explicit configuration, initially an environment gate parallel to skill interpolation. A later config UI can make the same policy durable, but the first implementation should keep behavior impossible to trigger accidentally. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Disabled by default | Command files load literally unless the interpolation gate is explicitly enabled. |
| Same command forms as skills | Support `!cmd` whole-line interpolation and fenced ```` ```! ```` blocks. |
| Same safety floor as skills | Use the existing `runCommand` path or extract a shared interpolation helper that still calls `runCommand`. |
| Trusted command files only | Interpolation applies only to configured/trusted command roots, not arbitrary prompt text or downloaded files. |
| No secret resolution | Do not add `op://`, env secret expansion, or command-based secret injection. Startup secrets remain outside Trevor. |
| Bounded output | Interpolated output is capped, redacted where applicable, and visible enough to debug. |
| Prompt impact is explicit | Expanded command bodies may feed prompts or command execution, so tests must prove caps and disabled-default behavior. |

### Command File Scope

The plan should first define what a "command file" means in V2. Candidate sources include:

- shared/user command prompt files if/when V2 loads them from configured roots;
- built-in command templates that opt in to interpolation for deterministic host exports;
- future project-local command files if the command system adds them.

Immediate slash commands implemented as TypeScript handlers are not command files and do not use interpolation.

### Boundaries

- `apps/agent-host` owns command-file discovery, trust policy, interpolation expansion, shell execution, caps, redaction, diagnostics, and tests.
- The existing skill interpolation behavior remains intact. Shared interpolation helpers may be extracted only if they preserve current skill behavior.
- `apps/web` does not execute interpolation. It may display command-file metadata or diagnostics if a later command discovery UI exposes them.
- `trevor-export` and `trevor-expert` may have direct host access in their own plan and must not depend on global command interpolation.

### Observability

Command-file interpolation needs explicit diagnostics because it runs shell commands during file expansion:

- log/interpolation diagnostics include file id/path hash, root kind, gate state, trusted/untrusted status, command count, duration, output bytes, cap/truncation status, and failure class;
- `/doctor` or debug output should be able to report whether command interpolation is disabled, enabled, unavailable, or denied by trust policy;
- tests prove raw command output is capped and dangerous command attempts are refused through the shared safety floor;
- failed interpolation should not crash command discovery. It should substitute a bounded error marker or mark the command unavailable, depending on the command-file contract.

## 2. Current State

Skill interpolation exists today. `SKILL_SHELL_INTERPOLATION` is enabled only when `TREVOR_SKILL_SHELL` is `1` or `true`; `expandSkill()` strips frontmatter, optionally calls `interpolateShell()`, and caps the expanded body. `interpolateShell()` supports whole-line `!cmd` and fenced ```` ```! ```` blocks and executes through `runCommand()`.

`runCommand()` uses the host working directory, blocks always-prevented bash commands through `classifyAlwaysPreventedBashCommand()`, times out after 30 seconds, caps output, and never rejects. Refusals, non-zero exits, and timeouts become bounded output strings.

The umbrella backlog still carries H-175 for command-file interpolation: skills are done; command files are not.

## 3. Phases

### Phase 1: Contract and Current-State Lockdown

**Goal:** Existing skill interpolation behavior is protected while command-file interpolation gets a precise contract.

**Gate from previous:** H-175 has been extracted from the umbrella plan.

#### M1: Skill Interpolation Provenance

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add or strengthen tests proving skill interpolation is off by default and `!` lines remain literal.
  2. GREEN: Preserve current `TREVOR_SKILL_SHELL` behavior.
  3. RED: Add tests for enabled skill interpolation covering `!cmd`, fenced command blocks, refused commands, timeout/error output, and output caps.
  4. GREEN: Preserve `runCommand()` as the execution floor.
  5. REFACTOR: Extract shared interpolation parsing only after tests lock existing skill behavior.

#### M2: Command File Definition and Trust Contract

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add contract tests for command-file discovery roots and which files are eligible for interpolation.
  2. GREEN: Define the V2 command-file concept, root provenance, trusted status, and disabled/untrusted behavior.
  3. RED: Add tests proving TypeScript immediate slash commands do not use interpolation.
  4. GREEN: Keep interpolation strictly attached to file-loaded command definitions.
  5. REFACTOR: Document prompt shell lane, skill interpolation, and command-file interpolation as separate concepts.

### Gate 1->2

- [ ] Existing skill interpolation behavior remains unchanged.
- [ ] Command-file scope is explicit.
- [ ] Untrusted or ineligible files cannot trigger interpolation.

### Phase 2: Shared Interpolation Engine

**Goal:** Skills and command files use one audited interpolation implementation and one shell safety floor.

**Gate from previous:** Command-file contract is explicit.

#### M3: Shared Parser and Renderer

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add pure parser tests for literal text, `!cmd` lines, markdown image `![...]`, fenced command blocks, unterminated fences, adjacent blocks, and escaped/literal examples.
  2. GREEN: Extract a shared interpolation parser/renderer that preserves skill behavior.
  3. RED: Add tests proving output order and line preservation remain stable.
  4. GREEN: Render interpolated output with bounded command results and clear error markers.
  5. REFACTOR: Keep shell execution dependency injected so parser tests do not run shell commands.

#### M4: Execution Policy and Gating

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add config tests proving command interpolation defaults disabled.
  2. GREEN: Add an explicit command interpolation gate, initially `TREVOR_COMMAND_SHELL=1` or equivalent naming that does not accidentally enable skill interpolation.
  3. RED: Add tests for enabled, disabled, untrusted root, command refusal, timeout, non-zero exit, output cap, and redaction/cap metadata.
  4. GREEN: Route all command execution through `runCommand()` or the shared shell floor.
  5. REFACTOR: Centralize interpolation policy names and diagnostics so skills/commands cannot drift.

### Gate 2->3

- [ ] Shared interpolation parser is tested without shell.
- [ ] Command interpolation remains disabled by default.
- [ ] All command execution uses the same safety floor as skill interpolation.

### Phase 3: Command-File Integration

**Goal:** Trusted command files can opt into bounded interpolation without changing immediate slash-command behavior.

**Gate from previous:** Shared engine and gating are reliable.

#### M5: Command Loader Integration

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add command-loader tests for a trusted command file with literal content while the gate is off.
  2. GREEN: Keep disabled-gate command files literal.
  3. RED: Add command-loader tests for enabled interpolation with `!cmd` and fenced blocks.
  4. GREEN: Apply interpolation during command-file load/expand, before the file body is used.
  5. REFACTOR: Keep command handler registration separate from file-body expansion.

#### M6: Failure Handling and Diagnostics

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for refused interpolation command, shell timeout, command failure, unavailable shell, and output truncation.
  2. GREEN: Return bounded inline error markers or command-file diagnostics without crashing command discovery.
  3. RED: Add tests proving interpolation diagnostics redact secrets and do not include raw large output.
  4. GREEN: Emit structured diagnostics with file provenance, gate state, command count, status, duration, and cap state.
  5. REFACTOR: Make diagnostics inspectable through `/doctor` or debug output when practical.

### Gate 3->4

- [ ] Trusted command files interpolate only when enabled.
- [ ] Disabled or untrusted command files remain literal or denied.
- [ ] Interpolation failures are bounded, visible, and non-crashing.

### Phase 4: UI/Prompt Safety and Verification

**Goal:** Interpolated command files are safe in prompt paths and explainable in diagnostics.

**Gate from previous:** Command loader integration passes.

#### M7: Prompt and Export Boundary Tests

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add prompt-production tests proving interpolated command output is capped before entering any prompt or command expansion.
  2. GREEN: Apply caps at the interpolation boundary, not later in provider code.
  3. RED: Add tests proving command interpolation does not reintroduce runtime secret resolution or `op://` handling.
  4. GREEN: Treat secret-like material as ordinary shell output subject to redaction/caps; do not add secret fetch semantics.
  5. REFACTOR: Keep `trevor-export` direct host access independent from the global interpolation gate.

#### M8: End-to-End Verification

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add integration tests for disabled and enabled command-file interpolation through the real command loader.
  2. GREEN: Verify exact expansion, refusal, cap, and diagnostics behavior.
  3. RED: Add regression tests proving prompt shell `!` and immediate slash commands are unaffected.
  4. GREEN: Run unit, integration, typecheck, and lint for command/skill interpolation paths.
  5. REFACTOR: Record exact verification commands and manual trust-gate behavior in the progress report.

### Done Gate

- [ ] Skill interpolation behavior is unchanged.
- [ ] Command-file interpolation is disabled by default.
- [ ] Trusted command files can use whole-line `!cmd` and fenced command blocks when enabled.
- [ ] All interpolation commands use the shared shell safety floor.
- [ ] Prompt shell lane and immediate slash commands are unaffected.
- [ ] Runtime secret resolution is not reintroduced.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Command interpolation executes unexpectedly | high | medium | Disabled default, explicit env gate, trusted roots only, tests for literal output when disabled. | agent-host |
| Interpolation becomes a secret system | high | low | No `op://`, no secret expansion, redaction/cap tests, decision recorded. | agent-host |
| Skill behavior regresses while sharing code | medium | medium | Lock skill behavior before extraction and reuse fixtures. | agent-host |
| Prompt context bloats with command output | medium | medium | Cap output at interpolation boundary and test prompt-sized outputs. | agent-host |
| Users confuse prompt shell with interpolation | medium | medium | Keep docs/tests naming separate: prompt shell lane, skill interpolation, command-file interpolation. | agent-host/web |

## 5. Escape Hatches

1. **If command-file roots are not ready:** finish the shared interpolation engine and keep command integration blocked behind the command-file loader contract.
2. **If shared parser extraction risks skill regressions:** keep skill interpolation in place and add command interpolation with duplicated parser only temporarily, with parity tests requiring later consolidation.
3. **If general command interpolation feels too broad:** restrict first enabled target to bounded `trevor-export` command files and leave arbitrary shell interpolation disabled.

## 6. Progress Report Accounting

The progress report is `.plans/40-command-shell-interpolation/progress-report.md`. Current-cutoff blockers are the unchecked items under active milestones. Deferred narrowing options are not blockers unless promoted into the current cutoff.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "40-command-shell-interpolation"
```

## 7. Validation Commands

```bash
pnpm --filter @trevor/agent-host test
pnpm test -- --project unit
pnpm test -- --project integration
pnpm typecheck
pnpm lint
```

## 8. Decisions

Canonical decisions are in `.plans/40-command-shell-interpolation/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "40-command-shell-interpolation"
```

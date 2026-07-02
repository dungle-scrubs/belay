# Codebase Organization (Agent Host) - Progress Report

## Summary

- Current focus: M3 - Relocate Loose Files into By-Domain Dirs
- Current cutoff blockers: 28
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 11

## Current Cutoff Blockers

### Phase 1: Conventions, Alias, and Inventory

#### M1: Relocation Inventory, Target Map, and Conventions

- [x] RED: Add a failing guard/test that flags any file directly under `apps/agent-host/src/` outside an allowlist (`main.ts`).
- [x] GREEN: Produce the authoritative inventory of loose `src/` root files mapped to their target dirs.
- [x] GREEN: Add the AGENTS.md naming rule (plural = collection, singular = subsystem) and the no-catch-all-dir rule.
- [x] GREEN: Add the AGENTS.md `Responsible for / Not for` header standard with a fixed, doc-generatable shape.
- [x] REFACTOR: Keep the inventory/map output stable, sorted, and reviewable.

#### M2: `@host/*` Path Alias Scaffolding

- [x] RED: Add a test/module that imports through `@host/...` and fails because the alias is unconfigured.
- [x] GREEN: Configure the alias in `apps/agent-host/tsconfig.json` and the Vitest config so it resolves under typecheck and tests.
- [x] REFACTOR: Document the alias in AGENTS.md beside the naming rule.

### Gate 1 -> 2

- [x] Root-flatness guard exists and currently fails against the loose-file inventory.
- [x] AGENTS.md states the naming rule, no-catch-all rule, header standard, and `@host/*` alias.
- [x] `@host/*` resolves under both typecheck and Vitest.

### Phase 2: Mechanical Relocation and Renames

#### M3: Relocate Loose Files into By-Domain Dirs

- [ ] RED: Capture the current failing root-flatness guard against the inventory.
- [ ] GREEN: `git mv` the loose files into `boot/`, `transport/`, `session/`, `commands/`, `skills/`, `subagents/`, `processes/`, `prefs/`, `metrics/`, `handoff/` - pure moves, no content edits.
- [ ] GREEN: Move files that belong to settled dirs into them flat (`turn`/`turn-preflight` -> `agent/`, `git-status` -> `worktrees/`, `clip` -> merge into `tools/clipboard`).
- [ ] GREEN: Update imports for moved files to `@host/*` (or local relative within a dir).
- [ ] RED: Re-run the root-flatness guard and typecheck; capture remaining failures.
- [ ] REFACTOR: Batch related moves by destination dir so each commit is reviewable and bisectable.

#### M4: Semantic Renames and Init-Cycle Removal

- [ ] RED: Run typecheck to expose stale imports for the renames.
- [ ] GREEN: `git mv` `context/` -> `project-context/`, `config-file.ts` -> `boot/config.ts`, `agents.ts` -> `subagents/`, `artifacts.ts` -> `agent/image-resolution.ts`; update all references.
- [ ] GREEN: Move `tasks.ts` -> `tools/tasks/` and remove the leaf-import cycle-avoidance workaround.
- [ ] RED: Search for remaining references to old paths/dir names across docs, tests, and snapshots.
- [ ] GREEN: Update those references; leave exported symbol names unchanged.
- [ ] REFACTOR: Delete obsolete cycle-avoidance comments and any temporary shims.

### Gate 2 -> 3

- [ ] No file remains loose under `src/` root except the allowlist.
- [ ] Typecheck passes; no stale path references remain.
- [ ] Unit, web, integration, turn, and e2e lanes pass.
- [ ] The host starts and runs a turn with no module-resolution errors.

### Phase 3: Headers, Architecture Map, and Enforcement

#### M5: Header Docstrings and Architecture Map

- [ ] RED: Add the header presence/format check; it fails because host source files lack headers.
- [ ] GREEN: Add structured `Responsible for / Not for` headers to host source files in the fixed shape.
- [ ] RED: Add a check that `apps/agent-host/ARCHITECTURE.md` lists every subsystem dir; it fails initially.
- [ ] GREEN: Write `ARCHITECTURE.md` describing each subsystem dir and its responsibility.
- [ ] REFACTOR: Confirm the header shape is mechanically parseable for doc generation.

#### M6: Light Enforcement and Full Verification

- [ ] RED: Prove a new loose `src/` root file fails the root-flatness guard and a header-less file fails the header check.
- [ ] GREEN: Wire both checks into the standard verification path (Vitest project / CI), independent of the current file list.
- [ ] GREEN: Run lint, typecheck, all relevant Vitest projects, and the hermetic e2e lane.
- [ ] REFACTOR: Record exact completed verification commands and confirm the heavy module-map manifest remains deferred.

### Done Gate

- [ ] No loose source files under `src/` root (allowlist only); header check green across host source.
- [ ] AGENTS.md, the host `ARCHITECTURE.md`, and the automated checks agree on the same conventions.
- [ ] `git log --follow` resolves history across the moved files (pure-move commits verified).

## Accepted/Deferred Follow-Up

- God-file decomposition (`main.ts`, `agent/loop.ts`, `tools/docs/docs.ts`, `doctor/snapshot.ts`) is deferred to plan `22.2-host-god-file-decomposition`.
- The heavy module-map / directory drift manifest is deferred until package boundaries settle (after plans 28/21/10).
- The `agent/history/` subfolder grouping of compaction/projection modules is deferred to `22.2`.

## Superseded/Obsolete Checklist Debt

None.

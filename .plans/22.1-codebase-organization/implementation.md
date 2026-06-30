# Codebase Organization (Agent Host) - Implementation Plan

## 0. Hard Dependencies

- [ ] **Plan 22 (`22-kebab-case-filenames`) must land first.** <!-- D-013 --> The relocation here is pure `git mv`; running it after 22 means moved files already carry kebab-case names and pass 22's filename convention check, and avoids a double rename-then-move churn.
- [ ] **Plan 09 (`09-shell-promote-background-jobs`) must merge first.** <!-- D-013 --> Plan 09 has a live `feat/09` branch/worktree and edits `process-registry.ts` / `processes.ts`, which this plan moves into `processes/`. Relocating them before 09 merges would create a modify/delete conflict.

This plan does **not** depend on the package-reshaping plans (28/21/10); intra-host foldering is independent of where new packages are later carved.

## Architecture

This plan makes the agent host (`apps/agent-host`) legible to its readers - the owner, future contributors, an eventual agent-generated documentation site, and coding agents - by giving every module a predictable home and a self-describing header. <!-- D-002 --> It is deliberately a **structure-only** change: it relocates files, renames a handful of modules for clarity, adds header docstrings, an architecture map, a path alias, and light drift enforcement. <!-- D-001 --> It changes paths, imports, headers, conventions, and enforcement only. It does **not** change runtime behavior, transport behavior, the agent loop, or protocol behavior, and it does **not** decompose any large file - god-file decomposition is the separate, gated plan `22.2`. <!-- D-001 -->

The host today is not a flat dump: it already has well-formed domain dirs (`agent/`, `providers/`, `tools/`, `doctor/`, `worktrees/`, `serial-run/`, `connectivity/`, `context/`, plus nested `agent/recall/`, `tools/docs/`, `tools/web-fetch/`). The real disorder is the **~51 files sitting loose in `src/` root**, mixing subsystem code with leaf utilities. So the move is **additive**: home the loose files into a small set of new by-domain dirs and leave the already-settled dirs in place. <!-- D-004 -->

### Target structure

New homes for the loose root files (settled dirs are untouched except as noted): <!-- D-004 -->

| New / target dir | Receives (representative; M1 produces the authoritative list) | Singular/plural |
|---|---|---|
| `main.ts` (stays) | composition root + startup narrative + the `handleEvent` routing - **slimmed only in 22.2, not here** <!-- D-003 --> | - |
| `boot/` | `args`, `env`, `config` (was `config-file`), `startup`, `manifest-discovery`, `paths` | singular: one startup subsystem |
| `transport/` | `services` (Emit tag), `delta-buffer`, `messages`, `log` (the emit/IPC edge helpers; stream-transport *wiring* stays in `main.ts`) | singular |
| `session/` | `session-lifecycle`, `lease`, `cwd-lock`, `workspace-switch`, `control-model` | singular |
| `commands/` | `commands`, `debug-commands` | plural: a set of commands |
| `skills/` | `skills` (discovery + progressive disclosure) | plural |
| `subagents/` | was `agents.ts` (subagent discovery) | plural |
| `processes/` | `process-registry`, `processes` | plural |
| `prefs/` | `vim`, `style` (folds two single-file dirs) | plural |
| `metrics/` | `usage/breakdown` (folds single-file `usage/`) | plural |
| `handoff/` | `handoff`, `handoff-flow`, `handoff-generate` | singular |
| `tools/tasks/` | was `tasks.ts` (into existing `tools/`; dissolves the init cycle) | - |
| `agent/` (settled) | loose `turn`, `turn-preflight` join existing turn modules; `artifacts.ts` -> `agent/image-resolution.ts` | - |
| `worktrees/` (settled) | loose `git-status` joins it | - |
| `tools/` (settled) | loose `clip` merges into existing `tools/clipboard` | - |

### Semantic renames (one home per concept) <!-- D-006 -->

| From | To | Why |
|---|---|---|
| `context/` | `project-context/` | "context" means two things (AGENTS.md discovery vs context-window); disambiguate |
| `config-file.ts` | `boot/config.ts` | clearer; grouped with startup |
| `agents.ts` | `subagents/` | kill the `agent/` vs `agents/` one-letter near-collision (aligns with plan 45 vocab) |
| `artifacts.ts` | `agent/image-resolution.ts` | it is turn-time image inlining for vision models, not the artifact panel (which is web-side, plans 18/27). The eventual `agent/history/` grouping is deferred to 22.2. |
| `tasks.ts` | `tools/tasks/` | co-locate with the `tools/index.ts` barrel that calls `buildTaskTools()`, dissolving the documented leaf-import init-cycle workaround |

### Key Constraints

| Constraint | Impact |
|---|---|
| Structure-only, behavior-preserving | No runtime/transport/loop/protocol change; correctness is proven by typecheck + the existing unit/integration/turn/e2e suites staying green. <!-- D-001 --> |
| God-files are out of scope | `main.ts`, `agent/loop.ts`, `tools/docs/docs.ts`, `doctor/snapshot.ts` are NOT decomposed here; that is plan 22.2. `main.ts` only *receives* a slimmer set of loose helpers being moved out; its `handleEvent` switch and wiring are untouched. <!-- D-003 --> |
| History-preserving moves | Relocations are pure `git mv` commits with no content edits in the same commit, so `git blame` / `log --follow` survive. <!-- D-012 --> |
| Settled dirs stay put | `agent/`, `providers/`, `tools/`, `doctor/` internals are not reshuffled; loose files may move *into* them flat, but their existing layout is preserved. <!-- D-004 --> |
| Naming is predictable by rule | Plural dir = collection of peers; singular dir = one cohesive subsystem; documented in AGENTS.md. <!-- D-005 --> |
| Imports use the alias | A `@host/*` path alias replaces deep relative imports for moved/new code. <!-- D-007 --> |
| No barrels | No `index.ts` re-export files; import concrete modules directly. <!-- D-011 --> |
| Headers must be maintainable | Structured `Responsible for / Not for` headers are enforced by a presence/format check, the condition that keeps them honest. <!-- D-008 --> <!-- D-009 --> |
| Enforcement stays light | A header check and a no-loose-files-in-`src`-root guard only; the heavy module-map drift manifest is deferred until package boundaries settle. <!-- D-009 --> |
| `node-paths` taxonomy stays green | Moving files that read storage roots must keep the `@trevor/session/node-paths` drift test passing; commit any drift-test-relevant change separately. |

### Boundaries

This plan owns: the host's internal directory layout, the loose-file relocation, the five semantic renames, the `@host/*` alias, the `Responsible for / Not for` header convention, the host `ARCHITECTURE.md` map, the AGENTS.md structure/naming rules, and the two light drift checks. It does **not** own: decomposing any large file (22.2), behavior/loop/transport/protocol changes, web (`apps/web`) layout, package boundaries (28), or reshuffling the internals of already-settled dirs.

### Observability

No runtime observability changes. The user-visible inspection surfaces are: the M1 relocation inventory/map, the host `ARCHITECTURE.md` map, and the failure output of the header check and the root-flatness guard. <!-- D-010 -->

## Phases

### Phase 1: Conventions, Alias, and Inventory

**Goal:** The host has a documented structure + naming rule, a working `@host/*` alias, and an authoritative relocation map - before any file moves.

**Gate from previous:** Plan 22 merged; plan 09 merged.

#### M1: Relocation Inventory, Target Map, and Conventions

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a failing guard/test that flags any file directly under `apps/agent-host/src/` outside an allowlist (`main.ts`). <!-- D-009 -->
  2. GREEN: Produce the authoritative inventory of loose `src/` root files mapped to their target dirs per the table above. <!-- D-004 -->
  3. GREEN: Add the AGENTS.md naming rule (plural = collection, singular = subsystem) and the no-catch-all-dir rule. <!-- D-005 -->
  4. GREEN: Add the AGENTS.md `Responsible for / Not for` header standard with a fixed, doc-generatable shape. <!-- D-008 -->
  5. REFACTOR: Keep the inventory/map output stable, sorted, and reviewable.

#### M2: `@host/*` Path Alias Scaffolding

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a test/module that imports through `@host/...` and fails because the alias is unconfigured. <!-- D-007 -->
  2. GREEN: Configure the alias in `apps/agent-host/tsconfig.json` and the Vitest config so it resolves under typecheck and tests. <!-- D-007 -->
  3. REFACTOR: Document the alias in AGENTS.md beside the naming rule.

### Gate 1 -> 2

- [ ] Root-flatness guard exists and currently fails against the loose-file inventory.
- [ ] AGENTS.md states the naming rule, no-catch-all rule, header standard, and `@host/*` alias.
- [ ] `@host/*` resolves under both typecheck and Vitest.

### Phase 2: Mechanical Relocation and Renames

**Goal:** Every loose file has a by-domain home and the five renames are applied, with history preserved and behavior unchanged.

**Gate from previous:** Gate 1 passes.

#### M3: Relocate Loose Files into By-Domain Dirs

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Capture the current failing root-flatness guard against the inventory.
  2. GREEN: `git mv` the loose files into `boot/`, `transport/`, `session/`, `commands/`, `skills/`, `subagents/`, `processes/`, `prefs/`, `metrics/`, `handoff/` - pure moves, no content edits in the move commit. <!-- D-004 --> <!-- D-012 -->
  3. GREEN: Move files that belong to settled dirs into them flat (`turn`/`turn-preflight` -> `agent/`, `git-status` -> `worktrees/`, `clip` -> merge into `tools/clipboard`). <!-- D-004 -->
  4. GREEN: Update imports for moved files to `@host/*` (or local relative within a dir). <!-- D-007 --> <!-- D-011 -->
  5. RED: Re-run the root-flatness guard and typecheck; capture remaining failures.
  6. REFACTOR: Batch related moves by destination dir so each commit is reviewable and bisectable. <!-- D-012 -->

#### M4: Semantic Renames and Init-Cycle Removal

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Run typecheck to expose stale imports for the renames. <!-- D-006 -->
  2. GREEN: `git mv` `context/` -> `project-context/`, `config-file.ts` -> `boot/config.ts`, `agents.ts` -> `subagents/`, `artifacts.ts` -> `agent/image-resolution.ts`; update all references. <!-- D-006 -->
  3. GREEN: Move `tasks.ts` -> `tools/tasks/` and remove the now-unnecessary leaf-import cycle-avoidance workaround in the task/skills modules. <!-- D-006 -->
  4. RED: Search for any remaining references to old paths/dir names across docs, tests, and snapshots.
  5. GREEN: Update those references; leave exported symbol names unchanged.
  6. REFACTOR: Delete obsolete cycle-avoidance comments and any temporary shims.

### Gate 2 -> 3

- [ ] No file remains loose under `src/` root except the allowlist.
- [ ] Typecheck passes; no stale path references remain.
- [ ] Unit, web, integration, turn, and e2e lanes pass.
- [ ] The host starts and runs a turn with no module-resolution errors.

### Phase 3: Headers, Architecture Map, and Enforcement

**Goal:** Every module is self-describing, the structure is documented for humans/contributors/docs-site, and the conventions are enforced against drift.

**Gate from previous:** Gate 2 passes.

#### M5: Header Docstrings and Architecture Map

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add the header presence/format check; it fails because host source files lack `Responsible for / Not for` headers. <!-- D-008 -->
  2. GREEN: Add structured headers to host source files in the fixed shape. <!-- D-008 -->
  3. RED: Add a check that `apps/agent-host/ARCHITECTURE.md` lists every subsystem dir; it fails initially. <!-- D-010 -->
  4. GREEN: Write `ARCHITECTURE.md` describing each subsystem dir and its responsibility - the seed for the future docs site. <!-- D-010 -->
  5. REFACTOR: Confirm the header shape is mechanically parseable for doc generation. <!-- D-008 -->

#### M6: Light Enforcement and Full Verification

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Prove a new loose `src/` root file fails the root-flatness guard and a header-less file fails the header check. <!-- D-009 -->
  2. GREEN: Wire both checks into the standard verification path (Vitest project / CI), independent of the current file list. <!-- D-009 -->
  3. GREEN: Run lint, typecheck, all relevant Vitest projects, and the hermetic e2e lane.
  4. REFACTOR: Record exact completed verification commands and confirm the heavy module-map manifest remains explicitly deferred. <!-- D-009 -->

### Done Gate

- [ ] No loose source files under `src/` root (allowlist only); header check green across host source.
- [ ] AGENTS.md, the host `ARCHITECTURE.md`, and the automated checks agree on the same structure/naming/header conventions.
- [ ] `git log --follow` resolves history across the moved files (pure-move commits verified).

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Move bundled with edits shreds git history | high | medium | Pure `git mv` commits, no content edits in the move commit; verify `log --follow`. <!-- D-012 --> | implementer |
| A "move" silently changes behavior | high | low | Structure-only; rely on green typecheck + turn/integration/e2e; reject logic edits in move commits. <!-- D-001 --> | implementer |
| `tools/tasks/` move reintroduces the init cycle | medium | medium | Co-locate with the tools barrel and remove the workaround only after import order is verified. <!-- D-006 --> | implementer |
| Headers rot into stale lies | medium | medium | Presence/format check enforced in CI is the maintenance guarantee. <!-- D-008 --> <!-- D-009 --> | implementer |
| Drift check legislates a first-draft layout | medium | medium | Keep enforcement light (root-flatness + header only); defer the module-map manifest. <!-- D-009 --> | implementer |
| Conflicts with downstream plans that cite moved paths | medium | medium | Thread forward-dependency accommodations into the affected later plans (26 here; 22.2-gated ones in 22.2). | implementer |
| `node-paths` storage drift test trips on a move | medium | low | Commit any drift-relevant change separately; keep the taxonomy green. | implementer |

## Escape Hatches

1. **If a relocation creates a large review diff:** split M3 by destination dir, one dir per commit, keeping each a pure move.
2. **If a rename's reference sweep is risky:** land each rename as its own commit so it can be reverted independently.
3. **If `tools/tasks/` cannot drop the cycle workaround safely:** keep the workaround, move the files anyway, and record the residual as a 22.2 follow-up.
4. **If the header check is too strict for vendored/generated files:** allowlist them explicitly and narrowly, not by broad glob.

## Progress Report Accounting

The progress report is the implementation resume state. It keeps current cutoff blockers separate from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "22.1-codebase-organization"
```

## Validation Commands

```bash
git ls-files apps/agent-host/src | rg '^apps/agent-host/src/[^/]+$'   # loose-root-file guard
pnpm lint
pnpm typecheck
pnpm test -- --project unit
pnpm test -- --project integration
pnpm test -- --project e2e
git log --follow -- apps/agent-host/src/<a-moved-file>   # history survives
```

## Decisions

Canonical decisions are in `.plans/22.1-codebase-organization/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "22.1-codebase-organization"
```

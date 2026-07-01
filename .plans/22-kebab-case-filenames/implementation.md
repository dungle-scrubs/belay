# Kebab-Case Filenames - Implementation Plan

## 0. Hard Dependencies

None.

## Architecture

Trevor should use kebab-case for repo-owned source and support files while preserving normal TypeScript and React symbol naming. <!-- D-001 --> A React component may still be exported as `PanelHost`, but its file should be `panel-host.tsx`; a story may still render `PanelHost`, but the story file should be `panel-host.stories.tsx`.

The migration is intentionally separate from feature work. <!-- D-005 --> It changes paths, imports, references, documentation policy, and enforcement only. It does not change runtime behavior, UI layout, protocol behavior, or task state behavior.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Source filenames are kebab-case | Repo-owned modules under `apps`, `packages`, `e2e`, scripts, tests, stories, and components should not use PascalCase filenames. <!-- D-001 --> |
| Convention docs are a separate class | `AGENTS.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `HOTKEYS.md`, and similar standard documentation files are not treated as PascalCase source filenames; changing them needs explicit owner confirmation. <!-- D-002 --> |
| AGENTS.md must capture the rule | The implementation updates AGENTS.md so future work creates kebab-case repo-owned filenames and avoids PascalCase component filenames. <!-- D-003 --> |
| Inventory comes first | The implementation starts from a tracked-file inventory and classification pass before any rename happens. <!-- D-004 --> |
| Git-aware moves are required | Use `git mv` and, when macOS case-insensitive filesystems need it, temporary intermediate names. <!-- D-006 --> |
| Enforcement prevents drift | Add a filename convention check to the standard verification path after the migration. <!-- D-007 --> |

### Boundaries

The plan owns filename policy, path migration, import/reference updates, and enforcement. It does not own design changes, component refactors, task panel behavior, tool state semantics, or AGENTS.md loading behavior.

Initial tracked examples found during planning include:

- `apps/web/src/app.tsx`
- `apps/web/src/artifact-thumb.tsx`
- `apps/web/src/tasks-panel.tsx`
- `apps/web/src/components/command-modal/command-modal.tsx`
- `apps/web/src/components/panel/panel-host.tsx`
- `apps/web/src/components/panel/side-panel.tsx`
- `apps/web/src/components/panel/treemap.tsx`
- `apps/web/src/components/panel/workspace-identity.tsx`
- `apps/web/src/resume/resume-modal.tsx`
- `apps/web/src/worktrees/worktree-modal.tsx`

The inventory phase must produce the authoritative list instead of relying on this planning sample. <!-- D-004 -->

### Observability

No runtime observability changes are required. This is a repository hygiene migration. The user-visible inspection surface is the final inventory report, failed filename check output, and normal test/typecheck failures.

## Phases

### Phase 1: Inventory and Policy

**Goal:** The repo has an explicit filename policy and a complete migration inventory before any path changes.

**Gate from previous:** none.

#### M1: Filename Inventory and Classification

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a failing convention-check fixture or test case that catches a PascalCase source filename.
  2. GREEN: Implement an inventory command or test helper that scans git-tracked files for uppercase filename segments.
  3. RED: Add fixtures or assertions that classify standard docs separately from source filenames.
  4. GREEN: Add an allowlist/classification table for conventional docs and any generated files that should be excluded. <!-- D-002 -->
  5. RED: Add a case proving story, test, and component source files are included in the migration set.
  6. GREEN: Produce the initial migration report with current PascalCase source paths and proposed kebab-case targets.
  7. REFACTOR: Keep inventory output stable, sorted, and reviewable.

#### M2: AGENTS.md Filename Policy

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a docs or lint assertion proving the repo policy mentions kebab-case filenames.
  2. GREEN: Add an AGENTS.md rule for repo-owned source filenames: use kebab-case; do not create PascalCase component filenames. <!-- D-003 -->
  3. GREEN: Clarify that exported symbols and component names may remain PascalCase even when filenames are kebab-case. <!-- D-001 -->
  4. GREEN: Document explicit exceptions for standard convention docs and generated files. <!-- D-002 -->
  5. REFACTOR: Keep the policy short and placed with other project-wide code conventions.

### Gate 1 -> 2

- [ ] Inventory report lists every current tracked PascalCase source, test, story, and script filename.
- [ ] AGENTS.md contains the future filename policy.
- [ ] Conventional documentation exceptions are explicit and owner-reviewable.

### Phase 2: Mechanical Rename

**Goal:** Existing source, test, and story filenames are migrated to kebab-case without behavioral changes.

**Gate from previous:** Gate 1 passes.

#### M3: Rename Source, Test, and Story Files

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Capture the current failing convention check against the inventory output.
  2. GREEN: Rename React component files from PascalCase to kebab-case using git-aware moves. <!-- D-006 -->
  3. GREEN: Rename matching `.test.tsx` and `.stories.tsx` files to kebab-case.
  4. GREEN: Rename top-level web source files such as app/task/artifact modules to kebab-case.
  5. GREEN: Rename any non-web source, test, story, script, or package files found by the inventory.
  6. GREEN: Use two-step temporary names for case-sensitive collisions on macOS where needed. <!-- D-006 -->
  7. RED: Re-run the filename check and capture remaining failures.
  8. REFACTOR: Batch related renames by directory so review remains readable.

#### M4: Update Imports and References

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Run typecheck to expose stale TypeScript imports.
  2. GREEN: Update static imports, dynamic imports, and path aliases for renamed files. <!-- D-008 -->
  3. RED: Search for old PascalCase basenames across docs, tests, stories, snapshots, and generated index surfaces.
  4. GREEN: Update non-TypeScript references that intentionally point at renamed paths. <!-- D-008 -->
  5. GREEN: Leave symbol names unchanged unless a reference is path-based.
  6. REFACTOR: Remove any temporary compatibility exports added during the rename.

### Gate 2 -> 3

- [ ] No stale references to renamed file paths remain.
- [ ] Typecheck passes after the mechanical rename.
- [ ] Unit, web, integration, and relevant story/test project lanes pass.
- [ ] The application starts with renamed imports and no module resolution errors.

### Phase 3: Enforcement and Verification

**Goal:** The convention is enforced locally and in CI, and the full verification bar has run.

**Gate from previous:** Gate 2 passes.

#### M5: Filename Convention Check

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add tests proving a new PascalCase source filename fails the convention check.
  2. GREEN: Implement the filename check with actionable output listing offending paths and expected kebab-case names. <!-- D-007 -->
  3. RED: Add tests proving conventional docs remain allowed.
  4. GREEN: Wire allowed exceptions into the check without broad glob escapes. <!-- D-002 -->
  5. GREEN: Add the check to the local verification path and CI/pre-commit path chosen by the repo.
  6. REFACTOR: Keep the check independent of the current migration list so it prevents future drift.

#### M6: Full Verification

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Confirm the filename check fails if a temporary PascalCase source fixture is introduced.
  2. GREEN: Run lint, typecheck, all relevant Vitest projects, and the hermetic e2e lane. <!-- D-009 -->
  3. GREEN: Run any full end-to-end capability lane required by the current Trevor test policy. <!-- D-009 -->
  4. REFACTOR: Update the progress report with exact completed verification commands and any deferred live-model gates.

### Done Gate

- [ ] `git ls-files` plus the convention check show no PascalCase repo-owned source/test/story/script filenames.
- [ ] AGENTS.md and the automated check agree on the same filename policy.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Missed non-TypeScript references | medium | medium | Search old basenames across the repo and include docs, stories, tests, snapshots, and generated indexes. <!-- D-008 --> | implementer |
| Case-insensitive filesystem misses a rename | medium | medium | Use git-aware moves and temporary intermediate names where needed. <!-- D-006 --> | implementer |
| Overbroad exception policy weakens enforcement | medium | low | Keep exceptions explicit and reviewable, not broad globs. <!-- D-002 --> | implementer |
| Rename mixed with behavior changes | high | low | Keep this plan mechanical and reject unrelated edits in the same batch. <!-- D-005 --> | implementer |
| CI misses future drift | medium | medium | Wire convention check into local and CI verification after migration. <!-- D-007 --> | implementer |

## Escape Hatches

1. **If a third-party tool requires a specific PascalCase filename:** classify it as an explicit exception with evidence, add it to AGENTS.md, and keep the enforcement allowlist narrow.
2. **If a rename creates a large review diff:** split the mechanical rename by directory while keeping the same policy and enforcement gates.
3. **If full e2e capability testing is unavailable:** record the missing prerequisite and do not mark the plan complete until the required lane runs or the owner explicitly accepts the deferred gate. <!-- D-009 -->

## Progress Report Accounting

The progress report is the implementation resume state. It must keep current cutoff blockers separate from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "22-kebab-case-filenames"
```

## Validation Commands

```bash
git ls-files | rg '(^|/)[^/]*[A-Z][^/]*$'
pnpm lint
pnpm typecheck
pnpm test
pnpm test -- --project unit
pnpm test -- --project web
pnpm test -- --project integration
pnpm test -- --project e2e
```

## Decisions

Canonical decisions are in `.plans/22-kebab-case-filenames/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "22-kebab-case-filenames"
```

# Kebab-Case Filenames - Progress Report

## Summary

- Current focus: M1 - Filename Inventory and Classification
- Current cutoff blockers: 45
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 0

## Current Cutoff Blockers

### Phase 1: Inventory and Policy

#### M1: Filename Inventory and Classification

- [ ] RED: Add a failing convention-check fixture or test case that catches a PascalCase source filename.
- [ ] GREEN: Implement an inventory command or test helper that scans git-tracked files for uppercase filename segments.
- [ ] RED: Add fixtures or assertions that classify standard docs separately from source filenames.
- [ ] GREEN: Add an allowlist/classification table for conventional docs and any generated files that should be excluded.
- [ ] RED: Add a case proving story, test, and component source files are included in the migration set.
- [ ] GREEN: Produce the initial migration report with current PascalCase source paths and proposed kebab-case targets.
- [ ] REFACTOR: Keep inventory output stable, sorted, and reviewable.

#### M2: AGENTS.md Filename Policy

- [ ] RED: Add a docs or lint assertion proving the repo policy mentions kebab-case filenames.
- [ ] GREEN: Add an AGENTS.md rule for repo-owned source filenames: use kebab-case; do not create PascalCase component filenames.
- [ ] GREEN: Clarify that exported symbols and component names may remain PascalCase even when filenames are kebab-case.
- [ ] GREEN: Document explicit exceptions for standard convention docs and generated files.
- [ ] REFACTOR: Keep the policy short and placed with other project-wide code conventions.

### Gate 1 -> 2

- [ ] Inventory report lists every current tracked PascalCase source, test, story, and script filename.
- [ ] AGENTS.md contains the future filename policy.
- [ ] Conventional documentation exceptions are explicit and owner-reviewable.

### Phase 2: Mechanical Rename

#### M3: Rename Source, Test, and Story Files

- [ ] RED: Capture the current failing convention check against the inventory output.
- [ ] GREEN: Rename React component files from PascalCase to kebab-case using git-aware moves.
- [ ] GREEN: Rename matching `.test.tsx` and `.stories.tsx` files to kebab-case.
- [ ] GREEN: Rename top-level web source files such as app/task/artifact modules to kebab-case.
- [ ] GREEN: Rename any non-web source, test, story, script, or package files found by the inventory.
- [ ] GREEN: Use two-step temporary names for case-sensitive collisions on macOS where needed.
- [ ] RED: Re-run the filename check and capture remaining failures.
- [ ] REFACTOR: Batch related renames by directory so review remains readable.

#### M4: Update Imports and References

- [ ] RED: Run typecheck to expose stale TypeScript imports.
- [ ] GREEN: Update static imports, dynamic imports, and path aliases for renamed files.
- [ ] RED: Search for old PascalCase basenames across docs, tests, stories, snapshots, and generated index surfaces.
- [ ] GREEN: Update non-TypeScript references that intentionally point at renamed paths.
- [ ] GREEN: Leave symbol names unchanged unless a reference is path-based.
- [ ] REFACTOR: Remove any temporary compatibility exports added during the rename.

### Gate 2 -> 3

- [ ] No stale references to renamed file paths remain.
- [ ] Typecheck passes after the mechanical rename.
- [ ] Unit, web, integration, and relevant story/test project lanes pass.
- [ ] The application starts with renamed imports and no module resolution errors.

### Phase 3: Enforcement and Verification

#### M5: Filename Convention Check

- [ ] RED: Add tests proving a new PascalCase source filename fails the convention check.
- [ ] GREEN: Implement the filename check with actionable output listing offending paths and expected kebab-case names.
- [ ] RED: Add tests proving conventional docs remain allowed.
- [ ] GREEN: Wire allowed exceptions into the check without broad glob escapes.
- [ ] GREEN: Add the check to the local verification path and CI/pre-commit path chosen by the repo.
- [ ] REFACTOR: Keep the check independent of the current migration list so it prevents future drift.

#### M6: Full Verification

- [ ] RED: Confirm the filename check fails if a temporary PascalCase source fixture is introduced.
- [ ] GREEN: Run lint, typecheck, all relevant Vitest projects, and the hermetic e2e lane.
- [ ] GREEN: Run any full end-to-end capability lane required by the current Trevor test policy.
- [ ] REFACTOR: Update the progress report with exact completed verification commands and any deferred live-model gates.

### Done Gate

- [ ] `git ls-files` plus the convention check show no PascalCase repo-owned source/test/story/script filenames.
- [ ] AGENTS.md and the automated check agree on the same filename policy.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

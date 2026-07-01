# Kebab-Case Filenames - Progress Report

## Summary

- Current focus: Complete
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 45

## Current Cutoff Blockers

### Phase 1: Inventory and Policy

#### M1: Filename Inventory and Classification

- [x] RED: Add a failing convention-check fixture or test case that catches a PascalCase source filename.
- [x] GREEN: Implement an inventory command or test helper that scans git-tracked files for uppercase filename segments.
- [x] RED: Add fixtures or assertions that classify standard docs separately from source filenames.
- [x] GREEN: Add an allowlist/classification table for conventional docs and any generated files that should be excluded.
- [x] RED: Add a case proving story, test, and component source files are included in the migration set.
- [x] GREEN: Produce the initial migration report with current PascalCase source paths and proposed kebab-case targets.
- [x] REFACTOR: Keep inventory output stable, sorted, and reviewable.

#### M2: AGENTS.md Filename Policy

- [x] RED: Add a docs or lint assertion proving the repo policy mentions kebab-case filenames.
- [x] GREEN: Add an AGENTS.md rule for repo-owned source filenames: use kebab-case; do not create PascalCase component filenames.
- [x] GREEN: Clarify that exported symbols and component names may remain PascalCase even when filenames are kebab-case.
- [x] GREEN: Document explicit exceptions for standard convention docs and generated files.
- [x] REFACTOR: Keep the policy short and placed with other project-wide code conventions.

### Gate 1 -> 2

- [x] Inventory report lists every current tracked PascalCase source, test, story, and script filename.
- [x] AGENTS.md contains the future filename policy.
- [x] Conventional documentation exceptions are explicit and owner-reviewable.

### Phase 2: Mechanical Rename

#### M3: Rename Source, Test, and Story Files

- [x] RED: Capture the current failing convention check against the inventory output.
- [x] GREEN: Rename React component files from PascalCase to kebab-case using git-aware moves.
- [x] GREEN: Rename matching `.test.tsx` and `.stories.tsx` files to kebab-case.
- [x] GREEN: Rename top-level web source files such as app/task/artifact modules to kebab-case.
- [x] GREEN: Rename any non-web source, test, story, script, or package files found by the inventory.
- [x] GREEN: Use two-step temporary names for case-sensitive collisions on macOS where needed.
- [x] RED: Re-run the filename check and capture remaining failures.
- [x] REFACTOR: Batch related renames by directory so review remains readable.

#### M4: Update Imports and References

- [x] RED: Run typecheck to expose stale TypeScript imports.
- [x] GREEN: Update static imports, dynamic imports, and path aliases for renamed files.
- [x] RED: Search for old PascalCase basenames across docs, tests, stories, snapshots, and generated index surfaces.
- [x] GREEN: Update non-TypeScript references that intentionally point at renamed paths.
- [x] GREEN: Leave symbol names unchanged unless a reference is path-based.
- [x] REFACTOR: Remove any temporary compatibility exports added during the rename.

### Gate 2 -> 3

- [x] No stale references to renamed file paths remain.
- [x] Typecheck passes after the mechanical rename.
- [x] Unit, web, integration, and relevant story/test project lanes pass.
- [x] The application starts with renamed imports and no module resolution errors.

### Phase 3: Enforcement and Verification

#### M5: Filename Convention Check

- [x] RED: Add tests proving a new PascalCase source filename fails the convention check.
- [x] GREEN: Implement the filename check with actionable output listing offending paths and expected kebab-case names.
- [x] RED: Add tests proving conventional docs remain allowed.
- [x] GREEN: Wire allowed exceptions into the check without broad glob escapes.
- [x] GREEN: Add the check to the local verification path and CI/pre-commit path chosen by the repo.
- [x] REFACTOR: Keep the check independent of the current migration list so it prevents future drift.

#### M6: Full Verification

- [x] RED: Confirm the filename check fails if a temporary PascalCase source fixture is introduced.
- [x] GREEN: Run lint, typecheck, all relevant Vitest projects, and the hermetic e2e lane.
- [x] GREEN: Run any full end-to-end capability lane required by the current Trevor test policy.
- [x] REFACTOR: Update the progress report with exact completed verification commands and any deferred live-model gates.

### Done Gate

- [x] `git ls-files` plus the convention check show no PascalCase repo-owned source/test/story/script filenames.
- [x] AGENTS.md and the automated check agree on the same filename policy.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

## Verification Notes

Completed on 2026-07-01 from `/Users/kevin/dev/.trevor-wt/22-kebab-case-filenames`:

- `pnpm check:filenames` - passed; only conventional uppercase docs remain in raw `git ls-files` output.
- `pnpm lint` - passed; runs Biome plus filename policy.
- `pnpm typecheck` - passed across workspace projects.
- `pnpm test` - passed: 347 files passed, 3 skipped; 2725 tests passed, 3 skipped. Includes the hermetic e2e Vitest project.
- Live-model e2e was not part of this plan's required gate and was not run.

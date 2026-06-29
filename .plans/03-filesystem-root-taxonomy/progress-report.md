# Filesystem Root Taxonomy - Progress Report

## Summary

- Current cutoff blockers: 31
- Completed: 33 (4 shipped pre-plan D-009; 10 in M1; 9 in M2; 10 in M3)
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Current Focus

Blockers

## Current Cutoff Blockers

### Phase 1: Root Policy Model

#### M1: Root categories and helpers

- [x] RED: Add unit tests for a root-policy helper that resolves all approved root categories.
- [x] GREEN: Extend or add host root helpers for durable home, debug state, legacy service data, temp, browser-ephemeral label metadata, and external integration roots.
- [x] GREEN: Keep CLI coupling minimal by mirroring only the documented `TREVOR_HOME` contract where needed. (CLI imports TREVOR_HOME/TREVOR_STATE_HOME from @trevor/session/node-paths; no host-package coupling)
- [x] REFACTOR: Name categories by ownership and lifecycle, not by incidental path strings. (RootCategory has `ownership` + `lifecycle`)
- [x] RED: Add tests proving env overrides affect only the intended root.
- [x] GREEN: Keep `TREVOR_HOME` and `TREVOR_STATE_HOME` resolved and normalized before use. (resolvers call `resolve()`)
- [x] REFACTOR: Document root ownership in the relevant path modules. (node-paths.ts owns; host paths.ts documents it as the consumer entry)
- [x] Root categories are represented by one tested read model. (`resolveRootPolicy`)
- [x] Host consumers do not re-spell home-relative defaults.
- [x] CLI coupling remains intentional and documented.

### Phase 2: Existing Storage Inventory

#### M2: Inventory and classification

- [x] RED: Add a storage-inventory test or snapshot that covers known Trevor-owned paths and legacy paths.
- [x] GREEN: Classify `AGENTS.md`, project/session maps, locks, managed worktrees, launcher logs, provider observations, service DBs, blob bytes, performance artifacts, and doctor fixtures. (`STORAGE_INVENTORY`; doctor fixtures are test-only display data)
- [x] GREEN: Mark `~/.trevor` service data as legacy service data, not as a new-feature target.
- [x] GREEN: Mark `~/.pi` and `~/.agents` as external roots that Trevor can read but not own.
- [x] RED: Add tests that fail if a new home-relative Trevor path is introduced without classification. (`node-paths-drift.test.ts`)
- [x] GREEN: Add an explicit escape hatch requiring plan/docs update for new roots. (the inventory + its doc comment is the single declaration)
- [x] Current path usage has a clear classification.
- [x] The inventory distinguishes durable product state, debug diagnostics, legacy service data, scratch, browser state, and external roots.
- [x] New root drift is caught by tests or reviewable checks.

(The M2 "Replace scattered root labels in diagnostics with shared labels" refactor moved to Phase 5 M5, where the doctor consumes the shared `RootCategory` labels.)

### Phase 3: Legacy Service Migration Plan

#### M3: Safe migration planning

- [x] RED: Add unit tests for migration planning with no legacy data, legacy DB only, legacy blobs only, both present, explicit overrides, and already-migrated state.
- [x] GREEN: Design forward-migration target paths for legacy `~/.trevor` session-store DB and blob-store bytes under the STATE home (`${TREVOR_STATE_HOME}/sessions.db`, `${TREVOR_STATE_HOME}/blobs`).
- [x] GREEN: Preserve `SESSION_STORE_DB` and `BLOB_STORE_DIR` as absolute override escapes that bypass default migration. (`skip-overridden`)
- [x] GREEN: Create an idempotent migration plan object with actions, source paths, target paths, backup paths, skipped reasons, and rollback notes. (copy-not-move leaves the legacy source as the backup; `rollbackNotes` documents it)
- [x] RED: Add tests for partial copy failure and target conflict behavior.
- [x] GREEN: Require backup or no-op proof before moving user data. (executor copies, never moves; re-checks the target before writing)
- [x] REFACTOR: Keep migration planning pure and make the mutating executor small. (pure `planLegacyMigration` + small `executeLegacyMigration` over an injected `MigrationFs`)
- [x] Migration cannot silently overwrite existing service data.
- [x] Explicit service path overrides keep working.
- [x] The old `~/.trevor` data remains readable until migration is complete and verified.

### Phase 4: Service Default Cutover

#### M4: Compatible default change

The service-default cutover to the STATE home already shipped before this plan (D-009): the store configs default to `${TREVOR_STATE_HOME}/...`, `SESSION_STORE_DB`/`BLOB_STORE_DIR` still win, and no `homedir() + ".trevor"` defaults remain. Remaining current-cutoff work is regression coverage and routing the resolved defaults through the Phase-1 root policy plus the Phase-3 legacy detector.

- [ ] RED: Add integration tests for session-store and blob-store default root selection (resolved through the root policy).
- [ ] GREEN: Route service-entrypoint default resolution through the Phase-1 root policy.
- [ ] GREEN: On startup, detect legacy `~/.trevor` data (via the Phase-3 detector) and log a sanitized migration-available status; do NOT change defaults.
- [ ] GREEN: Log sanitized root paths and legacy/migration status.
- [ ] RED: Add tests that old env overrides still win over defaults.
- [x] GREEN: Keep old data untouched when overrides point elsewhere. (shipped pre-plan, D-009)
- [x] REFACTOR: Remove duplicated `homedir() + ".trevor"` defaults after compatibility is covered. (shipped pre-plan, D-009)
- [x] New installs use the approved root layout. (shipped pre-plan, D-009)
- [ ] Existing installs keep their sessions and blobs. (covered by the Phase-3 legacy detector)
- [x] Override-based installs are not migrated unexpectedly. (shipped pre-plan, D-009 - no migration runs)

### Phase 5: Doctor and UI Diagnostics

#### M5: Storage/Roots diagnostics

- [ ] RED: Add doctor snapshot tests for root categories, writability, legacy migration debt, explicit overrides, and missing roots.
- [ ] GREEN: Add a Storage/Roots section that reports config, durable product state, debug state, legacy service data, temp, and external roots.
- [ ] GREEN: Include status values such as ok, missing, not writable, overridden, legacy, migration available, and external.
- [ ] GREEN: Sanitize and abbreviate paths consistently.
- [ ] RED: Add web dashboard tests for long paths, invalid roots, legacy warnings, and external roots.
- [ ] GREEN: Render root findings through the existing doctor dashboard, not raw terminal text only.
- [ ] REFACTOR: Share doctor fixture labels with the root inventory.
- [ ] `/doctor` can explain root placement and migration debt.
- [ ] Long paths and errors wrap cleanly in the web dashboard.
- [ ] Diagnostics do not expose secrets or raw environment dumps.

### Phase 6: Future-Feature Guardrails

#### M6: Drift prevention

- [ ] RED: Add tests or lint-style checks for forbidden new Trevor-owned home dotdirs.
- [ ] GREEN: Add developer guidance pointing new file-backed features to the root helpers.
- [ ] GREEN: Update standalone plans that mention storage roots to point to this plan when they need durable state, debug artifacts, or service data.
- [ ] GREEN: Ensure `05-docs-tool`, `15-loop-command-surface`, `14-hooks-runtime`, `13-lsp-integration`, `16-telemetry-observability`, `10-large-paste-placeholders`, and future command plans do not invent conflicting roots.
- [ ] REFACTOR: Keep the root taxonomy summarized in `AGENTS.md` and detailed here.
- [ ] New plans/features have a single place to cite for storage placement.
- [ ] Root usage remains reviewable.
- [ ] The taxonomy is enforced by tests and documentation, not only memory.

### Verification

- [ ] Unit tests cover root resolution, environment overrides, inventory classification, and migration planning.
- [ ] Integration tests cover session-store and blob-store default behavior before and after migration.
- [ ] Doctor tests cover root statuses, redaction, and legacy migration debt.
- [ ] Web tests or Storybook states cover Storage/Roots dashboard rendering.
- [ ] Manual EZE repro: run against a clean install and verify roots, service startup, and `/doctor`.
- [ ] Manual EZE repro: run against an install with existing `~/.trevor/sessions.db` and `~/.trevor/blobs`, migrate or compatibility-start, and verify sessions plus artifacts remain available.
- [ ] Manual EZE repro: run with `TREVOR_HOME`, `XDG_STATE_HOME`, `SESSION_STORE_DB`, and `BLOB_STORE_DIR` overrides and verify `/doctor` reports the correct source of truth.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

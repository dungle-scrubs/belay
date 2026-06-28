# Filesystem Root Taxonomy - Progress Report

## Summary

- Current cutoff blockers: 65
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Current Focus

Blockers

## Current Cutoff Blockers

### Phase 1: Root Policy Model

#### M1: Root categories and helpers

- [ ] RED: Add unit tests for a root-policy helper that resolves all approved root categories.
- [ ] GREEN: Extend or add host root helpers for durable home, debug state, legacy service data, temp, browser-ephemeral label metadata, and external integration roots.
- [ ] GREEN: Keep CLI coupling minimal by mirroring only the documented `TREVOR_HOME` contract where needed.
- [ ] REFACTOR: Name categories by ownership and lifecycle, not by incidental path strings.
- [ ] RED: Add tests proving env overrides affect only the intended root.
- [ ] GREEN: Keep `TREVOR_HOME` and `TREVOR_STATE_HOME` resolved and normalized before use.
- [ ] REFACTOR: Document root ownership in the relevant path modules.
- [ ] Root categories are represented by one tested read model.
- [ ] Host consumers do not re-spell home-relative defaults.
- [ ] CLI coupling remains intentional and documented.

### Phase 2: Existing Storage Inventory

#### M2: Inventory and classification

- [ ] RED: Add a storage-inventory test or snapshot that covers known Trevor-owned paths and legacy paths.
- [ ] GREEN: Classify `AGENTS.md`, project/session maps, locks, managed worktrees, launcher logs, provider observations, service DBs, blob bytes, performance artifacts, and doctor fixtures.
- [ ] GREEN: Mark `~/.trevor` service data as legacy service data, not as a new-feature target.
- [ ] GREEN: Mark `~/.pi` and `~/.agents` as external roots that Trevor can read but not own.
- [ ] REFACTOR: Replace scattered root labels in diagnostics with shared labels from the inventory.
- [ ] RED: Add tests that fail if a new home-relative Trevor path is introduced without classification.
- [ ] GREEN: Add an explicit escape hatch requiring plan/docs update for new roots.
- [ ] Current path usage has a clear classification.
- [ ] The inventory distinguishes durable product state, debug diagnostics, legacy service data, scratch, browser state, and external roots.
- [ ] New root drift is caught by tests or reviewable checks.

### Phase 3: Legacy Service Migration Plan

#### M3: Safe migration planning

- [ ] RED: Add unit tests for migration planning with no legacy data, legacy DB only, legacy blobs only, both present, explicit overrides, and already-migrated state.
- [ ] GREEN: Design target paths for session-store DB and blob-store bytes under the approved durable/service root layout.
- [ ] GREEN: Preserve `SESSION_STORE_DB` and `BLOB_STORE_DIR` as absolute override escapes that bypass default migration.
- [ ] GREEN: Create an idempotent migration plan object with actions, source paths, target paths, backup paths, skipped reasons, and rollback notes.
- [ ] RED: Add tests for partial copy failure and target conflict behavior.
- [ ] GREEN: Require backup or no-op proof before moving user data.
- [ ] REFACTOR: Keep migration planning pure and make the mutating executor small.
- [ ] Migration cannot silently overwrite existing service data.
- [ ] Explicit service path overrides keep working.
- [ ] The old `~/.trevor` data remains readable until migration is complete and verified.

### Phase 4: Service Default Cutover

#### M4: Compatible default change

- [ ] RED: Add integration tests for session-store and blob-store default root selection.
- [ ] GREEN: Update service entrypoints to resolve defaults through the root policy after the migration planner exists.
- [ ] GREEN: On startup, detect legacy data and either use compatibility mode or run the explicit migration path, depending on the chosen product behavior.
- [ ] GREEN: Log sanitized root paths and migration status.
- [ ] RED: Add tests that old env overrides still win over defaults.
- [ ] GREEN: Keep old data untouched when overrides point elsewhere.
- [ ] REFACTOR: Remove duplicated `homedir() + ".trevor"` defaults after compatibility is covered.
- [ ] New installs use the approved root layout.
- [ ] Existing installs keep their sessions and blobs.
- [ ] Override-based installs are not migrated unexpectedly.

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

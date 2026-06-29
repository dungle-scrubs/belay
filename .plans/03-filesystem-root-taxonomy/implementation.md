# Filesystem Root Taxonomy - Implementation Plan

## 0. Hard Dependencies

None.

## 1. Outcome

Trevor needs one explicit filesystem-root policy that every file-backed feature follows. <!-- D-001 --> The policy is:

- `TREVOR_HOME`, defaulting to `~/.trevorV2`, owns user settings and editable config (user-global `AGENTS.md`, `.env.op`, `auth.json`, `config.jsonc`).
- `TREVOR_STATE_HOME`, defaulting to `${XDG_STATE_HOME:-~/.local/state}/trevorV2`, owns ALL machine-local runtime state the app owns: the session-store SQLite database, blob-store bytes, managed worktrees, host/lock/project registries, launcher logs, provider observations, and best-effort debug metrics/traces/diagnostics. <!-- D-009 -->
- Legacy `~/.trevor` holds only old data from pre-XDG-split runs; the service-default cutover to the STATE home already shipped, so Trevor detects legacy data but never defaults new writes there. <!-- D-009 -->
- OS temp owns scratch work.
- Browser storage owns browser-only ephemeral UI state.
- External roots such as `~/.pi` and `~/.agents` remain externally owned. <!-- D-007 -->

This plan extracts the old D-069 filesystem-root taxonomy from `.plans/trevor-v2/implementation.md` and reconciles it with the shipped host/CLI path modules. Where `AGENTS.md`'s taxonomy text disagreed with the shipped code (it described the STATE home as debug-only and durable service data as `TREVOR_HOME`/legacy `~/.trevor`), this plan corrects `AGENTS.md` to match the implemented XDG split. <!-- D-009 -->

## 2. Current State

- `packages/session/src/node-paths.ts` is the single owner of the env overrides and default directory names: `resolveTrevorHome`/`TREVOR_HOME` and `resolveTrevorStateHome`/`TREVOR_STATE_HOME`.
- `apps/agent-host/src/paths.ts` re-exports `TREVOR_HOME`/`TREVOR_STATE_HOME` from `@trevor/session/node-paths` and adds workspace confinement + `abbrevHome`.
- `apps/trevor-cli/src/project.ts` imports `TREVOR_HOME`/`TREVOR_STATE_HOME` from `@trevor/session/node-paths` directly - no hand-rolled mirror. <!-- D-002 -->
- `apps/session-store/src/config.ts` already defaults `SESSION_STORE_DB` to `${TREVOR_STATE_HOME}/sessions.db`; `apps/blob-store/src/config.ts` already defaults `BLOB_STORE_DIR` to `${TREVOR_STATE_HOME}/blobs`. The `~/.trevor` defaults were already retired - the Phase 4 cutover is shipped. <!-- D-009 -->
- `apps/agent-host/src/doctor/{build,snapshot}.ts` already surface a single STATE-home writability check (`storage.home`), but the categorized Storage/Roots section (config, state, legacy, temp, external) does not exist yet.
- No automated legacy `~/.trevor` detection or migration exists.
- `apps/agent-host/src/providers/observation-store.ts` writes provider observations under the STATE home.
- There is no central root-policy read model enumerating all categories, no storage inventory, and no drift guardrails yet.

## 3. Non-Goals

- Do not rewrite unrelated feature storage.
- Do not move existing `~/.trevor` data opportunistically during unrelated work.
- Do not re-home `~/.pi` or `~/.agents`.
- Do not introduce `~/.config/trevor` as a default root in this plan.
- Do not change browser draft/sessionStorage behavior except to document it in diagnostics if useful.

## 4. Architecture Decisions

| Area | Decision |
|---|---|
| Root taxonomy | The shipped XDG split: `TREVOR_HOME` = config/user settings; `TREVOR_STATE_HOME` = ALL machine-local runtime state (sessions.db, blobs, worktrees, registries, logs, observations, diagnostics); legacy `~/.trevor` = old data only; temp in OS temp; browser ephemeral state in browser storage; external roots left externally owned. <!-- D-009 --> |
| Root source of truth | `@trevor/session/node-paths` owns the env overrides and default names; the host re-exports them via `apps/agent-host/src/paths.ts`; the CLI imports the `TREVOR_HOME`/`TREVOR_STATE_HOME` contract from `@trevor/session/node-paths` directly. <!-- D-002 --> |
| Legacy service data | The `~/.trevor` service-default cutover already shipped (configs default to the STATE home). `~/.trevor` data may still exist on old installs; Trevor only detects it and never defaults new writes there. <!-- D-009 --> |
| Migration safety | If an optional legacy detector copies `~/.trevor` data forward, it must be explicit, idempotent, backup-aware, rollback-aware, and must not override `SESSION_STORE_DB`/`BLOB_STORE_DIR`. <!-- D-004 --> |
| Doctor visibility | `/doctor` reports resolved config, state, debug-state, legacy-service, temp, and external roots with status and sanitized paths. <!-- D-005 --> |
| Future feature rule | New file-backed features consume approved root helpers or explicitly amend this plan before adding a new root. <!-- D-006 --> |
| External roots | Trevor may read `~/.pi` and `~/.agents` for integrations, but does not own or migrate them. <!-- D-007 --> |
| Test scope | Unit, integration, doctor UI, and manual EZE checks are required. <!-- D-008 --> |

## 5. Implementation Sequence

### Phase 1: Root Policy Model

**Goal:** Make root categories concrete and testable.

1. RED: Add unit tests for a root-policy helper that resolves all approved root categories from environment and platform inputs.
2. GREEN: Extend or add host root helpers for durable home, debug state, legacy service data, temp, browser-ephemeral label metadata, and external integration roots. <!-- D-001 -->
3. GREEN: Keep CLI coupling minimal by mirroring only the documented `TREVOR_HOME` contract where the CLI must stay host-package-independent. <!-- D-002 -->
4. REFACTOR: Name categories by ownership and lifecycle, not by incidental path strings.
5. RED: Add tests proving env overrides affect only the intended root.
6. GREEN: Keep `TREVOR_HOME` and `TREVOR_STATE_HOME` resolved and normalized before use.
7. REFACTOR: Document in code comments which modules own root resolution and which modules only consume it.

**Acceptance:**

- [ ] Root categories are represented by one tested read model.
- [ ] Host consumers do not re-spell home-relative defaults.
- [ ] CLI coupling remains intentional and documented.

### Phase 2: Existing Storage Inventory

**Goal:** Classify every current file-backed path against the root policy before migration.

1. RED: Add a storage-inventory test or snapshot that covers known Trevor-owned paths and legacy paths.
2. GREEN: Classify `AGENTS.md`, project/session maps, locks, managed worktrees, launcher logs, provider observations, service DBs, blob bytes, performance artifacts, and doctor fixtures.
3. GREEN: Mark `~/.trevor` service data as legacy service data, not as a new-feature target. <!-- D-003 -->
4. GREEN: Mark `~/.pi` and `~/.agents` as external roots that Trevor can read but not own. <!-- D-007 -->
5. REFACTOR: Replace scattered root labels in diagnostics with shared labels from the inventory.
6. RED: Add tests that fail if a new home-relative Trevor path is introduced without classification.
7. GREEN: Add an explicit escape hatch requiring plan/docs update for new roots. <!-- D-006 -->

**Acceptance:**

- [ ] Current path usage has a clear classification.
- [ ] The inventory distinguishes durable product state, debug diagnostics, legacy service data, scratch, browser state, and external roots.
- [ ] New root drift is caught by tests or reviewable checks.

### Phase 3: Legacy `~/.trevor` Detection and Migration Planning

**Goal:** Detect leftover `~/.trevor` service data on old installs and plan an optional, safe forward-migration. The default cutover to the STATE home already shipped (see Phase 4); this phase does NOT change defaults. <!-- D-009 -->

1. RED: Add unit tests for migration planning with no legacy data, legacy DB only, legacy blobs only, both present, explicit overrides, and already-migrated state.
2. GREEN: Design target paths for session-store DB and blob-store bytes under the approved durable/service root layout.
3. GREEN: Preserve `SESSION_STORE_DB` and `BLOB_STORE_DIR` as absolute override escapes that bypass default migration. <!-- D-004 -->
4. GREEN: Create an idempotent migration plan object with actions, source paths, target paths, backup paths, skipped reasons, and rollback notes.
5. RED: Add tests for partial copy failure and target conflict behavior.
6. GREEN: Require backup or no-op proof before moving user data.
7. REFACTOR: Keep migration planning pure and make the mutating executor small.

**Acceptance:**

- [ ] Migration cannot silently overwrite existing service data.
- [ ] Explicit service path overrides keep working.
- [ ] The old `~/.trevor` data remains readable until migration is complete and verified.

### Phase 4: Service Default Cutover (ALREADY SHIPPED)

**Goal:** Change defaults without losing compatibility. **Status: done before this plan** - `apps/session-store/src/config.ts` and `apps/blob-store/src/config.ts` already default to `${TREVOR_STATE_HOME}/sessions.db` and `${TREVOR_STATE_HOME}/blobs`, `SESSION_STORE_DB`/`BLOB_STORE_DIR` still win, and the old `homedir() + ".trevor"` defaults are gone. Remaining plan work is regression coverage proving overrides win and defaults resolve through the root policy, plus wiring the Phase 3 legacy detector into startup logging. <!-- D-009 -->

1. RED: Add integration tests for session-store and blob-store default root selection.
2. GREEN: Update service entrypoints to resolve defaults through the root policy after the migration planner exists.
3. GREEN: On startup, detect legacy data and either use compatibility mode or run the explicit migration path, depending on the chosen product behavior.
4. GREEN: Log sanitized root paths and migration status.
5. RED: Add tests that old env overrides still win over defaults.
6. GREEN: Keep old data untouched when overrides point elsewhere.
7. REFACTOR: Remove duplicated `homedir() + ".trevor"` defaults after compatibility is covered.

**Acceptance:**

- [ ] New installs use the approved root layout.
- [ ] Existing installs keep their sessions and blobs.
- [ ] Override-based installs are not migrated unexpectedly.

### Phase 5: Doctor and UI Diagnostics

**Goal:** Make root state inspectable without leaking sensitive path detail.

1. RED: Add doctor snapshot tests for root categories, writability, legacy migration debt, explicit overrides, and missing roots.
2. GREEN: Add a Storage/Roots section that reports config, durable product state, debug state, legacy service data, temp, and external roots. <!-- D-005 -->
3. GREEN: Include status values such as ok, missing, not writable, overridden, legacy, migration available, and external.
4. GREEN: Sanitize and abbreviate paths consistently.
5. RED: Add web dashboard tests for long paths, invalid roots, legacy warnings, and external roots.
6. GREEN: Render root findings through the existing doctor dashboard, not raw terminal text only.
7. REFACTOR: Share doctor fixture labels with the root inventory.

**Acceptance:**

- [ ] `/doctor` can explain root placement and migration debt.
- [ ] Long paths and errors wrap cleanly in the web dashboard.
- [ ] Diagnostics do not expose secrets or raw environment dumps.

### Phase 6: Future-Feature Guardrails

**Goal:** Keep the taxonomy from drifting again.

1. RED: Add tests or lint-style checks for forbidden new Trevor-owned home dotdirs.
2. GREEN: Add developer guidance pointing new file-backed features to the root helpers.
3. GREEN: Update standalone plans that mention storage roots to point to this plan when they need durable state, debug artifacts, or service data. <!-- D-006 -->
4. GREEN: Ensure `05-docs-tool`, `15-loop-command-surface`, `14-hooks-runtime`, `13-lsp-integration`, `16-telemetry-observability`, `10-large-paste-placeholders`, and future command plans do not invent conflicting roots.
5. REFACTOR: Keep the root taxonomy summarized in `AGENTS.md` and detailed here.

**Acceptance:**

- [ ] New plans/features have a single place to cite for storage placement.
- [ ] Root usage remains reviewable.
- [ ] The taxonomy is enforced by tests and documentation, not only memory.

## 6. Verification

Implementation is done only after:

- [ ] Unit tests cover root resolution, environment overrides, inventory classification, and migration planning. <!-- D-008 -->
- [ ] Integration tests cover session-store and blob-store default behavior before and after migration. <!-- D-008 -->
- [ ] Doctor tests cover root statuses, redaction, and legacy migration debt. <!-- D-008 -->
- [ ] Web tests or Storybook states cover Storage/Roots dashboard rendering. <!-- D-008 -->
- [ ] Manual EZE repro: run against a clean install and verify roots, service startup, and `/doctor`.
- [ ] Manual EZE repro: run against an install with existing `~/.trevor/sessions.db` and `~/.trevor/blobs`, migrate or compatibility-start, and verify sessions plus artifacts remain available.
- [ ] Manual EZE repro: run with `TREVOR_HOME`, `XDG_STATE_HOME`, `SESSION_STORE_DB`, and `BLOB_STORE_DIR` overrides and verify `/doctor` reports the correct source of truth.

## 7. Progress Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "03-filesystem-root-taxonomy"
```

## 8. Decision Ledger

Canonical decisions are in `.plans/03-filesystem-root-taxonomy/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "03-filesystem-root-taxonomy"
```

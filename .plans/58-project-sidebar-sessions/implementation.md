# Project Sidebar Sessions - Implementation Plan

## 0. Hard Dependencies

- [x] Existing launcher/supervisor boundary - `@trevor/launcher` already owns project root resolution, host spawn/reuse, host registry, locks, and shared service readiness; `apps/supervisor` already handles control-session requests for launch, folder pick, and project listing.
- [x] Existing session inventory read model - session-store already projects `SessionSummary` with title, cwd/workspace, branch, activity, host presence, archived, deleted, fork lineage, and tangent lineage.
- [x] Existing durable session markers - `session.title`, `session.archived`, and `session.deleted` already provide rename/archive/delete behavior without adding a second session state store.
- [x] Existing archive browser and permanent delete gate - archived sessions already have a separate management surface and protected permanent-delete checks.
- [ ] Downstream `.plans/48-desktop-shell-tauri` accommodation - desktop session UX must consume this plan's project registry and fresh project-scoped session semantics instead of inventing a second project/session model. <!-- D-012 -->

## 1. Architecture

Trevor's left sidebar becomes a project-first navigation surface. A project is a user-visible folder record keyed by canonical absolute path, stored as local launcher/supervisor state under `TREVOR_STATE_HOME`, not as a session-store row and not in browser storage. <!-- D-001 --> <!-- D-002 -->

Sessions remain durable session-store logs. A project record never stores session ids. The sidebar joins project records with the session inventory by session project path: first the new durable `session.project` marker, then legacy derivation from `workspace`/`cwd`, then migration compatibility for existing launcher records. <!-- D-005 --> <!-- D-006 -->

The current one-root-one-session `projects.json` model is replaced. Existing entries are imported into the new project registry on first read, then new code stops writing `projects.json`. After a successful import, implementation may remove the old file or leave an ignored backup, but all current behavior reads/writes the new registry. <!-- D-005 -->

### Current State

- `packages/launcher/src/project.ts` persists `projects.json` as `root -> { root, sessionId, updatedAt }`, which assumes one stable session per project root.
- `apps/supervisor/src/recents.ts` reads that map as "recent projects" for the New-session picker.
- `apps/web/src/new-session/new-session-picker.tsx` shows an app-level picker with recent projects, typed path, and native folder button.
- `apps/web/src/components/panel/session-sidebar.tsx` filters `SessionSummary[]` to the current project with `sessionsForProject`, so it cannot show all projects.
- `apps/web/src/app.tsx` exposes `/clear`, `/new`, and `/cd` as separate concepts even though the desired product model is that fresh context means a new project-bound session.

### Target Shape

- The sidebar title becomes `Projects`.
- Add Project opens the OS folder picker directly, records a project, expands/focuses it, and does not create or start a session. <!-- D-003 -->
- Project rows expand/collapse only. Selecting/opening requires clicking a session row. <!-- D-009 -->
- Project-scoped New Session mints a fresh session id, writes the session project marker, navigates to it, and starts the host immediately. <!-- D-007 -->
- `/new` becomes the explicit fresh-context command. `/new` with no args uses the current project path or asks for a folder; `/new <path>` creates/touches that project; `/cd <path>` remains a compatibility alias for `/new <path>`. `/clear` is retired from visible command surfaces, while existing `/clear` markers remain replay-compatible. <!-- D-008 -->
- Archived sessions are hidden from the normal project list. Normal session rows offer Archive, not Delete; Delete remains in the archive surface. <!-- D-010 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Projects are local UI/launcher state | Store under `TREVOR_STATE_HOME`; expose through supervisor/launcher; do not add project rows to session-store. |
| Project identity is canonical path | Browser never canonicalizes; supervisor/launcher returns the canonical path and display path. |
| Sessions remain session logs | Project registry stores no session ids; membership is a join over session inventory and session project path. |
| Normal sessions have one immutable project path | `/cd` and `/new <path>` create a fresh session instead of moving the current session. |
| Fresh context is a real new session | Retire `/clear` from the visible UX and make `/new` the path for new work. |
| Live work must stay visible | A project with active sessions is visible even without a saved project record; removal is blocked while work is running or queued. <!-- D-004 --> |
| Sidebar project click is not session selection | Project rows toggle; only session rows navigate. |
| Desktop will need the same model | Plan 48 consumes the registry and launch semantics rather than adding a Tauri-specific project store. |

### Boundaries

- `packages/launcher` owns the project registry module: canonical path keys, schema, import from old `projects.json`, add/touch/rename/remove/collapse operations, and recency updates.
- `apps/supervisor` owns host-side project operations exposed over the control session: add project through native folder pick, list projects, rename project, set collapsed, remove project, and create fresh session for project.
- `packages/session` owns protocol types/events for supervisor project operations and the durable session project marker consumed by inventory.
- `apps/session-store` remains the session inventory owner. It folds the `session.project` marker into `SessionSummary` or a compatible project-path field, while keeping archived/deleted/tangent filtering rules centralized.
- `apps/web` owns the project sidebar read model and presentation: grouping, search, expanded/collapsed state, show more, hover Archive, context menus, and archive-filter entry points.
- The existing New-session picker is removed from the normal local flow. A fallback path-entry surface may remain only for non-local/headless cases where native folder picking is unavailable, and it should be framed as path entry, not recent sessions.

### Observability

Project/session management is user-visible state, so failures must be inspectable:

- Supervisor project results carry `requestId`, operation, status, canonical path, and a bounded error string.
- Registry import logs one structured diagnostic for old `projects.json` import success/failure and the number of imported records.
- Fresh-session launch reports each step: project touch, session id mint, session marker publish, host launch request, host online wait.
- Remove Project blocked by active sessions returns the blocking session ids/count and activity state.
- The sidebar renders explicit disabled/error states for Add Project unavailable, folder-pick cancel, project remove blocked, and launch failure.
- Doctor or debug output should include the project registry path, entry count, and last migration result once the registry exists.

## 2. Project Registry Model

The registry stores project metadata only:

```ts
interface ProjectRecord {
  readonly path: string; // canonical absolute path, registry key
  readonly displayPath: string; // user-friendly absolute or home-shortened path
  readonly displayName: string; // defaults to basename; user-renamable
  readonly collapsed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

No session ids are stored in the registry. Session membership is derived from session inventory and path binding, so archive/delete/session-log changes cannot drift from a duplicated project membership list. <!-- D-005 -->

Remove Project deletes the record. If the same path is later re-added or reopened, it gets fresh default metadata; prior rename/collapse state is not preserved. <!-- D-003 -->

Project ordering is most recent activity first. The effective timestamp is the max of project registry `updatedAt`, launcher/supervisor touches, and active session `updatedAt`. Sessions inside a project are also sorted by most recent activity. <!-- D-011 -->

## 3. Session Binding and Launch Semantics

New sessions publish an immutable session project marker before host startup:

```ts
events.sessionProject({ path, displayPath? })
```

The inventory fold prefers this marker over host-reported workspace/cwd. Existing sessions without the marker are grouped by `workspace ?? cwd`, with compatibility support for legacy imported project records. <!-- D-006 -->

Fresh project-scoped session creation uses a minted id, not `projectSessionId(path)`. The old deterministic root id may remain only as a migration/open-default compatibility detail until the launcher no longer needs it for existing installs. <!-- D-007 -->

`/new` and the project row's New Session action share one supervisor/launcher operation:

1. Resolve and canonicalize the project path.
2. Add/touch the project registry.
3. Mint a fresh valid session id.
4. Ensure the session exists.
5. Publish `session.project`.
6. Launch or reuse the host for that session/path.
7. Navigate once the launch result is safe to show.

`/cd <path>` calls the same operation as `/new <path>`. It does not mutate the current session's project binding. <!-- D-008 -->

## 4. Sidebar UX

The sidebar renders projects, not "sessions for the current cwd":

- Header: Search, Add Project, collapse.
- Project row: folder icon, display name, path, active session count, aggregate running/queued indicator, context menu.
- Project click and chevron: expand/collapse only.
- Project context menu: Rename, New Session, Remove Project.
- Expanded body: active non-deleted, non-archived sessions; empty state with New Session; archive affordance when only archived sessions remain.
- Session row: title, relative last-active time, active/running/queued indicator.
- Session row hover: replace time with Archive button.
- Session row context menu: Rename and Archive.
- No Delete in the normal sidebar. Delete remains in archive management. <!-- D-010 -->
- First seven active sessions are shown by default; Show more reveals all. The current session is always included even if it is older than the first seven. <!-- D-009 -->
- Search filters project display name, project path, and session title while preserving project grouping. Matching projects auto-expand only while search is active; clearing search restores persisted collapsed state. <!-- D-009 -->

## 5. Phases

### Phase 1: Project Registry and Supervisor Contract

**Goal:** A canonical project registry replaces `projects.json`, and the browser can list/manage projects through supervisor requests.

**Gate from previous:** Existing launcher/supervisor tests pass.

#### M1: Project Registry Storage and Migration

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add launcher tests for a canonical-path project registry that stores metadata only, rejects duplicate path aliases, and preserves no session membership.
  2. GREEN: Implement the registry module under `@trevor/launcher`, using `TREVOR_STATE_HOME` and the existing storage-root policy.
  3. RED: Add migration tests for importing legacy `projects.json`, stopping future writes to it, and resetting metadata after Remove Project plus re-add.
  4. GREEN: Implement first-read import and legacy write retirement.
  5. REFACTOR: Remove old `projects.json` as a product source and document the new registry owner.

#### M2: Supervisor Project Operations

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol round-trip tests for project list/add/rename/collapse/remove results with request ids and canonical paths.
  2. GREEN: Add typed supervisor project events and dispatcher handlers over the registry module.
  3. RED: Add folder-pick flow tests proving Add Project records a project only and existing paths reveal/touch the existing project without duplication.
  4. GREEN: Wire Add Project to native folder pick and registry add/touch; remove the app-level recent-project picker from the primary path.
  5. REFACTOR: Consolidate supervisor project result errors so unavailable picker, cancel, and registry failure are distinct user-visible states.

### Gate 1->2

- [ ] The new project registry is the only current project source.
- [ ] Existing `projects.json` entries import without stranding known paths.
- [ ] Browser can list/add/rename/collapse/remove projects through the supervisor contract.

### Phase 2: Immutable Session Project Binding and Fresh Session Launch

**Goal:** New sessions are always project-bound, fresh session creation is explicit, and old reset semantics no longer create sidebar confusion.

**Gate from previous:** Project registry and supervisor project events are available.

#### M3: Session Project Marker and Inventory Join

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol and inventory tests for `session.project` winning over host workspace/cwd and remaining immutable for grouping.
  2. GREEN: Add `session.project` event constructors/decoders and fold it into `SessionSummary` or a project-path companion read model.
  3. RED: Add compatibility tests grouping old sessions by existing workspace/cwd and imported registry records without bulk migration.
  4. GREEN: Implement legacy grouping fallback and mismatch diagnostics when host workspace/cwd diverges from the session project path.
  5. REFACTOR: Centralize project path selection so sidebar, archive filter, CLI, and supervisor do not each rebuild grouping rules.

#### M4: Fresh Project-Scoped Session Launch

- **Dependencies:** M2, M3
- **Effort:** L
- **Tasks:**
  1. RED: Add launcher/supervisor tests proving New Session mints a fresh valid session id for an existing project and never uses `projectSessionId(path)`.
  2. GREEN: Implement the fresh-session operation: touch project, ensure session, publish marker, launch host, return/navigate.
  3. RED: Add command tests for `/new`, `/new <path>`, and `/cd <path>` alias behavior, including projectless `/new` folder-pick fallback.
  4. GREEN: Wire browser-side `/new` and `/cd` to the project-scoped operation.
  5. RED: Add replay/UI tests proving `/clear` is absent from the visible command surface while legacy `/clear` markers still decode and replay safely.
  6. GREEN: Retire `/clear` from autocomplete/command affordances and keep compatibility in projection/inventory.
  7. REFACTOR: Update command copy and remove stale "fresh session" wording that implies in-session reset.

### Gate 2->3

- [ ] Every new normal session has a project path before host startup.
- [ ] `/new` and project New Session create real fresh sessions.
- [ ] `/clear` no longer appears as the normal fresh-context action.

### Phase 3: Project Sidebar UI

**Goal:** The left sidebar matches the project-first model, with all projects visible and sessions grouped under them.

**Gate from previous:** Project registry, project grouping, and fresh session launch are wired.

#### M5: Project Sidebar Read Model and Storybook

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add pure read-model tests grouping active sessions under projects from registry records, active-session-forced transient projects, and legacy workspace/cwd fallback.
  2. GREEN: Build the project-sidebar read model: recency ordering, active counts, aggregate active state, archive-only empty state, and duplicate-name path display.
  3. RED: Add Storybook stories covering empty project, active project, duplicate basenames, running collapsed project, archive-only project, more than seven sessions, and search.
  4. GREEN: Build project/sidebar presentational components with persisted collapsed state input and project/session actions as injected callbacks.
  5. REFACTOR: Replace current-project-only sidebar helpers with project-grouped helpers while preserving tangent exclusion.

#### M6: Live Sidebar Wiring, Search, and Actions

- **Dependencies:** M2, M4, M5
- **Effort:** L
- **Tasks:**
  1. RED: Add web integration tests proving the sidebar lists all projects, project rows only expand/collapse, session rows navigate, and search auto-expands without mutating persisted collapse state.
  2. GREEN: Wire `PanelHost`/`App` to supervisor project inventory, project actions, project-scoped New Session, and grouped session selection.
  3. RED: Add tests for Show more, always-including current session, hover Archive, right-click Rename/Archive, and Remove Project blocked by running/queued sessions.
  4. GREEN: Implement Show more, hover/context actions, project remove confirmation/blocking, and inline rename.
  5. REFACTOR: Remove the current New-session popup from the local primary flow and keep any fallback path-entry code isolated behind unavailable-picker conditions.

### Gate 3->4

- [ ] Sidebar is project-first and not scoped to current cwd.
- [ ] Add Project does not create a session.
- [ ] Project-scoped New Session creates/navigates/starts.
- [ ] Search, Show more, Archive, Rename, and blocked Remove Project behavior are tested.

### Phase 4: Archive Integration and Cleanup

**Goal:** Archive/delete behavior remains coherent with project grouping, and old UI copy/state paths are removed.

**Gate from previous:** Project sidebar is live.

#### M7: Project-Filtered Archive Access

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Add archive row/model tests filtering archived sessions by project path and excluding deleted sessions from normal project counts.
  2. GREEN: Add project-filtered archive entry points from archive-only project empty state and project context where appropriate.
  3. RED: Add delete-from-archive tests proving sidebar Delete is absent and archive Delete retains confirmation/protection.
  4. GREEN: Keep Delete in archive management and remove/delete any normal-sidebar delete affordance.
  5. REFACTOR: Share project label/path rendering between sidebar and archive rows.

#### M8: Regression Polish and Documentation

- **Dependencies:** M6, M7
- **Effort:** M
- **Tasks:**
  1. RED: Add regression tests for the original complaints: inert folder button, misleading recent-project popup, `/clear` sidebar confusion, and current-project-only session list.
  2. GREEN: Fix any remaining wiring/copy paths and ensure disabled/unavailable states are visible.
  3. RED: Add CLI/launcher tests proving `trevor` opens/touches the new registry and no current code writes `projects.json`.
  4. GREEN: Wire CLI opens and future desktop-facing launcher paths to touch the new registry.
  5. REFACTOR: Update `CONTEXT.md`, Storybook names, command summaries, and developer comments to the project-first vocabulary.

### Gate 4->done

- [ ] `projects.json` is migrated/retired as a product source.
- [ ] Normal sessions are project-bound and immutable.
- [ ] `/new` and `/cd` create project-scoped fresh sessions.
- [ ] `/clear` is not a visible fresh-context command.
- [ ] Sidebar shows all projects, grouped sessions, search, Show more, active states, Archive, Rename, and Remove Project blocking.
- [ ] Archive view remains the place for Delete.
- [ ] Lint, typecheck, web tests, launcher/supervisor/session tests, and relevant Storybook checks pass.

## 6. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Registry and session inventory drift | high | medium | Store no session ids in project registry; derive membership from session log/inventory each render. | launcher/session |
| Legacy project sessions become hard to find | high | low | Import old `projects.json`; derive old sessions by workspace/cwd; test compatibility. | launcher/web |
| Fresh session launch races host.online | medium | medium | Publish `session.project` before launch and return structured supervisor statuses. | supervisor |
| Sidebar becomes too dense | medium | medium | Storybook-first layouts for duplicate paths, long names, search, running state, and >7 sessions. | web |
| Desktop builds a second model later | medium | low | Thread this plan into plan 48 and make launcher registry the shared source. | planner |

## 7. Escape Hatches

1. **If immediate `projects.json` deletion proves risky:** keep a read-only import fallback for one release but continue to write only the new registry.
2. **If non-local/headless folder picking is unavailable:** keep a fallback paste-path dialog that records a project after supervisor validation; do not restore the normal recent-project picker.
3. **If `session.project` inventory changes are too large for one pass:** add a companion grouping read model first, then fold the field into `SessionSummary` after the sidebar is stable.
4. **If project Remove blocking is too strict:** allow removal only for settled/idle sessions and surface running/queued sessions with direct links; never mutate live sessions during remove.

## 8. Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm --filter @trevor/launcher test
pnpm --filter @trevor/session test
pnpm --filter @trevor/supervisor test
pnpm --filter @trevor/web test -- --project web
pnpm --filter @trevor/web build-storybook
```

## 9. Decisions

Canonical decisions are in `.plans/58-project-sidebar-sessions/plan.db`.

- D-001: Project registry ownership.
- D-002: Project identity.
- D-003: Project lifecycle.
- D-004: Project visibility and removal.
- D-005: Old projects map migration.
- D-006: Session project binding.
- D-007: Fresh session creation.
- D-008: Slash command semantics.
- D-009: Sidebar hierarchy and interaction.
- D-010: Session actions and archive.
- D-011: Project and session ordering.
- D-012: Archive-only project state.

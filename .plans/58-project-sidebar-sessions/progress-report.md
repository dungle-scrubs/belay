# Project Sidebar Sessions - Progress Report

**Plan:** `58-project-sidebar-sessions`
**Stage:** ready (authored; not yet implemented)
**Current focus:** M1 - Project Registry Storage and Migration (0/5)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 49 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 49 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All eight milestones and the final gate checks are current-cutoff. No follow-up scope is accepted yet;
the fallback path-entry UI is an escape hatch in `implementation.md`, not scheduled work.

---

## M1 - Project Registry Storage and Migration (0/5)

- [ ] RED: Add launcher tests for a canonical-path project registry that stores metadata only, rejects duplicate path aliases, and preserves no session membership.
- [ ] GREEN: Implement the registry module under `@trevor/launcher`, using `TREVOR_STATE_HOME` and the existing storage-root policy.
- [ ] RED: Add migration tests for importing legacy `projects.json`, stopping future writes to it, and resetting metadata after Remove Project plus re-add.
- [ ] GREEN: Implement first-read import and legacy write retirement.
- [ ] REFACTOR: Remove old `projects.json` as a product source and document the new registry owner.

## M2 - Supervisor Project Operations (0/5)

- [ ] RED: Add protocol round-trip tests for project list/add/rename/collapse/remove results with request ids and canonical paths.
- [ ] GREEN: Add typed supervisor project events and dispatcher handlers over the registry module.
- [ ] RED: Add folder-pick flow tests proving Add Project records a project only and existing paths reveal/touch the existing project without duplication.
- [ ] GREEN: Wire Add Project to native folder pick and registry add/touch; remove the app-level recent-project picker from the primary path.
- [ ] REFACTOR: Consolidate supervisor project result errors so unavailable picker, cancel, and registry failure are distinct user-visible states.

## M3 - Session Project Marker and Inventory Join (0/5)

- [ ] RED: Add protocol and inventory tests for `session.project` winning over host workspace/cwd and remaining immutable for grouping.
- [ ] GREEN: Add `session.project` event constructors/decoders and fold it into `SessionSummary` or a project-path companion read model.
- [ ] RED: Add compatibility tests grouping old sessions by existing workspace/cwd and imported registry records without bulk migration.
- [ ] GREEN: Implement legacy grouping fallback and mismatch diagnostics when host workspace/cwd diverges from the session project path.
- [ ] REFACTOR: Centralize project path selection so sidebar, archive filter, CLI, and supervisor do not each rebuild grouping rules.

## M4 - Fresh Project-Scoped Session Launch (0/7)

- [ ] RED: Add launcher/supervisor tests proving New Session mints a fresh valid session id for an existing project and never uses `projectSessionId(path)`.
- [ ] GREEN: Implement the fresh-session operation: touch project, ensure session, publish marker, launch host, return/navigate.
- [ ] RED: Add command tests for `/new`, `/new <path>`, and `/cd <path>` alias behavior, including projectless `/new` folder-pick fallback.
- [ ] GREEN: Wire browser-side `/new` and `/cd` to the project-scoped operation.
- [ ] RED: Add replay/UI tests proving `/clear` is absent from the visible command surface while legacy `/clear` markers still decode and replay safely.
- [ ] GREEN: Retire `/clear` from autocomplete/command affordances and keep compatibility in projection/inventory.
- [ ] REFACTOR: Update command copy and remove stale "fresh session" wording that implies in-session reset.

## M5 - Project Sidebar Read Model and Storybook (0/5)

- [ ] RED: Add pure read-model tests grouping active sessions under projects from registry records, active-session-forced transient projects, and legacy workspace/cwd fallback.
- [ ] GREEN: Build the project-sidebar read model: recency ordering, active counts, aggregate active state, archive-only empty state, and duplicate-name path display.
- [ ] RED: Add Storybook stories covering empty project, active project, duplicate basenames, running collapsed project, archive-only project, more than seven sessions, and search.
- [ ] GREEN: Build project/sidebar presentational components with persisted collapsed state input and project/session actions as injected callbacks.
- [ ] REFACTOR: Replace current-project-only sidebar helpers with project-grouped helpers while preserving tangent exclusion.

## M6 - Live Sidebar Wiring, Search, and Actions (0/5)

- [ ] RED: Add web integration tests proving the sidebar lists all projects, project rows only expand/collapse, session rows navigate, and search auto-expands without mutating persisted collapse state.
- [ ] GREEN: Wire `PanelHost`/`App` to supervisor project inventory, project actions, project-scoped New Session, and grouped session selection.
- [ ] RED: Add tests for Show more, always-including current session, hover Archive, right-click Rename/Archive, and Remove Project blocked by running/queued sessions.
- [ ] GREEN: Implement Show more, hover/context actions, project remove confirmation/blocking, and inline rename.
- [ ] REFACTOR: Remove the current New-session popup from the local primary flow and keep any fallback path-entry code isolated behind unavailable-picker conditions.

## M7 - Project-Filtered Archive Access (0/5)

- [ ] RED: Add archive row/model tests filtering archived sessions by project path and excluding deleted sessions from normal project counts.
- [ ] GREEN: Add project-filtered archive entry points from archive-only project empty state and project context where appropriate.
- [ ] RED: Add delete-from-archive tests proving sidebar Delete is absent and archive Delete retains confirmation/protection.
- [ ] GREEN: Keep Delete in archive management and remove/delete any normal-sidebar delete affordance.
- [ ] REFACTOR: Share project label/path rendering between sidebar and archive rows.

## M8 - Regression Polish and Documentation (0/5)

- [ ] RED: Add regression tests for the original complaints: inert folder button, misleading recent-project popup, `/clear` sidebar confusion, and current-project-only session list.
- [ ] GREEN: Fix any remaining wiring/copy paths and ensure disabled/unavailable states are visible.
- [ ] RED: Add CLI/launcher tests proving `trevor` opens/touches the new registry and no current code writes `projects.json`.
- [ ] GREEN: Wire CLI opens and future desktop-facing launcher paths to touch the new registry.
- [ ] REFACTOR: Update `CONTEXT.md`, Storybook names, command summaries, and developer comments to the project-first vocabulary.

---

## Gate 1->done

- [ ] `projects.json` is migrated/retired as a product source.
- [ ] Normal sessions are project-bound and immutable.
- [ ] `/new` and `/cd` create project-scoped fresh sessions.
- [ ] `/clear` is not a visible fresh-context command.
- [ ] Sidebar shows all projects, grouped sessions, search, Show more, active states, Archive, Rename, and Remove Project blocking.
- [ ] Archive view remains the place for Delete.
- [ ] Lint, typecheck, web tests, launcher/supervisor/session tests, and relevant Storybook checks pass.

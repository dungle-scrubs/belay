# Project Sidebar Sessions - Progress Report

**Plan:** `58-project-sidebar-sessions`
**Stage:** implementing (all milestones implemented; awaiting manual test before merge)
**Current focus:** Manual test gate - do NOT merge until the owner tests on this machine.

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 49 |
| Checked (done) | 49 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All eight milestones and the final gate checks are implemented. The plan's Section 9
(Post-Implementation: Local Test Gate) instructs the implement-plan lifecycle to stop
here and wait for the owner to manually test before merging into `main`.

---

## M1 - Project Registry Storage and Migration (5/5)

- [x] RED: Add launcher tests for a canonical-path project registry that stores metadata only, rejects duplicate path aliases, and preserves no session membership.
- [x] GREEN: Implement the registry module under `@trevor/launcher`, using `TREVOR_STATE_HOME` and the existing storage-root policy.
- [x] RED: Add migration tests for importing legacy `projects.json`, stopping future writes to it, and resetting metadata after Remove Project plus re-add.
- [x] GREEN: Implement first-read import and legacy write retirement.
- [x] REFACTOR: Remove old `projects.json` as a product source and document the new registry owner.

## M2 - Supervisor Project Operations (5/5)

- [x] RED: Add protocol round-trip tests for project list/add/rename/collapse/remove results with request ids and canonical paths.
- [x] GREEN: Add typed supervisor project events and dispatcher handlers over the registry module.
- [x] RED: Add folder-pick flow tests proving Add Project records a project only and existing paths reveal/touch the existing project without duplication.
- [x] GREEN: Wire Add Project to native folder pick and registry add/touch; remove the app-level recent-project picker from the primary path.
- [x] REFACTOR: Consolidate supervisor project result errors so unavailable picker, cancel, and registry failure are distinct user-visible states.

## M3 - Session Project Marker and Inventory Join (5/5)

- [x] RED: Add protocol and inventory tests for `session.project` winning over host workspace/cwd and remaining immutable for grouping.
- [x] GREEN: Add `session.project` event constructors/decoders and fold it into `SessionSummary` or a project-path companion read model.
- [x] RED: Add compatibility tests grouping old sessions by existing workspace/cwd and imported registry records without bulk migration.
- [x] GREEN: Implement legacy grouping fallback and mismatch diagnostics when host workspace/cwd diverges from the session project path.
- [x] REFACTOR: Centralize project path selection so sidebar, archive filter, CLI, and supervisor do not each rebuild grouping rules.

## M4 - Fresh Project-Scoped Session Launch (7/7)

- [x] RED: Add launcher/supervisor tests proving New Session mints a fresh valid session id for an existing project and never uses `projectSessionId(path)`.
- [x] GREEN: Implement the fresh-session operation: touch project, ensure session, publish marker, launch host, return/navigate.
- [x] RED: Add command tests for `/new`, `/new <path>`, and `/cd <path>` alias behavior, including projectless `/new` folder-pick fallback.
- [x] GREEN: Wire browser-side `/new` and `/cd` to the project-scoped operation.
- [x] RED: Add replay/UI tests proving `/clear` is absent from the visible command surface while legacy `/clear` markers still decode and replay safely.
- [x] GREEN: Retire `/clear` from autocomplete/command affordances and keep compatibility in projection/inventory.
- [x] REFACTOR: Update command copy and remove stale "fresh session" wording that implies in-session reset.

## M5 - Project Sidebar Read Model and Storybook (5/5)

- [x] RED: Add pure read-model tests grouping active sessions under projects from registry records, active-session-forced transient projects, and legacy workspace/cwd fallback.
- [x] GREEN: Build the project-sidebar read model: recency ordering, active counts, aggregate active state, archive-only empty state, and duplicate-name path display.
- [x] RED: Add Storybook stories covering empty project, active project, duplicate basenames, running collapsed project, archive-only project, more than seven sessions, and search.
- [x] GREEN: Build project/sidebar presentational components with persisted collapsed state input and project/session actions as injected callbacks.
- [x] REFACTOR: Replace current-project-only sidebar helpers with project-grouped helpers while preserving tangent exclusion.

## M6 - Live Sidebar Wiring, Search, and Actions (5/5)

- [x] RED: Add web integration tests proving the sidebar lists all projects, project rows only expand/collapse, session rows navigate, and search auto-expands without mutating persisted collapse state.
- [x] GREEN: Wire `PanelHost`/`App` to supervisor project inventory, project actions, project-scoped New Session, and grouped session selection.
- [x] RED: Add tests for Show more, always-including current session, hover Archive, right-click Rename/Archive, and Remove Project blocked by running/queued sessions.
- [x] GREEN: Implement Show more, hover/context actions, project remove confirmation/blocking, and inline rename.
- [x] REFACTOR: Remove the current New-session popup from the local primary flow and keep any fallback path-entry code isolated behind unavailable-picker conditions.

## M7 - Project-Filtered Archive Access (5/5)

- [x] RED: Add archive row/model tests filtering archived sessions by project path and excluding deleted sessions from normal project counts.
- [x] GREEN: Add project-filtered archive entry points from archive-only project empty state and project context where appropriate.
- [x] RED: Add delete-from-archive tests proving sidebar Delete is absent and archive Delete retains confirmation/protection.
- [x] GREEN: Keep Delete in archive management and remove/delete any normal-sidebar delete affordance.
- [x] REFACTOR: Share project label/path rendering between sidebar and archive rows.

## M8 - Regression Polish and Documentation (5/5)

- [x] RED: Add regression tests for the original complaints: inert folder button, misleading recent-project popup, `/clear` sidebar confusion, and current-project-only session list.
- [x] GREEN: Fix any remaining wiring/copy paths and ensure disabled/unavailable states are visible.
- [x] RED: Add CLI/launcher tests proving `trevor` opens/touches the new registry and no current code writes `projects.json`.
- [x] GREEN: Wire CLI opens and future desktop-facing launcher paths to touch the new registry.
- [x] REFACTOR: Update `CONTEXT.md`, Storybook names, command summaries, and developer comments to the project-first vocabulary.

---

## Gate 1->done

- [x] `projects.json` is migrated/retired as a product source.
- [x] Normal sessions are project-bound and immutable.
- [x] `/new` and `/cd` create project-scoped fresh sessions.
- [x] `/clear` is not a visible fresh-context command.
- [x] Sidebar shows all projects, grouped sessions, search, Show more, active states, Archive, Rename, and Remove Project blocking.
- [x] Archive view remains the place for Delete.
- [x] Lint, typecheck, web tests, launcher/supervisor/session tests, and relevant Storybook checks pass.

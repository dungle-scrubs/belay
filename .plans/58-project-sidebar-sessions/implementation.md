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

A session's project path is resolved from the new durable `session.project` marker first, then legacy `workspace`/`cwd` fields, then migration compatibility. The marker is immutable once written. <!-- D-006 -->

Fresh session creation (project-scoped New Session, `/new`, `/cd`):
1. Mint a fresh session id (never reuse `projectSessionId(path)`).
2. Touch the project in the registry (add if missing, bump `updatedAt`).
3. Publish the `session.project` marker for the new session.
4. Launch the host for the new session.
5. Navigate the browser to the new session. <!-- D-007 -->

`/new` with no args uses the current project path or opens the folder picker. `/new <path>` creates/touches the project at that path. `/cd <path>` is a compatibility alias for `/new <path>`. `/clear` is retired from visible command surfaces; existing `/clear` markers in the durable log remain replay-compatible. <!-- D-008 -->

## 4. Sidebar Read Model

The sidebar read model groups sessions under projects:

- **Project rows**: expand/collapse only. Never navigate. Show display name, session count, aggregate active state.
- **Session rows**: navigate on click. Show title, activity, running indicator, archived state.
- **Search**: filters projects and sessions by name/path/text. Auto-expands matching projects without mutating persisted collapse state.
- **Show more**: each project shows up to N sessions by default; a "Show more" reveals the rest.
- **Current session**: always included in its project's list even if it would otherwise be hidden.
- **Archive-only projects**: a project with only archived sessions shows an empty state with a link to the archive view.
- **Transient projects**: a project with active sessions but no saved registry record is shown as a transient project; it is visible while work is active and disappears when idle.
- **Duplicate basenames**: when two projects share a basename, the display path (not just the basename) is shown to disambiguate.

## 5. Sidebar Actions

- **Add Project**: opens OS folder picker, records the project, expands it. No session created.
- **New Session** (per-project): mints a fresh session for that project, navigates, starts host.
- **Rename Project**: inline rename of `displayName`.
- **Archive Session**: archives a session from the normal list. No Delete in the normal sidebar.
- **Remove Project**: deletes the registry record. Blocked when the project has running/queued sessions (returns blocking ids). <!-- D-004 -->
- **Collapse/Expand**: persisted in the registry record's `collapsed` field.

## 6. Archive Access

- Archived sessions are hidden from the normal project list.
- The archive view remains the surface for Delete (with confirmation/protection).
- A project with only archived sessions shows an empty state with a link to the archive filtered by that project's path.
- Project label/path rendering is shared between sidebar and archive rows. <!-- D-010 -->

## 7. Edge Cases and Risk Mitigation

1. **If the folder picker is unavailable (headless/non-local):** fall back to a path-entry surface framed as "Enter a project path", not "recent sessions". The fallback is isolated behind the unavailable-picker condition.
2. **If legacy `projects.json` has stale entries:** import only well-formed entries with a valid root path; log a diagnostic for skipped entries. The old file is left as an ignored backup or removed after successful import.
3. **If a session's project path diverges from its host workspace/cwd:** the `session.project` marker wins. A mismatch diagnostic is logged for observability but does not block grouping.
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

## 9. Post-Implementation: Local Test Gate (no merge)

After the full verification gate passes, **do NOT merge the branch into `main`**. The owner wants to
test the implementation on this machine first. Leave the worktree and branch in place, report that the
plan is ready for manual testing, and wait for the owner to confirm before merging. The plan directory
is not deleted until the merge happens.

## 10. Decisions

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

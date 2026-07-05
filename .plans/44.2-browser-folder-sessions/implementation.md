# Browser Folder Sessions - Implementation Plan

## 0. Hard Dependencies

- [ ] `44.1-supervisor-foundation` - the supervisor, the `session.launch` / `folder.pick` / `projects.list` request/result events, the reserved control session, and `@trevor/launcher`. This plan is the browser UX over that contract and cannot land before it.
- [x] D-093 session navigation sidebar (`apps/web/src/components/panel/session-sidebar.tsx`) - the surface that gains the `＋ New session` entry point.
- [x] D-090 explicit resume / command menu (`apps/web/src/commands`, command-modal) - the surface that gains the `/new` command.
- [x] D-085 project launcher identity - a browser-created session uses the same project-root -> session-id mapping as the CLI, now via `@trevor/launcher` (44.1).
- [x] `09.2-browser-test-suite` - Storybook-first stories + the Storybook test-runner lane are the primary UI verification for this plan's presentational surfaces.

## 1. Architecture

This plan adds the browser affordance to start a folder-bound session and drives it entirely over the 44.1
supervisor contract. Nothing here spawns a host or reads the filesystem directly - the browser publishes typed
requests to the control session and reacts to typed results, exactly as it does with a host.

Flow: the user opens the **New-session picker** (from the sidebar `＋` or the `/new` command). Opening the
picker publishes `projects.list.requested` and renders the returned recents. The user either (a) clicks a
recent, (b) types/pastes a path (host-validated), or (c) clicks the folder icon, which publishes
`folder.pick.requested` so the supervisor pops the native OS folder dialog and fills the field with the chosen
path. `Create` is enabled only for a valid selection; it publishes `session.launch.requested { root }`. The
picker then shows a **"starting host…"** state until the launch result arrives and the new session's host
announces `host.online`, at which point the app navigates to the new session.

The folder icon is **shown only when a local supervisor is available** (derived from the same local/host
presence signal), degrading to recents + paste-a-path when it is not.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Richter-only | The picker uses only the 44.1 request/result events; it never reads `projects.json` or the filesystem directly and never opens a private channel. |
| Storybook-first | The `＋`, the `/new` command, and the picker modal are built as presentational components over injected props, story-covered before the live wiring (09.2 lane). |
| Fixed layout, no reflow | The picker's states (recents / validating / starting host…) swap in place; row heights and control slots are fixed so a launch in flight never resizes the modal. |
| No per-component `cursor-pointer` | Interactive elements inherit the pointer cursor from the `index.css` base layer (repo rule); the picker adds none. |
| Happy path only | Failure/retry/no-host/stale states are 44.3; this plan renders only the success trajectory (with a plain disabled/validating state for an invalid path). |

### Boundaries

- **`apps/web/src/components/panel/session-sidebar.tsx`** gains the pinned `＋ New session` header affordance
  (presentational; opens the picker via an injected callback).
- **`apps/web/src/commands`** gains the `/new` command that opens the same picker.
- **A new picker component** under `apps/web/src/components/...` owns the presentational modal: recents list,
  path field + validation state, native folder icon (conditional), and the `Create`/`starting host…` states,
  all over injected props + callbacks.
- **`apps/web/src/app.tsx`** owns the live wiring: publish `projects.list` / `folder.pick` / `session.launch`
  requests on the control session, await `host.online` for the returned session id, and `navigateToSession`.

### Observability

- The picker surfaces the launch trajectory to the user (recents loaded / validating / starting host…), which
  is itself the user-visible inspection surface for a browser-initiated launch. Failure surfaces are 44.3.

## 2. Current State

The sidebar and resume chooser show only the current project's *existing* sessions; there is no browser entry
point to create a session, and navigating to a never-launched session yields `host: "no host"` with no way to
start one. `projects.json` recents are not reachable from the browser. All of that plumbing arrives in 44.1;
this plan is the UI that uses it.

## 3. Phases

### Phase 1: Entry point and picker shell

**Goal:** A discoverable way to open the New-session picker exists and is story-covered.

#### M1: New-session entry point

- **Dependencies:** none (presentational)
- **Effort:** S
- **Tasks:**
  1. RED: Add a Storybook story + test that the sidebar header renders a `＋ New session` affordance and that
     activating it calls `onNewSession`.
  2. GREEN: Add the pinned `＋` affordance to the sidebar header over an injected `onNewSession` callback.
  3. RED: Add a story/test that the `/new` command appears in the command menu and opens the picker.
  4. GREEN: Register the `/new` command wired to open the picker.
  5. REFACTOR: Share one "open new-session picker" entry between the `＋` and `/new` so they can't drift.

#### M2: Picker modal (presentational)

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add stories for the picker's states - recents list, empty recents, path field empty/invalid/valid,
     folder icon shown vs. hidden (local vs. non-local), `Create` disabled until valid.
  2. GREEN: Implement the presentational picker over injected `recents`, `validation`, `localPickerAvailable`,
     and `onPickFolder` / `onCreate` callbacks.
  3. RED: Add a story/test for the in-flight "starting host…" state (controls locked, no layout shift).
  4. GREEN: Implement the "starting host…" state as an in-place swap.
  5. REFACTOR: Fix row heights / control slots so state changes never reflow; confirm no per-component cursor rule.

### Gate 1->2

- [ ] `＋` and `/new` both open the picker in Storybook.
- [ ] Picker renders all states (recents/validation/folder-icon/starting) without reflow.
- [ ] No per-component `cursor-pointer` added.

### Phase 2: Live wiring

**Goal:** The picker is backed by the real supervisor contract end to end.

#### M3: Wire recents, path validation, and native folder

- **Dependencies:** M2, 44.1
- **Effort:** M
- **Tasks:**
  1. RED: Add a test that opening the picker publishes `projects.list.requested` and renders the returned
     recents.
  2. GREEN: Wire `projects.list` on open.
  3. RED: Add a test that the folder icon publishes `folder.pick.requested` and fills the path field from
     `folder.pick.result` (and does nothing on cancel).
  4. GREEN: Wire `folder.pick`; show the folder icon only when the local picker is available.
  5. RED: Add a test that the path field reflects host validation (valid enables `Create`; invalid/empty
     disables it).
  6. GREEN: Wire path validation for a typed/pasted path.
  7. REFACTOR: Consolidate the picker's request/result handling on the control session into one place.

#### M4: Create -> launch -> navigate

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add a test that `Create` publishes `session.launch.requested { root }` and enters "starting host…".
  2. GREEN: Wire `Create` to publish the launch request.
  3. RED: Add a test that on `session.launch.result` + `host.online` for the returned session id, the app
     navigates to the new session; a reused host navigates immediately.
  4. GREEN: Implement await-`host.online`-then-navigate (reusing the existing presence + `navigateToSession`).
  5. REFACTOR: Unify the picker launch state (idle -> starting -> online) so 44.3 can extend it with
     failed/retry without a second state model.

### Gate 2

- [ ] Opening the picker loads real recents; the folder icon pops the native dialog and fills the path (local).
- [ ] `Create` launches a host for the chosen folder and navigates on `host.online`.
- [ ] A reused host navigates without a spurious "starting host…" stall.
- [ ] All browser<->supervisor traffic is on the session log.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Picker reflows during launch | medium | medium | Fixed heights/slots + in-place state swap (M2.5); story asserts no shift. | Web |
| Folder icon offered when it can't work | medium | medium | Gate the icon on the local-picker signal; fall back to paste-a-path. | Web |
| Duplicate session on double-`Create` | medium | low | Lock `Create` on first click; supervisor reuse is idempotent per root. | Web/Supervisor |
| Launch state model duplicated in 44.3 | medium | medium | M4.5 unifies the state machine so 44.3 extends, not forks, it. | Web |

## 5. Escape Hatches

1. **If the native picker isn't ready in 44.1:** ship recents + paste-a-path (folder icon hidden); add the
   icon when 44.1's `folder.pick` lands.
2. **If awaiting `host.online` is flaky:** navigate on `session.launch.result` and let the session view show
   its own host-starting state (which 44.3 formalizes).

## 6. Progress Report Accounting

The progress report is `.plans/44.2-browser-folder-sessions/progress-report.md`. It tracks only the browser
entry point, the presentational picker, and the live wiring over 44.1's contract. Recovery states are 44.3.

## 7. Validation Commands

```bash
pnpm --filter @trevor/web test
pnpm --filter @trevor/web build
pnpm test -- --project web
pnpm test -- --project e2e
pnpm typecheck
pnpm lint
# Storybook visual-regression lane (09.2)
pnpm --filter @trevor/web test-storybook
```

## 8. Decisions

Canonical decisions are in `.plans/44.2-browser-folder-sessions/plan.db`.

<!-- D-001 --> Entry point is a pinned `＋ New session` in the sidebar header plus a `/new` command, sharing one open-picker path.

<!-- D-002 --> Folder selection is recents (`projects.list`) + a host-validated path field + a native folder icon (`folder.pick`, shown only when a local picker is available).

<!-- D-003 --> The picker is built Storybook-first (presentational over injected props) and swaps its states in place with no reflow.

<!-- D-004 --> Create publishes `session.launch.requested`, shows "starting host…", and navigates on the new session's `host.online`; a reused host navigates immediately. The launch state machine is unified so 44.3 extends it.

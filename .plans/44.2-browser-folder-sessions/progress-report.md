# Browser Folder Sessions - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 34
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Implemented M1-M4 on `feat/44.2-browser-folder-sessions`. Entry points (`＋`/`/new`),
  presentational picker, and the live supervisor wiring (recents / folder pick / path validation /
  launch -> await host.online -> navigate) are done and green (jsdom `web` + `unit`). Storybook visual
  baselines for the 8 new stories were regenerated in the pinned container and committed.

## Completed Current State / Hard Dependencies

- [x] D-093 session navigation sidebar exists (gains the `＋ New session` entry point).
- [x] D-090 explicit resume / command menu exists (gains the `/new` command).
- [x] D-085 project launcher identity is reused via `@trevor/launcher`.
- [x] `09.2-browser-test-suite` Storybook lane is the primary UI verification.

## Current Cutoff Blockers

### Phase 0 - Dependency gate

- [x] `44.1-supervisor-foundation` merged - supervisor, `session.launch`/`folder.pick`/`projects.list` events, control session, `@trevor/launcher`.

### Phase 1 - M1: New-session entry point

- [x] RED: Story/test that the sidebar header renders `＋ New session` and activating it calls `onNewSession`.
- [x] GREEN: Add the pinned `＋` affordance over an injected `onNewSession`.
- [x] RED: Story/test that `/new` appears in the command menu and opens the picker.
- [x] GREEN: Register the `/new` command wired to open the picker.
- [x] REFACTOR: Share one open-picker entry between `＋` and `/new`.

### Gate 1->2

- [x] `＋` and `/new` both open the picker (shared `openNewSession` entry, jsdom-proven; surfaces are Storybook-covered).
- [x] Picker renders all states without reflow.
- [x] No per-component `cursor-pointer` added.

### Phase 1 - M2: Picker modal (presentational)

- [x] RED: Stories for recents / empty recents / path empty-invalid-valid / folder icon shown-vs-hidden / `Create` gating.
- [x] GREEN: Implement the presentational picker over injected `recents`/`validation`/`localPickerAvailable`/`onPickFolder`/`onCreate`.
- [x] RED: Story/test for the in-flight "starting host…" state (controls locked, no shift).
- [x] GREEN: Implement "starting host…" as an in-place swap.
- [x] REFACTOR: Fix row heights/control slots against reflow; confirm no per-component cursor rule.

### Phase 2 - M3: Wire recents, path validation, native folder

- [x] RED: Test that opening the picker publishes `projects.list.requested` and renders the recents.
- [x] GREEN: Wire `projects.list` on open.
- [x] RED: Test the folder icon publishes `folder.pick.requested` and fills the field (no-op on cancel).
- [x] GREEN: Wire `folder.pick`; show the icon only when the local picker is available.
- [x] RED: Test the path field reflects host validation (valid enables `Create`, invalid disables).
- [x] GREEN: Wire path validation (client-side absolute-path check for this cut; a host-side existence check is a later refinement).
- [x] REFACTOR: Consolidate the picker's control-session request/result handling in `use-supervisor.ts`.

### Phase 2 - M4: Create -> launch -> navigate

- [x] RED: Test `Create` publishes `session.launch.requested { root }` and enters "starting host…".
- [x] GREEN: Wire `Create` to publish the launch request.
- [x] RED: Test that on `session.launch.result` + `host.online`, the app navigates to the new session; a reused host navigates immediately.
- [x] GREEN: Implement await-`host.online`-then-navigate over the existing presence path.
- [x] REFACTOR: Unify the launch state (idle -> starting -> online) in `use-supervisor.ts` so 44.3 extends it.

### Gate 2

- [x] Opening the picker loads real recents; the folder icon pops the native dialog and fills the path (local).
- [x] `Create` launches a host for the chosen folder and navigates on `host.online`.
- [x] A reused host navigates without a spurious "starting host…" stall.
- [x] All browser<->supervisor traffic is on the session log.

## Accepted / Deferred Follow-Up

None. Storybook visual baselines for the 8 new stories (`Panel/SessionSidebar` `WithNewSession`,
`NewSession/NewSessionPicker` x7) were regenerated in the pinned Playwright container and committed;
the 5 unrelated `chat-modelswitchmarker` baselines the full regen touched were reverted (`git checkout`).

## Superseded / Obsolete Checklist Debt

None.

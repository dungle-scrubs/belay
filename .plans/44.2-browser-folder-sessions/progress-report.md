# Browser Folder Sessions - Progress Report

## Summary

- **Current cutoff blockers:** 30
- **Completed current work:** 4
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Phase 0 - Dependency gate (`44.1-supervisor-foundation` must land first).

## Completed Current State / Hard Dependencies

- [x] D-093 session navigation sidebar exists (gains the `＋ New session` entry point).
- [x] D-090 explicit resume / command menu exists (gains the `/new` command).
- [x] D-085 project launcher identity is reused via `@trevor/launcher`.
- [x] `09.2-browser-test-suite` Storybook lane is the primary UI verification.

## Current Cutoff Blockers

### Phase 0 - Dependency gate

- [ ] `44.1-supervisor-foundation` merged - supervisor, `session.launch`/`folder.pick`/`projects.list` events, control session, `@trevor/launcher`.

### Phase 1 - M1: New-session entry point

- [x] RED: Story/test that the sidebar header renders `＋ New session` and activating it calls `onNewSession`.
- [x] GREEN: Add the pinned `＋` affordance over an injected `onNewSession`.
- [x] RED: Story/test that `/new` appears in the command menu and opens the picker.
- [x] GREEN: Register the `/new` command wired to open the picker.
- [x] REFACTOR: Share one open-picker entry between `＋` and `/new`.

### Gate 1->2

- [ ] `＋` and `/new` both open the picker in Storybook.
- [ ] Picker renders all states without reflow.
- [ ] No per-component `cursor-pointer` added.

### Phase 1 - M2: Picker modal (presentational)

- [ ] RED: Stories for recents / empty recents / path empty-invalid-valid / folder icon shown-vs-hidden / `Create` gating.
- [ ] GREEN: Implement the presentational picker over injected `recents`/`validation`/`localPickerAvailable`/`onPickFolder`/`onCreate`.
- [ ] RED: Story/test for the in-flight "starting host…" state (controls locked, no shift).
- [ ] GREEN: Implement "starting host…" as an in-place swap.
- [ ] REFACTOR: Fix row heights/control slots against reflow; confirm no per-component cursor rule.

### Phase 2 - M3: Wire recents, path validation, native folder

- [ ] RED: Test that opening the picker publishes `projects.list.requested` and renders the recents.
- [ ] GREEN: Wire `projects.list` on open.
- [ ] RED: Test the folder icon publishes `folder.pick.requested` and fills the field (no-op on cancel).
- [ ] GREEN: Wire `folder.pick`; show the icon only when the local picker is available.
- [ ] RED: Test the path field reflects host validation (valid enables `Create`, invalid disables).
- [ ] GREEN: Wire path validation.
- [ ] REFACTOR: Consolidate the picker's control-session request/result handling.

### Phase 2 - M4: Create -> launch -> navigate

- [ ] RED: Test `Create` publishes `session.launch.requested { root }` and enters "starting host…".
- [ ] GREEN: Wire `Create` to publish the launch request.
- [ ] RED: Test that on `session.launch.result` + `host.online`, the app navigates to the new session; a reused host navigates immediately.
- [ ] GREEN: Implement await-`host.online`-then-navigate over the existing presence path.
- [ ] REFACTOR: Unify the launch state (idle -> starting -> online) so 44.3 extends it.

### Gate 2

- [ ] Opening the picker loads real recents; the folder icon pops the native dialog and fills the path (local).
- [ ] `Create` launches a host for the chosen folder and navigates on `host.online`.
- [ ] A reused host navigates without a spurious "starting host…" stall.
- [ ] All browser<->supervisor traffic is on the session log.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

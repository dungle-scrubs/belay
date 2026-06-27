# Task Panel Freshness - Progress Report

## Summary

- Current focus: M1 - Prompt Registry Awareness
- Current cutoff blockers: 55
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 0

## Current Cutoff Blockers

### Phase 1: Current-State Characterization

#### M1: Prompt Registry Awareness

- [ ] RED: Add a host test that creates or updates a task before prompt build and expects the rendered system prompt to include the current task snapshot.
- [ ] GREEN: Use the existing registry and prompt builder behavior to pass the test without changing semantics.
- [ ] RED: Add a test that UI truncation helpers do not affect `TaskRegistry.renderForPrompt()`.
- [ ] GREEN: Keep prompt rendering based on the complete registry, not the visible UI list.
- [ ] REFACTOR: Isolate any task prompt fixture setup so freshness tests can reuse it.

#### M2: Existing UI Snapshot Behavior

- [ ] RED: Add a `TasksPanel` test documenting the current unbounded render as the behavior to replace.
- [ ] RED: Add a `tasksFrom` or derive test showing that, today, the latest event array entry wins without freshness metadata.
- [ ] GREEN: Confirm the tests fail or are marked as characterization gaps before implementing the new behavior.
- [ ] REFACTOR: Name test fixtures around active, pending, completed, failed, and cancelled states.

### Gate 1 -> 2

- [ ] Prompt context is proven complete at request build time.
- [ ] Current UI and derive limitations are captured by tests.

### Phase 2: Compact Task Panel

#### M3: Task Ordering Helper

- [ ] RED: Add tests for task display ordering: `in_progress`, then `pending`, then `completed`, `failed`, and `cancelled`.
- [ ] GREEN: Implement a pure ordering helper for display tasks.
- [ ] RED: Add stability tests proving tasks with the same status keep their original relative order.
- [ ] GREEN: Preserve stable ordering within each status group.
- [ ] REFACTOR: Keep ordering logic out of JSX so host, UI, or story fixtures can reuse it if useful.

#### M4: Five-Row Limit and Overflow

- [ ] RED: Add `TasksPanel` tests for exactly five tasks, six tasks, and more than six tasks.
- [ ] GREEN: Render at most five task rows.
- [ ] GREEN: Render an overflow row as `...N more` when hidden tasks exist.
- [ ] RED: Add a test proving active and pending tasks are prioritized into the visible five before done/error states.
- [ ] GREEN: Apply ordering before truncation.
- [ ] REFACTOR: Keep the header count based on the full task list, not only visible rows.

### Gate 2 -> 3

- [ ] Task panel renders no more than five task rows.
- [ ] Overflow row appears only when tasks are hidden.
- [ ] Active and upcoming tasks are visible before terminal states.
- [ ] Prompt checklist still includes all tasks.

### Phase 3: Snapshot Freshness

#### M5: Protocol Freshness Metadata

- [ ] RED: Add protocol tests for a `tasks.current` sequence or revision field.
- [ ] GREEN: Extend `TaskRegistry` snapshots or `tasks.current` events with monotonic freshness metadata.
- [ ] RED: Add backward-compatibility tests for old `tasks.current` events that lack metadata if existing logs require it.
- [ ] GREEN: Decode legacy snapshots safely, with conservative ordering behavior.
- [ ] REFACTOR: Keep freshness metadata separate from per-task IDs so clearing and recreating tasks cannot collide.

#### M6: Host Replay and Standby Guard

- [ ] RED: Add host tests where an older `tasks.current` event arrives after a newer one.
- [ ] GREEN: Ignore stale snapshots in standby/replay load paths.
- [ ] RED: Add a test proving live leaders do not clobber their own newer registry state from read-back snapshots.
- [ ] GREEN: Preserve the existing leader ownership rule while adding freshness checks.
- [ ] REFACTOR: Centralize freshness comparison so web and host do not disagree.

#### M7: Web Derivation Freshness

- [ ] RED: Add derive tests where a stale `tasks.current` follows a fresh one in the event list.
- [ ] GREEN: Update `tasksFrom` to select the freshest valid task snapshot instead of blindly taking the latest array entry.
- [ ] RED: Add tests for same-revision tie behavior.
- [ ] GREEN: Preserve deterministic tie handling.
- [ ] REFACTOR: Keep `TasksPanel` purely presentational; freshness belongs in derivation/state.

### Gate 3 -> 4

- [ ] Fresh snapshots win over stale snapshots in host and web tests.
- [ ] Legacy task events decode safely if supported.
- [ ] Leader, standby, and replay behavior remains deterministic.

### Phase 4: End-to-End Verification

#### M8: Stream and UI Coverage

- [ ] RED: Add an integration or hermetic e2e test that drives `task_create` and `task_update` through the host/session stream.
- [ ] GREEN: Verify the emitted `tasks.current` events carry freshness metadata and the web derivation receives the newest state.
- [ ] RED: Add browser or component coverage for a long task list rendering only five rows plus overflow.
- [ ] GREEN: Verify visual order and overflow text match the requested behavior.
- [ ] GREEN: Run host task registry tests, web task panel tests, derive tests, typecheck, lint, and hermetic e2e.
- [ ] REFACTOR: Record exact verification commands and any gated live-model limitations in the progress report.

### Done Gate

- [ ] Each provider request is proven to receive the current full task registry at prompt-build time.
- [ ] UI shows at most five tasks and `...N more` underneath when needed.
- [ ] Visible task order is active, upcoming, then terminal states.
- [ ] Stale task snapshots cannot overwrite newer task state.
- [ ] Full verification commands pass.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

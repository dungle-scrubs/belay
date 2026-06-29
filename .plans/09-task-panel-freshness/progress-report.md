# Task Panel Freshness - Progress Report

## Summary

- Current focus: M8 - Stream and UI Coverage
- Current cutoff blockers: 12
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 49

## Current Cutoff Blockers

### Phase 1: Current-State Characterization

#### M1: Prompt Registry Awareness

- [x] RED: Add a host test that creates or updates a task before prompt build and expects the rendered system prompt to include the current task snapshot.
- [x] GREEN: Use the existing registry and prompt builder behavior to pass the test without changing semantics.
- [x] RED: Add a test that UI truncation helpers do not affect `TaskRegistry.renderForPrompt()`.
- [x] GREEN: Keep prompt rendering based on the complete registry, not the visible UI list.
- [x] REFACTOR: Isolate any task prompt fixture setup so freshness tests can reuse it.

#### M2: Existing UI Snapshot Behavior

- [x] RED: Add a `TasksPanel` test documenting the current unbounded render as the behavior to replace.
- [x] RED: Add a `tasksFrom` or derive test showing that, today, the latest event array entry wins without freshness metadata.
- [x] GREEN: Confirm the tests fail or are marked as characterization gaps before implementing the new behavior.
- [x] REFACTOR: Name test fixtures around active, pending, completed, failed, and cancelled states.

### Gate 1 -> 2

- [x] Prompt context is proven complete at request build time.
- [x] Current UI and derive limitations are captured by tests.

### Phase 2: Compact Task Panel

#### M3: Task Ordering Helper

- [x] RED: Add tests for task display ordering: `in_progress`, then `pending`, then `completed`, `failed`, and `cancelled`.
- [x] GREEN: Implement a pure ordering helper for display tasks.
- [x] RED: Add stability tests proving tasks with the same status keep their original relative order.
- [x] GREEN: Preserve stable ordering within each status group.
- [x] REFACTOR: Keep ordering logic out of JSX so host, UI, or story fixtures can reuse it if useful.

#### M4: Five-Row Limit, Burst Grouping, and Overflow

- [x] RED: Add `TasksPanel` tests for exactly five tasks, six tasks, and more than six tasks.
- [x] GREEN: Render at most five task rows.
- [x] GREEN: Render an overflow row as `...N more` when hidden tasks exist.
- [x] RED: Add a test proving active and pending tasks are prioritized into the visible five before done/error states.
- [x] GREEN: Apply ordering before truncation.
- [x] RED: Add burst tests for 10-15 model-created tasks, including many pending tasks and mixed terminal states.
- [x] GREEN: Add a pure display-model helper that may emit `task` rows and `group` rows; group lower-priority pending or terminal tasks into broad rows like `8 upcoming tasks` or `5 completed / 2 failed`.
- [x] GREEN: Keep active `in_progress` tasks individual whenever possible, then group overflow active work only when the active bucket itself would consume the whole panel.
- [x] REFACTOR: Keep grouping display-only and deterministic; no model call, no semantic rewrite of task records, and no change to `TaskRegistry.renderForPrompt()`.
- [x] REFACTOR: Keep the header count based on the full task list, not only visible rows.

### Gate 2 -> 3

- [x] Task panel renders no more than five task rows.
- [x] Bursts of 10-15 fine-grained tasks coalesce into broader display groups when useful.
- [x] Overflow row appears only when tasks are hidden.
- [x] Active and upcoming tasks are visible before terminal states.
- [x] Prompt checklist still includes all tasks.

### Phase 3: Snapshot Freshness

#### M5: Protocol Freshness Metadata

- [x] RED: Add protocol tests for a `tasks.current` sequence or revision field.
- [x] GREEN: Extend `TaskRegistry` snapshots or `tasks.current` events with monotonic freshness metadata.
- [x] RED: Add backward-compatibility tests for old `tasks.current` events that lack metadata if existing logs require it.
- [x] GREEN: Decode legacy snapshots safely, with conservative ordering behavior.
- [x] REFACTOR: Keep freshness metadata separate from per-task IDs so clearing and recreating tasks cannot collide.

#### M6: Host Replay and Standby Guard

- [x] RED: Add host tests where an older `tasks.current` event arrives after a newer one.
- [x] GREEN: Ignore stale snapshots in standby/replay load paths.
- [x] RED: Add a test proving live leaders do not clobber their own newer registry state from read-back snapshots.
- [x] GREEN: Preserve the existing leader ownership rule while adding freshness checks.
- [x] REFACTOR: Centralize freshness comparison so web and host do not disagree.

#### M7: Web Derivation Freshness

- [x] RED: Add derive tests where a stale `tasks.current` follows a fresh one in the event list.
- [x] GREEN: Update `tasksFrom` to select the freshest valid task snapshot instead of blindly taking the latest array entry.
- [x] RED: Add tests for same-revision tie behavior.
- [x] GREEN: Preserve deterministic tie handling.
- [x] REFACTOR: Keep `TasksPanel` purely presentational; freshness belongs in derivation/state.

### Gate 3 -> 4

- [x] Fresh snapshots win over stale snapshots in host and web tests.
- [x] Legacy task events decode safely if supported.
- [x] Leader, standby, and replay behavior remains deterministic.

### Phase 4: End-to-End Verification

#### M8: Stream and UI Coverage

- [ ] RED: Add an integration or hermetic e2e test that drives `task_create` and `task_update` through the host/session stream.
- [ ] GREEN: Verify the emitted `tasks.current` events carry freshness metadata and the web derivation receives the newest state.
- [ ] RED: Add browser or component coverage for a long task list rendering only five rows plus grouped burst rows and overflow.
- [ ] GREEN: Verify visual order, grouped labels, counts, and overflow text match the requested behavior.
- [ ] GREEN: Run host task registry tests, web task panel tests, derive tests, typecheck, lint, and hermetic e2e.
- [ ] REFACTOR: Record exact verification commands and any gated live-model limitations in the progress report.

### Done Gate

- [ ] Each provider request is proven to receive the current full task registry at prompt-build time.
- [ ] UI shows at most five tasks and `...N more` underneath when needed.
- [ ] UI coalesces 10-15 task bursts into broader grouped rows when individual rows would make the panel noisy.
- [ ] Visible task order is active, upcoming, then terminal states.
- [ ] Stale task snapshots cannot overwrite newer task state.
- [ ] Full verification commands pass.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

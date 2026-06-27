# Task Panel Freshness - Implementation Plan

## 0. Hard Dependencies

None.

## Architecture

Trevor already has a model-owned task registry. `task_create` and `task_update` mutate `TaskRegistry` in `apps/agent-host/src/tasks.ts`; the host emits `tasks.current` on every mutation from `apps/agent-host/src/main.ts`; `SystemPromptBuilder` injects `taskRegistry.renderForPrompt()` into every provider prompt; and the web UI derives the latest task snapshot with `tasksFrom` in `apps/web/src/derive.ts`.

This plan keeps that architecture and tightens two gaps:

- the UI should render a compact, prioritized task panel instead of showing every task in raw snapshot order
- task snapshots should carry freshness metadata so stale snapshots cannot overwrite newer state in the UI or standby/replay paths

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Prompt context stays complete | The model-facing checklist remains full-size even when the UI truncates to five rows. <!-- D-001 --> |
| Visible panel is capped | The panel shows at most five visible task rows and an overflow row like `...3 more` when tasks are hidden. <!-- D-002 --> |
| Visible ordering is semantic | Render active `in_progress` first, upcoming `pending` second, and terminal states last. <!-- D-003 --> |
| Freshness is explicit | `tasks.current` needs monotonic metadata so consumers can ignore older snapshots. <!-- D-004 --> |
| Status remains model-owned | This plan does not infer task completion from tool lifecycle or command completion. <!-- D-005 --> |
| Request awareness is testable | Tests or diagnostics prove provider requests receive the current task registry at prompt-build time. <!-- D-006 --> |

### Boundaries

Owned by this plan:

- `TaskRegistry` snapshot metadata and ordering helpers
- `tasks.current` protocol shape and backward-compatible decoding if needed
- host emit/replay/standby freshness handling
- `tasksFrom` derivation and stale-snapshot rejection
- `TasksPanel` ordering, limit, overflow row, and tests
- integration/e2e coverage for task stream freshness

Not owned by this plan:

- automatic status transitions from tool execution state
- task tool schema changes beyond snapshot metadata
- task persistence beyond the existing session event stream
- unrelated panel/sidebar layout work

### Current Behavior

Current prompt behavior is correct in shape: `SystemPromptBuilder` calls `this.tasks.renderForPrompt()` on each prompt build, so each request should see the latest in-memory registry state at that point. <!-- D-006 --> The task prompt block should stay complete regardless of UI truncation. <!-- D-001 -->

Current UI behavior is incomplete: `TasksPanel` maps over every task in the order received, with no display cap, no semantic ordering, and no overflow row.

Current freshness behavior is under-specified: `tasks.current` contains only `tasks`, and `tasksFrom` selects the latest event in the local event array. Without sequence or timestamp metadata, consumers cannot reject an older snapshot that arrives after or is replayed over newer state. <!-- D-004 -->

### Observability

This work touches prompt context and host/session state, so it needs observable proof points:

- a host test proving prompt render includes task changes made before the request
- a host replay/standby test proving older `tasks.current` snapshots cannot clobber newer state
- a web derivation test proving stale snapshots are ignored
- a UI test proving the panel shows ordering, limit, and overflow behavior

## Phases

### Phase 1: Current-State Characterization

**Goal:** Lock down the behavior Trevor already relies on before changing protocol or UI behavior.

**Gate from previous:** none.

#### M1: Prompt Registry Awareness

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a host test that creates or updates a task before prompt build and expects the rendered system prompt to include the current task snapshot.
  2. GREEN: Use the existing registry and prompt builder behavior to pass the test without changing semantics.
  3. RED: Add a test that UI truncation helpers do not affect `TaskRegistry.renderForPrompt()`.
  4. GREEN: Keep prompt rendering based on the complete registry, not the visible UI list. <!-- D-001 -->
  5. REFACTOR: Isolate any task prompt fixture setup so freshness tests can reuse it.

#### M2: Existing UI Snapshot Behavior

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a `TasksPanel` test documenting the current unbounded render as the behavior to replace.
  2. RED: Add a `tasksFrom` or derive test showing that, today, the latest event array entry wins without freshness metadata.
  3. GREEN: Confirm the tests fail or are marked as characterization gaps before implementing the new behavior.
  4. REFACTOR: Name test fixtures around active, pending, completed, failed, and cancelled states.

### Gate 1 -> 2

- [ ] Prompt context is proven complete at request build time.
- [ ] Current UI and derive limitations are captured by tests.

### Phase 2: Compact Task Panel

**Goal:** The visible task panel prioritizes active work, caps itself at five rows, and reports hidden work.

**Gate from previous:** Gate 1 passes.

#### M3: Task Ordering Helper

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add tests for task display ordering: `in_progress`, then `pending`, then `completed`, `failed`, and `cancelled`.
  2. GREEN: Implement a pure ordering helper for display tasks. <!-- D-003 -->
  3. RED: Add stability tests proving tasks with the same status keep their original relative order.
  4. GREEN: Preserve stable ordering within each status group.
  5. REFACTOR: Keep ordering logic out of JSX so host, UI, or story fixtures can reuse it if useful.

#### M4: Five-Row Limit and Overflow

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add `TasksPanel` tests for exactly five tasks, six tasks, and more than six tasks.
  2. GREEN: Render at most five task rows. <!-- D-002 -->
  3. GREEN: Render an overflow row as `...N more` when hidden tasks exist. <!-- D-002 -->
  4. RED: Add a test proving active and pending tasks are prioritized into the visible five before done/error states.
  5. GREEN: Apply ordering before truncation. <!-- D-003 -->
  6. REFACTOR: Keep the header count based on the full task list, not only visible rows.

### Gate 2 -> 3

- [ ] Task panel renders no more than five task rows.
- [ ] Overflow row appears only when tasks are hidden.
- [ ] Active and upcoming tasks are visible before terminal states.
- [ ] Prompt checklist still includes all tasks.

### Phase 3: Snapshot Freshness

**Goal:** Stale `tasks.current` snapshots cannot replace newer task state in host replay, standby sync, or the web UI.

**Gate from previous:** Gate 2 passes.

#### M5: Protocol Freshness Metadata

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol tests for a `tasks.current` sequence or revision field.
  2. GREEN: Extend `TaskRegistry` snapshots or `tasks.current` events with monotonic freshness metadata. <!-- D-004 -->
  3. RED: Add backward-compatibility tests for old `tasks.current` events that lack metadata if existing logs require it.
  4. GREEN: Decode legacy snapshots safely, with conservative ordering behavior.
  5. REFACTOR: Keep freshness metadata separate from per-task IDs so clearing and recreating tasks cannot collide.

#### M6: Host Replay and Standby Guard

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add host tests where an older `tasks.current` event arrives after a newer one.
  2. GREEN: Ignore stale snapshots in standby/replay load paths. <!-- D-004 -->
  3. RED: Add a test proving live leaders do not clobber their own newer registry state from read-back snapshots.
  4. GREEN: Preserve the existing leader ownership rule while adding freshness checks.
  5. REFACTOR: Centralize freshness comparison so web and host do not disagree.

#### M7: Web Derivation Freshness

- **Dependencies:** M6
- **Effort:** S
- **Tasks:**
  1. RED: Add derive tests where a stale `tasks.current` follows a fresh one in the event list.
  2. GREEN: Update `tasksFrom` to select the freshest valid task snapshot instead of blindly taking the latest array entry. <!-- D-004 -->
  3. RED: Add tests for same-revision tie behavior.
  4. GREEN: Preserve deterministic tie handling.
  5. REFACTOR: Keep `TasksPanel` purely presentational; freshness belongs in derivation/state.

### Gate 3 -> 4

- [ ] Fresh snapshots win over stale snapshots in host and web tests.
- [ ] Legacy task events decode safely if supported.
- [ ] Leader, standby, and replay behavior remains deterministic.

### Phase 4: End-to-End Verification

**Goal:** The full task workflow works through the real session stream and the UI remains compact.

**Gate from previous:** Gate 3 passes.

#### M8: Stream and UI Coverage

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add an integration or hermetic e2e test that drives `task_create` and `task_update` through the host/session stream.
  2. GREEN: Verify the emitted `tasks.current` events carry freshness metadata and the web derivation receives the newest state.
  3. RED: Add browser or component coverage for a long task list rendering only five rows plus overflow.
  4. GREEN: Verify visual order and overflow text match the requested behavior.
  5. GREEN: Run host task registry tests, web task panel tests, derive tests, typecheck, lint, and hermetic e2e. <!-- D-007 -->
  6. REFACTOR: Record exact verification commands and any gated live-model limitations in the progress report.

### Done Gate

- [ ] Each provider request is proven to receive the current full task registry at prompt-build time.
- [ ] UI shows at most five tasks and `...N more` underneath when needed.
- [ ] Visible task order is active, upcoming, then terminal states.
- [ ] Stale task snapshots cannot overwrite newer task state.
- [ ] Full verification commands pass. <!-- D-007 -->

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Protocol metadata breaks old logs | medium | medium | Add decode tests for legacy `tasks.current` events and choose a conservative fallback. | implementer |
| UI truncation accidentally affects prompt context | high | low | Keep display helpers separate from `TaskRegistry.renderForPrompt()` and test the prompt block. <!-- D-001 --> | implementer |
| Freshness comparison differs between host and web | medium | medium | Centralize comparison semantics or share fixtures across host/web tests. | implementer |
| Users still see stale statuses because the model misses `task_update` | medium | high | This plan fixes stale snapshots, not model-owned update omissions; automatic status inference remains separate. <!-- D-005 --> | implementer |
| Long task labels overflow after truncation | low | medium | Add component tests or visual checks for long labels and blocked-by text. | implementer |

## Escape Hatches

1. **If protocol metadata is too invasive:** keep the wire payload backward-compatible by adding optional metadata and deriving freshness from event envelope metadata where available.
2. **If host and web cannot share a comparison helper cleanly:** duplicate a tiny comparison function only with identical fixture tests in both packages.
3. **If live-model task update omissions remain visible:** open a separate plan for host-assisted task lifecycle, because automatic status inference changes ownership semantics. <!-- D-005 -->

## Progress Report Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "09-task-panel-freshness"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test -- --project unit
pnpm test -- --project web
pnpm test -- --project integration
pnpm test -- --project e2e
```

## Decisions

Canonical decisions are in `.plans/09-task-panel-freshness/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "09-task-panel-freshness"
```

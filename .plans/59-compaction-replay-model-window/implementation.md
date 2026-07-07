# Compaction Replay Model Window - Implementation Plan

Fix the host compaction gate so a resumed session budgets against the model that will actually run the next turn, not an old minimum context window reconstructed from unrelated historical turns.

## 0. Hard Dependencies

None. This is a host correctness fix over existing compaction, ModelRef, and scheduler behavior.

## Architecture

The bug is a state reconstruction bug, not a summarizer bug. `CompactionController` retains a budget window so transient larger turns do not suppress compaction for the foreground model. That is correct only when usage samples and provider/model identity are replayed together.

Today replay rebuilds usage and context-window samples from `assistant.progress` and `assistant.completed`, but the controller observes provider/model identity only in `startTurn`. Blocking-before compaction runs before `startTurn`, so a new prompt's selected model cannot reset the retained budget window before `needed()` evaluates.

The target shape has one provider-resolution seam, then two callers:

- Replay/live prompt preflight resolves the answerable `user.message` provider and records it in `CompactionController` before `TurnScheduler.noteTurn`.
- `startTurn` uses the same resolver before launching the turn.

<!-- D-001 --> Provider/model resolution is extracted into one shared host resolver used by replay preflight, live `startTurn`, and later provider-boundary refactors.

<!-- D-002 --> Compaction replay state includes foreground provider/model identity, not only usage and context-window numbers.

<!-- D-003 --> A prompt's target provider is observed before blocking-before compaction evaluates the budget gate.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| The scheduler must stay provider-agnostic | Do not move ModelRef or provider-registry logic into `TurnScheduler`. |
| Replay must be deterministic | Reconnect resets compaction controller state, then rebuilds it from the replayed log in order. |
| Larger interleaved windows must not suppress needed folds | Preserve the existing retained-window behavior when provider identity is unchanged. |
| A real foreground model change must re-anchor the budget | The bug fix must keep `noteProvider` as the model-change boundary. |
| ModelRef and legacy provider strings both still exist | The shared resolver must support catalog `ModelRef` and legacy registered provider ids. |

### Boundaries

- **Provider resolver:** a small host-owned helper, likely under `apps/agent-host/src/providers/`, owns `user.message` provider resolution from `ModelRef` plus legacy provider fallback. It wraps the current `buildSourceProvider(...) ?? pickProvider(...)` logic.
- **Compaction controller:** owns compaction budget state and exposes replay reset plus debug snapshot. It does not decode session events or know about the provider registry.
- **Main event handler:** observes answerable user prompts before passing them to the scheduler, then lets the scheduler continue to own turn timing.
- **Start turn:** consumes the resolver and keeps provider-specific runtime side effects: residency, internet refresh, and turn publication.
- **Tangent adoption:** first-cut tangents still run without compaction; only update tangent-specific controller use if the shared resolver extraction changes imports.

### Observability

<!-- D-004 --> Add an inspectable compaction budget snapshot showing latest served window, retained budget window, last input, provider identity, and floor state.

The snapshot should surface through `/doctor` host facts or adjacent debug output, not as a new protocol event. The visible ctx meter can legitimately show latest served window while compaction budgets from a retained replay window; that distinction must be inspectable without querying SQLite.

No diagnostics failure may affect a user turn. Snapshot rendering is best-effort and must not throw out of `/doctor`.

## Phases

### Phase 1: Correct Replay And Preflight Compaction Budgeting

**Goal:** A resumed session with old small-window history and a new large-window prompt does not compact until the prompt is actually over the new model's budget.

**Gate from previous:** none.

#### M1: Reproduce The Stale Replay Window

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a host unit characterization for the failing sequence: replay a same-session small-window usage sample, replay a later larger-window turn, then submit a new large-window `ModelRef` prompt and assert no blocking-before compaction.
  2. GREEN: Add only the minimum test harness seams needed to express replayed `user.message`, `assistant.progress`, `assistant.completed`, and scheduler compaction calls.
  3. RED: Add a controller-level regression proving provider changes reset the retained budget window during replay, not only live start.
  4. GREEN: Pin the current failure without changing production behavior yet.
  5. REFACTOR: Name the fixture after the product rule, not the incident, for example `replayedForegroundWindow`.

#### M2: Extract Shared Turn Provider Resolution

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add resolver tests for catalog `ModelRef`, legacy provider ids, unknown source fallback, and reasoning-preserving `ModelRef` input.
  2. GREEN: Extract the current provider selection from `startTurn` into one typed resolver helper.
  3. RED: Add a test that `startTurn` and preflight use the same resolver result for the same `user.message`.
  4. GREEN: Rewire `startTurn` to consume the helper with no behavior change.
  5. REFACTOR: Add a module-level ownership comment to the resolver and remove duplicated selection comments from callers.

#### M3: Rebuild Compaction Provider State During Replay

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add a replay-order test showing answerable `user.message` observes provider identity before usage samples update compaction state.
  2. GREEN: In `handleEvent`, resolve the provider for answerable `user.message` and call `compactionController.noteProvider(provider)` before `scheduler.noteTurn(message)`.
  3. RED: Add a reconnect test showing compaction state resets before a full replay, including `lastInput`, latest window, retained budget window, provider, floor marker, and last fold.
  4. GREEN: Add `CompactionController.resetForReplay()` and call it from `connect()` beside `conversationLog.reset()` and `scheduler.resetForReconnect()`.
  5. REFACTOR: Keep all compaction replay mutation paths named and colocated so future reconnect work cannot reset only part of the state.

#### M4: Fix Blocking-Before Preflight For New Prompts

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Extend the scheduler/host characterization so a new prompt's provider is observed before `compaction.needed()` can run.
  2. GREEN: Wire the preflight observation in the live prompt path without moving provider logic into `TurnScheduler`.
  3. RED: Add a negative regression that a genuinely over-budget prompt on a smaller selected model still triggers blocking-before compaction.
  4. GREEN: Preserve existing `COMPACT_WHEN` and retained-window behavior for same-provider and interleaved larger-window turns.
  5. REFACTOR: Tighten comments around blocking-before compaction so they name provider preflight as part of the contract.

#### M5: Expose And Verify The Budget Snapshot

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add a `/doctor` or host-facts test expecting latest served window and retained budget window to be visible separately.
  2. GREEN: Add a `CompactionController.debug()` or equivalent snapshot and render it in host facts.
  3. RED: Add a regression for the original observed numbers: latest `20.9k / 262k`, retained stale `6144`, and a new large-window prompt must show why compaction would or would not run.
  4. GREEN: Make diagnostics best-effort and non-throwing.
  5. REFACTOR: Remove any incident-only debug code and keep the user-visible wording compact.

### Gate 1->done

- [ ] The stale replay-window test fails before the fix and passes after the shared resolver plus replay reset land.
- [ ] Existing compaction-controller tests for undercounting providers, interleaved larger windows, and genuine foreground upgrades still pass.
- [ ] `TurnScheduler` remains provider-agnostic.
- [ ] `/doctor` or host facts expose retained budget window separately from latest served window.
- [ ] Unit, integration, typecheck, lint, and hermetic e2e gates pass or have stated unrelated blockers.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Resetting compaction state drops the last fold during reconnect | high | medium | Replay `context.compacted` events after reset and assert `lastFold` is rebuilt. | host |
| Preflight provider resolution duplicates start-time side effects | medium | medium | Resolver returns provider only; residency, internet refresh, and turn effects stay in `startTurn`. | host |
| Fix suppresses needed compaction for small selected models | high | low | Add negative regression for a smaller target model over `COMPACT_WHEN`. | host |
| Doctor output becomes misleading or noisy | low | medium | Render compact fields only: provider, input, latest window, retained window, floor. | host |

## Escape Hatches

1. **If extracting the resolver causes broad provider churn:** keep the helper local to `agent/start-turn.ts` in the first pass, but still make both preflight and start call the same helper.
2. **If `/doctor` host facts are too crowded:** expose the snapshot only under debug mode while keeping the controller method available for tests.

## Progress Report Accounting

The progress report is the implementation resume state. It has five current-cutoff milestones and no deferred work. Run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "59-compaction-replay-model-window"
```

## Validation Commands

```bash
pnpm test:unit -- apps/agent-host/src/agent/compaction-controller.test.ts apps/agent-host/src/agent/turn-scheduler.test.ts
pnpm test:unit
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm test:e2e
```

## Decisions

Canonical decisions are in `.plans/59-compaction-replay-model-window/plan.db`.

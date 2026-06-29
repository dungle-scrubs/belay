# 03.2 - Context-Budget Fidelity Fixes - Implementation Plan

## 0. Hard Dependencies

<!-- D-006 --> None. Composes with `03.1-context-pressure-synthesis` (both touch
`apps/agent-host/src/agent/compaction-controller.ts`), but neither hard-blocks the other.
03.1's `usageSeed()` / step-0 `context_pressure` gate read the same `lastInputValue` that
Fix #1 here retargets, so landing this plan also unblocks 03.1's backstop. If 03.1 ships
first, Fix #1 retargets the metric its seed carries; if not, the trigger fix stands alone.

---

## Architecture

A real session overflowed despite a working compaction system: prompt `~412,369` tokens vs
MiniMax-M3's real `262,144` window, with **zero** `context.compacted` events across `5,054`
events (session `trevor-20260629-033048z-eb100ca0`). The safety net never fired because the
host's notion of "how full is the context" is computed three different ways that disagree,
and the model-window metadata it compares against is stale and unstable across model switches.

Three numbers must become one honest budget:

```
                          assembled history (turns + carried tool results)
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                  │                                 │
  compaction TRIGGER              compaction PLANNER                  pre-send GUARD
  compaction-controller.ts:91     compaction-planner.ts:140           error-classifier.ts:61
  overBudget(lastInputValue,…)    estimateTokens(turn.chars)          promptTooBig(est, window)
        ▲                                  ▲                                 ▲
        │ provider usage.input             │ chars/4 estimate                │ chars/4 estimate
        │ (main.ts:1828 noteUsage)         │                                 │
   UNDER-COUNTS  ◄── the divergence ──►  AGREE ──────────────────────────► AGREE
   (≤141k all session)                  (hit ~412k → tripped the guard)

  window compared against:  resolveContextWindow(model)   ── stale (512000) & per-turn unstable
                            model-metadata-overrides.ts:22 (MODEL_METADATA_OVERRIDES = {})
```

The fix is three surgical changes at existing seams - no new module:

1. **One budget metric.** The trigger reads the same chars/4 `estimateTokens` of the assembled
   history that the planner and guard already use (D-002), so the watchdog sees the danger the
   guard later trips on.
2. **Correct + self-healing windows.** Populate the empty override map for MiniMax-M3, and learn
   the real window from the provider's own overflow error so the next stale bundled value
   self-heals (D-004).
3. **Budget against the replay window.** Compaction budgets against the window that will actually
   replay the full shared history (the foreground model / the session minimum), not whatever
   model took the last - possibly delegate - turn (D-005).

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `overBudget(lastInputValue, lastWindowValue, COMPACT_WHEN)` is the only trigger (`compaction-controller.ts:91`) | If `lastInputValue` is the under-counting provider number, the fold never schedules; this is the load-bearing line for Fix #1 |
| `noteUsage(decoded.usage.input, decoded.usage.contextWindow)` (`main.ts:1828`) is the sole writer of the trigger inputs | Fix #1 changes what is fed here; Fix #3 changes which window is retained |
| Planner already measures in `estimateTokens` (`compaction-planner.ts:140`); guard already measures in `estimateTokens` (`error-classifier.ts:61` + `turn.ts:86` overhead) | The estimate is the existing common currency - unify onto it, do not invent a tokenizer (D-003) |
| `MODEL_METADATA_OVERRIDES` is empty (`model-metadata-overrides.ts:22`); `resolveContextWindow` returns bundled value when no override (`:29`, `catalog.ts:201`) | MiniMax-M3's bundled `512000` overstates the real `262144`; `0.8*512000 = 410k` trigger, `>=512000` guard - both far above the real ceiling |
| Provider overflow is already classified (`error-classifier.ts`, `packages/session/src/context-overflow.ts`) and carries the real `N` (`promptTooBig` shape) | The learned-window signal already exists; Fix #2 only has to capture and persist `N` |
| `lastWindowValue` is overwritten by every turn, including delegate/sub-turns on other models | A 1M-window delegate turn sets the trigger to `0.8*1M = 800k`; Fix #3 must retain the foreground/min window instead |

### Boundaries

- **`CompactionController`** owns "current context after the last turn" and the over-budget
  decision. Fix #1 changes the *value* it is fed (estimate, not raw provider input); Fix #3
  changes the *window* it retains (foreground/min, not last-turn). No new owner, no new writer.
- **`main.ts`** stays the single seam that knows both the decoded turn result and the controller;
  it computes the assembled-history estimate (or reuses the guard's) and notes it, and notes the
  foreground window. The seam stays one-directional.
- **`resolveContextWindow` / `model-metadata-overrides.ts`** stays the single resolver of a
  model's effective window. Fix #2 adds a static entry and a learned-override store that the
  same function consults; callers (`catalog.ts:201`) are unchanged.
- **The estimator (`usage/breakdown.ts` `estimateTokens` / `CHARS_PER_TOKEN`)** stays the one
  token-estimation primitive; all three consumers route through it (D-003).

### Observability

- Emit the existing compaction breadcrumb when the trigger evaluates: log the estimate, the
  provider input, the effective window, and the fraction, so a future "why didn't it fold"
  question is answerable from one line. The estimate-vs-provider gap is the headline signal.
- When a learned window override fires (Fix #2), log `{model, bundledWindow, learnedWindow,
  source: "overflow-error"}` so a stale bundle is visible the first time it self-heals.
- When the retained foreground/min window differs from the last turn's window (Fix #3), log both
  so an interleaved delegate model is visible as the reason a fold did or did not run.
- No new persisted event types; reuse the existing `context.compacted` and overflow signals.

---

## Phases

### Phase 1: One honest budget metric (Fix #1)

**Goal:** The compaction trigger fires off the same assembled-history estimate the pre-send guard
trips on, so a session whose provider `usage.input` under-counts still folds before overflow.

**Gate from previous:** none (entry phase).

#### M1: estimate-driven compaction trigger

- **Dependencies:** none
- **Effort:** M
- **Files:** `apps/agent-host/src/agent/compaction-controller.ts` (+ `.test.ts`),
  `apps/agent-host/src/main.ts` (~1828), `apps/agent-host/src/usage/breakdown.ts` (reuse)
- **Tasks:**
  1. RED: reproduce the divergence - a turn whose provider `usage.input` is well under
     `0.8 * window` but whose assembled-history `estimateTokens` is over it must mark the
     controller over-budget (today it does not).
  2. RED: a turn where provider input and estimate agree behaves exactly as today (regression).
  3. GREEN: feed the trigger the assembled-history estimate. At `main.ts:1828` compute (or reuse
     from the pre-send path) `estimateTokens` over the assembled conversation and pass
     `max(decoded.usage.input, estimate)` into `noteUsage`; `overBudget` now sees the true size.
  4. REFACTOR: ensure the trigger, the planner (`compaction-planner.ts:140`), and the guard
     (`error-classifier.ts:61`) all read one estimator (D-003); no second token notion remains.

### Gate 1 (definition of done)

- [ ] Under-counting-provider session marks over-budget from the estimate.
- [ ] Agreeing-metric and first-turn paths unchanged (regression guards green).

### Phase 2: Correct + self-healing model windows (Fix #2)

**Goal:** `resolveContextWindow` returns MiniMax-M3's real `262144`, and any model whose bundled
window is stale self-heals from the provider's own overflow error.

**Gate from previous:** Gate 1 green (an honest estimate is only useful against an honest window).

#### M2: MiniMax-M3 static override

- **Dependencies:** none
- **Effort:** S
- **Files:** `apps/agent-host/src/providers/model-metadata-overrides.ts` (+ `.test.ts`)
- **Tasks:**
  1. RED: `resolveContextWindow("MiniMax-M3", 512000)` returns `262144`, not the bundled value.
  2. GREEN: add the `MiniMax-M3 -> { contextWindow: 262144 }` entry to `MODEL_METADATA_OVERRIDES`
     with a comment citing the observed session.
  3. REFACTOR: keep override precedence explicit (static override > learned > bundled).

#### M3: learn the real window from overflow errors

- **Dependencies:** M2
- **Effort:** M
- **Files:** `apps/agent-host/src/providers/model-metadata-overrides.ts`,
  `apps/agent-host/src/providers/error-classifier.ts`,
  `packages/session/src/context-overflow.ts` (reuse predicate), `apps/agent-host/src/main.ts`
- **Tasks:**
  1. RED: a provider overflow ("the prompt (~X tokens) is too big for the N-token context
     window") records a learned window `N` for that model that subsequent `resolveContextWindow`
     calls honor (when no stricter static override exists).
  2. RED: a learned window never widens a model past its static override or bundled value (only
     tightens toward reality); a non-overflow error records nothing.
  3. GREEN: extract `N` from the classified overflow, persist a learned override keyed by model,
     and have `resolveContextWindow` consult it after static overrides and before the bundled
     value.
  4. REFACTOR: dedupe the `N`-extraction with the existing classifier; emit the self-heal log.

### Gate 2 (definition of done)

- [ ] MiniMax-M3 resolves to `262144`.
- [ ] An overflow error tightens the effective window for later turns; no widening; no effect from
      non-overflow errors.

### Phase 3: Budget against the replay window (Fix #3)

**Goal:** Interleaved delegate turns on large-window models no longer starve the fold; the
foreground history stays foldable against the window that will actually replay it.

**Gate from previous:** Gate 1 + Gate 2 green.

#### M4: foreground / session-minimum window in CompactionController

- **Dependencies:** M1
- **Effort:** M
- **Files:** `apps/agent-host/src/agent/compaction-controller.ts` (+ `.test.ts`),
  `apps/agent-host/src/main.ts` (~757 fold gate, ~1828 noteUsage)
- **Tasks:**
  1. RED: a session that runs delegate turns at a `1,000,000` window between foreground turns at
     `262,144` still marks over-budget from the foreground window (today the `1M` delegate turn
     resets the trigger and the fold never runs).
  2. RED: a post-restart full-history replay against the smaller window does not overflow because
     the history was kept foldable while the session was live.
  3. GREEN: retain the foreground/session-minimum context window in the controller (do not let a
     larger-window turn overwrite a smaller retained window for budgeting); `overBudget` uses the
     retained window; re-validate / schedule a fold on a switch to a smaller window.
  4. REFACTOR: confirm a genuine foreground model upgrade (to a larger window) is still honored
     once it is the foreground, not just any transient turn.

### Gate 3 (definition of done)

- [ ] Interleaved large-window delegate turns no longer suppress the fold.
- [ ] Reproduced scenario (growing history, MiniMax foreground, 1M delegates, host restart)
      folds before the replay overflows.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Estimate (chars/4) over-counts vs the provider, folding earlier than strictly needed | low | medium | Folding early is safe and cheap relative to overflow; `max(provider, estimate)` only ever tightens; estimator accuracy is a tracked follow-up (D-003) |
| A learned window from a transient/mislabeled provider error wrongly tightens a model | medium | low | Only tighten, never widen (M3 task 2); key by model id; learned value defers to explicit static override; log every self-heal for audit |
| Retaining the session-minimum window over-compacts when the user permanently upgrades the foreground model to a larger window | low | low | Re-validate on foreground change (M4 task 4); minimum tracks the foreground, not every transient delegate turn |
| Overlap with 03.1 on `CompactionController` causes merge friction | low | medium | D-006: coordinate the seam; Fix #1 retargets the same `lastInputValue` 03.1's seed reads, so the change is additive in intent |

---

## Escape Hatches

1. **If `max(provider, estimate)` folds too aggressively** in practice, gate the estimate path
   behind a small margin (only let the estimate drive the trigger when it exceeds the provider
   number by more than a tolerance), keeping the agreeing-metric path identical.
2. **If learned-window self-heal proves noisy**, ship M2 (static override) alone and demote M3 to
   a logged-only observation (record the discrepancy without mutating the resolved window) until
   the signal is trusted.
3. **If session-minimum windowing is too coarse**, narrow Fix #3 to "ignore delegate/sub-turn
   windows for budgeting" (retain only foreground-turn windows) rather than a strict minimum.

---

## Progress Report Accounting

See `progress-report.md`. This plan has no deferred/superseded buckets at creation; all
milestones are current-cutoff. The current focus marker is M1.

Before resuming implementation or declaring convergence:

```bash
mise x node@22 -- npx tsx ~/.claude/skills/planner/scripts/plan-db.ts check-progress --plan "03.2-context-budget-fidelity"
```

---

## Validation Commands

```bash
# From repo root
pnpm --filter @trevor/agent-host test -- compaction-controller compactor compaction-planner overflow-recovery error-classifier model-metadata-overrides
pnpm -w typecheck
pnpm -w lint   # biome
```

---

## Decisions

Canonical decisions are in `.plans/03.2-context-budget-fidelity/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.claude/skills/planner/scripts/plan-db.ts query-decisions --plan "03.2-context-budget-fidelity"
```

<!-- D-001 --> One plan, three context-budget fidelity fixes (trigger metric, model windows, replay window).
<!-- D-002 --> Drive the compaction trigger off the same chars/4 assembled-history estimate the guard and planner use.
<!-- D-003 --> Unify on the existing `estimateTokens` estimator; no real tokenizer in this plan.
<!-- D-004 --> Static MiniMax-M3 = 262144 override now, plus self-healing learned windows from overflow errors.
<!-- D-005 --> Budget against the window that replays the shared history (foreground / session-minimum), not the last turn's.
<!-- D-006 --> Composes with 03.1; not a hard blocker (shared `CompactionController` seam).

# Context-Budget Fidelity Fixes - Progress Report

## Summary

- **Current cutoff blockers:** 15
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - estimate-driven compaction trigger

## Completed Current State / Hard Dependencies

- [x] Trigger seam confirmed on `main`: `compaction-controller.ts:91` `overBudget(lastInputValue, lastWindowValue, COMPACT_WHEN)`, fed solely by `main.ts:1828` `noteUsage(decoded.usage.input, decoded.usage.contextWindow)`.
- [x] Estimator confirmed shared by planner (`compaction-planner.ts:140` `estimateTokens(turn.chars)`) and guard (`error-classifier.ts:61` `promptTooBig`, `turn.ts:86` overhead) via `usage/breakdown.ts`.
- [x] `MODEL_METADATA_OVERRIDES` confirmed empty (`model-metadata-overrides.ts:22`); `resolveContextWindow` returns bundled value (`:29`, `catalog.ts:201`). Bundled MiniMax window overstates reality (comment `:5`).
- [x] Overflow already classified with the real window `N` (`error-classifier.ts`, `packages/session/src/context-overflow.ts`).
- [x] Diagnosis grounded in session `trevor-20260629-033048z-eb100ca0`: 412,369-token prompt vs 262,144 window; provider `usage.input` peaked at 141k; zero `context.compacted` events across 5,054 events; windows recorded per turn oscillated 1,000,000 / 512,000 / 262,144.

## Current Cutoff Blockers

### M1 - estimate-driven compaction trigger
- [ ] RED: provider `usage.input` under `0.8*window` but assembled-history `estimateTokens` over it marks the controller over-budget (today it does not).
- [ ] RED: agreeing provider/estimate turn behaves exactly as today (regression).
- [ ] GREEN: at `main.ts:1828` feed `max(decoded.usage.input, estimateTokens(assembled))` into `noteUsage`; `overBudget` sees the true size.
- [ ] REFACTOR: trigger, planner, and guard all read one estimator; no second token notion remains.

### M2 - MiniMax-M3 static override
- [ ] RED: `resolveContextWindow("MiniMax-M3", 512000)` returns `262144`.
- [ ] GREEN: add `MiniMax-M3 -> { contextWindow: 262144 }` to `MODEL_METADATA_OVERRIDES` with a session-citing comment.
- [ ] REFACTOR: explicit precedence (static override > learned > bundled).

### M3 - learn the real window from overflow errors
- [ ] RED: a provider overflow records a learned window `N` that later `resolveContextWindow` calls honor.
- [ ] RED: a learned window only tightens (never widens past static/bundled); non-overflow errors record nothing.
- [ ] GREEN: extract `N` from the classified overflow, persist a learned override keyed by model, consult it after static and before bundled.
- [ ] REFACTOR: dedupe `N`-extraction with the classifier; emit the self-heal log.

### M4 - foreground / session-minimum window in CompactionController
- [ ] RED: delegate turns at `1,000,000` between foreground turns at `262,144` still mark over-budget from the foreground window.
- [ ] RED: post-restart full-history replay against the smaller window does not overflow.
- [ ] GREEN: retain the foreground/session-minimum window for budgeting; `overBudget` uses it; re-validate/fold on a switch to a smaller window.
- [ ] REFACTOR: a genuine foreground upgrade to a larger window is still honored once it is the foreground.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

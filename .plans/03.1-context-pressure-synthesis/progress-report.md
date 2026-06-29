# Context-Pressure Synthesis Fixes - Progress Report

## Summary

- **Current cutoff blockers:** 16
- **Completed current work:** 16
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** complete - all milestones (M1-M4) landed

## Completed Current State / Hard Dependencies

- [x] `CompactionController` already captures last-turn usage (`lastInputValue` / `lastWindowValue`) via `noteUsage` / `noteTurnCompleted` / `noteCompacted`.
- [x] `context_pressure` gate, `synthesize()` path, and the `emptyRetried` budget exist in `loop.ts`.
- [x] Turn-loop files confirmed identical on `main` and `feat/03-filesystem-root-taxonomy` (plan line refs valid).

## Current Cutoff Blockers

### M1 - `usageSeed()` accessor on `CompactionController`
- [x] RED: `usageSeed()` returns `undefined` before any usage; returns latest `{ input, contextWindow }` after `noteUsage` / `noteTurnCompleted` / `noteCompacted`.
- [x] GREEN: add read-only `usageSeed()` returning captured values when `lastWindowValue > 0`, else `undefined`.
- [x] REFACTOR: keep read-only; no fraction logic in the accessor.

### M2 - thread `seedUsage` through `publishTurn` -> `runAgent`
- [x] RED: seeded over-fraction `runAgent` emits `context_pressure` and routes to `synthesize()` at step 0 (no `tool_*` before the stop).
- [x] RED: seeded under-fraction `runAgent` runs the first tool round as today (regression guard).
- [x] RED: no-seed `runAgent` behaves exactly as today (first-turn parity).
- [x] GREEN: add `seedUsage?` to `RunAgentOptions` + `publishTurn` options; seed `lastInputTokens` / `lastContextWindow` (default 0); read `compactionController.usageSeed()` at `main.ts:494`.
- [x] REFACTOR: update the `loop.ts:424-429` comment block to document the seed source.

### M3 - pre-baseline the progress guard under seeding
- [x] RED: mid-range seed does not make step-0 `contextAdvanced` spuriously true; first real usage event does not re-baseline `checkpointInputTokens`.
- [x] GREEN: when seeding, set `checkpointInputTokens = seedUsage.input` and `checkpointBaselined = true`.
- [x] REFACTOR: confirm the step-axis checkpoint path is unreachable when the seed is over the fraction (the M2 over-fraction test synthesizes at step 0 and never reaches a checkpoint).

### M4 - shared empty-answer recovery for `synthesize()`
- [x] RED: blank first synthesis triggers exactly one splice-and-retry; non-blank retry surfaced as the answer.
- [x] RED: still-blank retry surfaces `{type:"empty"}`.
- [x] RED: empty-retry budget is shared with the normal path (no double-retry in one turn, either direction).
- [x] GREEN: extract `loop.ts:787-797` splice-to-current-task + retry-once into a shared helper; call it from `synthesize()` on a blank answer when the budget is unspent, re-pushing the "answer now, no tools" nudge.
- [x] REFACTOR: `synthesize()` and the normal path share the same `emptyRetried` flag; remove duplicated splice logic.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

# 03.1 - Context-Pressure Synthesis Fixes - Implementation Plan

## 0. Hard Dependencies

None. Self-contained in `apps/agent-host/src/agent` plus a thin seam through
`apps/agent-host/src/turn.ts` and `apps/agent-host/src/main.ts`.

---

## Architecture

Two coupled defects in the per-turn agent loop combine into "forever Working / nothing
synthesized" at high context. See `rfc.md` §1 for the full diagnosis. The fix is two small,
surgical changes plus one shared-helper extraction; no new module, no UI change.

```
main.ts  ── usageSeed() ──►  publishTurn(turn.ts)  ── seedUsage ──►  runAgent(loop.ts)
   │                                                                      │
CompactionController                                          seeds lastInputTokens /
(lastInputValue/                                              lastContextWindow at step 0
 lastWindowValue)                                                        │
                                                            TurnTerminationGate.assess
                                                            can now fire context_pressure
                                                            at step 0  ──►  synthesize()
                                                                              │
                                                            shared empty-retry (splice + retry once)
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Gate reads only `lastInputTokens` / `lastContextWindow`, reset to 0 per turn | At step 0 the gate is blind unless seeded; seed must be set before the first `assessTurn(0)` call |
| `overContext` requires `contextWindow > 0` (`turn-policy.ts:81-82`) | Seeding `contextWindow` is what unblocks the step-0 evaluation; seeding only `inputTokens` is insufficient |
| `contextBudgetFraction == COMPACT_WHEN == 0.8` | Fix #1 only fires when compaction floored out before the turn; it is a backstop, not a replacement (D-005) |
| One empty-retry budget per turn (`emptyRetried`) | Normal path and `synthesize()` must share it - never double-retry (D-004) |
| Durable history is rebuilt from emitted events, not the local `conversation` array | The seed and the "answer now" nudge mutate only the local `conversation`; never emit/persist them (unchanged from today) |
| First turn of a session has no prior usage | `usageSeed()` returns `undefined`; loop defaults trackers to 0 -> behaves exactly as today |

### Boundaries

- **`CompactionController`** owns "current context after the last turn". It already captures it
  for the compaction gate; this plan adds a read-only `usageSeed()` accessor. No new state, no
  new writer.
- **`main.ts`** is the only place that knows both the controller and the turn kickoff; it reads
  the seed and passes it down. The seam stays one-directional (controller -> kickoff -> turn).
- **`runAgent`** stays the single owner of the per-turn termination loop and its mutable
  trackers. The seed is an input, not a new collaborator.
- **`synthesize()` and the normal empty path** share one recovery helper; neither owns a
  private copy of splice-and-retry.

No module-level comment files are created (no new files). Each touched function keeps its
existing doc-comment; update the `lastInputTokens` / `lastContextWindow` comment block
(`loop.ts:424-429`) to note the seed source.

### Observability

- The `context_pressure` `TurnStop` already carries `pressure` + `context` (input, window,
  pressure); a step-0 synthesize emits the same stop, so the UI warning and `turn-stop-metrics`
  cover it with no new event.
- The existing `debug("agent", "turn-budget", {...})` breadcrumb (`loop.ts:613-630`) becomes
  meaningful at step 0 once seeded (non-zero `contextWindow`/`pressure`). Verify seeded values
  appear there.
- The shared empty-retry keeps the existing terminal `{type:"empty"}` event as the
  observable "synthesis produced nothing even after retry" signal.

---

## Phases

### Phase 1: Synthesis backstop fixes

**Goal:** A turn inheriting >= 0.8 context synthesizes at step 0, and a forced synthesis that
comes back blank retries once before surfacing `empty`.

**Gate from previous:** none (entry phase).

#### M1: `usageSeed()` accessor on `CompactionController`

- **Dependencies:** none
- **Effort:** S
- **Files:** `apps/agent-host/src/agent/compaction-controller.ts` (+ `.test.ts`)
- **Tasks:**
  1. RED: test `usageSeed()` returns `undefined` before any usage is noted.
  2. RED: test `usageSeed()` returns `{ input, contextWindow }` after `noteUsage`,
     `noteTurnCompleted`, and `noteCompacted` (latest values).
  3. GREEN: add `usageSeed(): { readonly input: number; readonly contextWindow: number } | undefined`
     returning the captured values when `lastWindowValue > 0`, else `undefined`.
  4. REFACTOR: keep the accessor read-only; do not duplicate the gate's fraction logic here.

#### M2: thread `seedUsage` through `publishTurn` -> `runAgent`

- **Dependencies:** M1
- **Effort:** S
- **Files:** `apps/agent-host/src/turn.ts`, `apps/agent-host/src/agent/loop.ts`
  (`RunAgentOptions`), `apps/agent-host/src/main.ts`
- **Tasks:**
  1. RED: test `runAgent` with `opts.seedUsage` over the fraction emits a `context_pressure`
     stop and routes to `synthesize()` at **step 0** (no `tool_*` event before the stop).
  2. RED: test `runAgent` with `opts.seedUsage` under the fraction runs the first tool round
     exactly as today (regression guard).
  3. RED: test `runAgent` with **no** `seedUsage` behaves exactly as today (first-turn parity).
  4. GREEN: add `seedUsage?: { input: number; contextWindow: number }` to `RunAgentOptions`;
     seed `lastInputTokens` / `lastContextWindow` from it (default 0); add the same optional
     field to `publishTurn`'s options and forward it into `runAgent`.
  5. GREEN: in `main.ts:494`, pass `...(compactionController.usageSeed() ? { seedUsage: ... } : {})`.
  6. REFACTOR: update the `loop.ts:424-429` comment block to document the seed source.

#### M3: pre-baseline the progress guard under seeding

- **Dependencies:** M2
- **Effort:** S
- **Files:** `apps/agent-host/src/agent/loop.ts` (+ `loop.test.ts` / `turn-budget.test.ts`)
- **Tasks:**
  1. RED: test that with a mid-range seed (under the fraction), the step-0 `contextAdvanced`
     signal is **not** spuriously true from `seed - 0`, and the first real usage event does
     **not** re-baseline `checkpointInputTokens` (it stays at the seed).
  2. GREEN: when seeding, set `checkpointInputTokens = seedUsage.input` and
     `checkpointBaselined = true` (so the `!checkpointBaselined` baseline at `loop.ts:719-722`
     is a no-op on the first usage event).
  3. REFACTOR: confirm the step-axis checkpoint path is unreachable when the seed is over the
     fraction (context_pressure outranks the step backstop in gate priority).

#### M4: shared empty-answer recovery for `synthesize()`

- **Dependencies:** none (independent of M1-M3; can land in parallel)
- **Effort:** M
- **Files:** `apps/agent-host/src/agent/loop.ts` (+ `loop.test.ts`)
- **Tasks:**
  1. RED: test that a blank first synthesis triggers exactly one splice-and-retry, and a
     non-blank retry is surfaced as the answer.
  2. RED: test that a still-blank retry surfaces `{type:"empty"}`.
  3. RED: test that the empty-retry budget is shared with the normal path (a turn that already
     spent its empty-retry in the normal path does not retry again in `synthesize()`, and
     vice versa).
  4. GREEN: extract the normal path's splice-to-current-task + retry-once (`loop.ts:787-797`)
     into a shared helper; call it from `synthesize()` when the forced answer is blank and the
     shared `emptyRetried` budget is unspent, re-pushing the "answer now, no tools" instruction
     before the retry stream.
  5. REFACTOR: ensure `synthesize()` and the normal path read/write the same `emptyRetried`
     flag; remove any duplicated splice logic.

### Gate 1 (definition of done)

- [ ] All new and existing agent-loop tests pass (`turn-policy`, `turn-budget`,
      `turn-termination`, `loop`, `compaction-controller`).
- [ ] Seeded-over-fraction turn synthesizes at step 0 with no prior tool round.
- [ ] Under-fraction and no-seed turns are unchanged (regression guards green).
- [ ] Blank synthesis retries once; still-blank surfaces `empty`; budget shared.
- [ ] `pnpm -w typecheck` and the repo lint pass.
- [ ] No new emitted/persisted events; no UI change.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Persistent over-fraction inheritance makes every `continue` synthesize with no tool progress | medium | medium | Accepted as correct signal (D-005); fix #2 ensures the backstop answer is non-empty and useful; existing compaction/handoff UX is the escape hatch |
| Seed drifts from real step-0 prompt (history grew since last usage; compaction folded between turns) | low | medium | Seed is a conservative trigger, not an accounting source; the real usage event at step 1 corrects the trackers; the gate only needs the >=0.8 threshold crossing |
| Sharing `emptyRetried` reduces total retries vs two independent budgets | low | low | Intended (D-004) - a turn must never double-retry; one recovery attempt is the existing contract |
| Step-0 synthesize bypasses a tool round the model genuinely needed | low | low | Only fires at >= 0.8 inherited context where a tool round would likely overflow anyway; under-fraction turns are untouched |

---

## Escape Hatches

1. **If carry-forward proves too coarse** (seed routinely wrong by enough to mis-fire): fall
   back to gating the step-0 synthesize behind a small margin above the fraction (e.g. only
   seed-fire at >= fraction + epsilon), keeping the under-fraction path identical.
2. **If sharing the empty-retry budget regresses normal-path recovery:** give `synthesize()`
   its own one-shot retry budget instead of sharing, at the cost of a possible double-retry in
   one turn (still bounded).

---

## Progress Report Accounting

See `progress-report.md`. This plan has no deferred/superseded buckets at creation; all
milestones are current-cutoff. The current focus marker is M1.

Before resuming implementation or declaring convergence:

```bash
mise x node@22 -- npx tsx ~/.claude/skills/planner/scripts/plan-db.ts check-progress --plan "03.1-context-pressure-synthesis"
```

---

## Validation Commands

```bash
# From repo root
pnpm --filter @trevor/agent-host test -- turn-policy turn-budget turn-termination loop compaction-controller
pnpm -w typecheck
pnpm -w lint   # biome
```

---

## Decisions

Canonical decisions are in `.plans/03.1-context-pressure-synthesis/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.claude/skills/planner/scripts/plan-db.ts query-decisions --plan "03.1-context-pressure-synthesis"
```

<!-- D-001 --> Two coupled fixes shipped together (step-0 seed + synthesize empty-retry).
<!-- D-002 --> Seed source = carry-forward of prior turn's measured usage from CompactionController.
<!-- D-003 --> Pre-baseline the progress guard from the seed.
<!-- D-004 --> Share one empty-retry budget; factor splice-and-retry into a shared helper.
<!-- D-005 --> Fix #1 is a compaction backstop, not a replacement.

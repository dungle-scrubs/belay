# 03.1 - Context-Pressure Synthesis Fixes - RFC

## 0. Hard Dependencies

None. This is a self-contained fix in the agent turn loop (`apps/agent-host/src/agent`)
plus a small seam through `turn.ts` / `main.ts`. It does not depend on any other numbered plan.

## 1. Problem

A turn that crosses the context-pressure fraction is supposed to stop opening tools and
produce one final answer ("synthesize"). In practice, at high context the user sees the
warning "Context pressure reached N%; synthesizing before opening more tools." but **no
synthesized answer appears**, and pressing **continue** **opens another tool round** instead
of synthesizing - looping back to the same warning. Two independent defects combine to
produce "forever Working / nothing synthesized."

### Defect A - the gate is blind at the start of every turn

The context-pressure gate keys off the **previous** model step's reported usage:

- `apps/agent-host/src/agent/loop.ts:428-429` - `lastInputTokens` and `lastContextWindow`
  are constructed fresh at `0` for each `runAgent` invocation (one per turn).
- `apps/agent-host/src/agent/turn-policy.ts:81-82` - `overContext` requires
  `contextWindow > 0`, so with the trackers at `0` it is always `false` at step 0.
- `apps/agent-host/src/agent/loop.ts:605-608` - the loop comment states it: *"At step 0
  both are clear (no prior usage), so the first round always runs."*

Consequence: a fresh turn (every **continue**) is structurally forced to open at least one
tool round before the gate can evaluate. Only after that round reports usage (~88%) does
step 1's gate fire `context_pressure`. At high context, that mandatory extra round can push
context even higher or overflow before any synthesis is attempted.

This usually does not bite because the between-turn compaction governor
(`COMPACT_WHEN = 0.8`, "blocking-before") keeps turns from *starting* over 0.8 by folding
down to `COMPACT_TO = 0.5`. It bites precisely when compaction **floors out** - a
tool-result-heavy history whose un-foldable tail is already large (the observed case: a
398-card audit). The turn legitimately starts at/above 0.8 and the blind step-0 gate cannot
react.

### Defect B - the synthesis path has no empty-answer recovery

When the gate does fire, the loop calls `synthesize()`
(`apps/agent-host/src/agent/loop.ts:564-598`):

- pushes a "do not call any more tools, answer now" user message on top of the already-full
  conversation,
- re-streams the model with **zero tools** and the **cheapest reasoning level**,
- **filters out** any `tool_call` the model emits (`Option.none`),
- if the accumulated text is blank, emits `{type:"empty"}` and renders nothing.

The normal step path has empty-answer recovery: on a blank answer it splices history down to
just the current task and retries once (`apps/agent-host/src/agent/loop.ts:787-797`).
`synthesize()` has **no** such retry, yet it is the path most likely to come back blank (full
context, cheapest reasoning, a local model that often emits only a dropped tool call when
told "don't call tools"). So a forced final answer at high context silently produces nothing.

### Why the two are coupled

Defect A makes high-context **continue** open a doomed tool round instead of synthesizing.
Defect B makes the eventual synthesis come back empty. Fixing only A would make the turn
synthesize immediately - but still possibly blank. Fixing only B would still waste a
mandatory tool round each **continue**. Together they close the loop: **continue** at high
context synthesizes immediately (A) and that synthesis actually produces text (B).

## 2. Goals

- A turn whose **inherited** context is already over the fraction synthesizes at step 0
  instead of opening one mandatory tool round.
- A forced synthesis that comes back blank retries once (same recovery the normal path has)
  before surfacing `empty`.
- No regression for the common case (turn starts under the fraction): step 0 still runs the
  first tool round exactly as today.
- First turn of a session (no prior usage) behaves exactly as today.

## 3. Non-Goals

- Changing the `contextBudgetFraction` (0.8) or the compaction thresholds.
- Changing compaction itself, the handoff flow, or overflow recovery.
- Adding a context window to the `Provider` interface (rejected seam - see Decisions).
- Re-estimating context from history chars (rejected seam - see Decisions).
- Any UI change.

## 4. Design

### Fix #1 - seed the gate from the prior turn's measured usage (carry-forward)

The host already holds the live "context after the last turn" in the `CompactionController`
(`apps/agent-host/src/agent/compaction-controller.ts`): `lastInputValue` / `lastWindowValue`,
updated on `assistant.progress` (`noteUsage`), `assistant.completed` (`noteTurnCompleted`),
and after a fold (`noteCompacted`) - see `main.ts:1828/1850/1871`. These are **real measured
numbers** (the same ones the ctx meter renders), not estimates.

Plumb them into the turn as an optional seed:

1. `CompactionController` exposes a read accessor, e.g.
   `usageSeed(): { input: number; contextWindow: number } | undefined`, returning the captured
   values when `lastWindowValue > 0`, else `undefined`.
2. `main.ts` turn kickoff (`main.ts:494`) reads `compactionController.usageSeed()` and passes
   it as a new `seedUsage` option to `publishTurn`.
3. `publishTurn` (`turn.ts:36`) forwards `seedUsage` into `runAgent` via `RunAgentOptions`.
4. `runAgent` (`loop.ts:381`) seeds `lastInputTokens` / `lastContextWindow` from
   `opts.seedUsage` (defaulting to `0` when absent - preserves first-turn behavior). It also
   pre-baselines the progress guard: set `checkpointInputTokens = seed.input` and
   `checkpointBaselined = true` so the guard measures growth from turn start, and the first
   real usage event does not re-baseline.

With the seed in place, the existing gate logic needs no change: at step 0,
`overContext = inputTokens >= 0.8 * contextWindow` is now evaluable from the seed, so a turn
inheriting >= 0.8 context emits `context_pressure` / `synthesized` immediately and routes into
`synthesize()` instead of opening a tool round.

Rejected seams (see Decisions D-002): adding `Provider.contextWindow` (touches every adapter)
and estimating from history chars (`estimateTokens`, rough `chars/4`). Carry-forward uses real
numbers and changes no provider adapter.

### Fix #2 - give `synthesize()` the same empty-answer recovery

Mirror the normal path's recovery (`loop.ts:787-797`) inside the forced-answer path: when the
synthesized answer is blank and the shared empty-retry budget is unspent, splice the
conversation down to the current task, re-push the "answer now, no tools" instruction, and
re-stream once at the cheapest reasoning. If it is still blank, emit `{type:"empty"}` as today.

The normal-path empty recovery and the synthesis recovery are the same operation
(splice-to-current-task + retry-once, sharing the single `emptyRetried` budget so a turn never
double-retries). Factor it into one shared helper used by both call sites rather than copying
the splice logic - this is a deepening opportunity, since `synthesize()` currently lacks the
recovery the normal path already implements.

## 5. Interaction with compaction (important)

`COMPACT_WHEN` (0.8) equals the gate's `contextBudgetFraction` (0.8). The "blocking-before"
governor is supposed to keep a turn from starting over 0.8. Fix #1 does **not** replace
compaction; it is the **backstop** for when compaction cannot get under `COMPACT_WHEN` before
the turn starts (`floorReached`, or a foldable region too small relative to a large un-foldable
tail). In the normal case compaction folds first and the seeded gate never fires.

Failure mode to accept, not prevent: if inherited context is *persistently* over the fraction
and compaction has floored, every **continue** will synthesize immediately and make no tool
progress. That is the correct signal (the session is too full for tool work); the synthesized
answer plus the existing context-pressure UX should steer the user to compact / hand off /
start fresh. Fix #2 is what makes that backstop answer non-empty and therefore useful.

## 6. Observability

- The `context_pressure` stop already carries `pressure` and the `context` block (input,
  window, pressure) into the `TurnStop`; a step-0 synthesize emits the same stop, so the
  existing UI warning and `turn-stop-metrics` cover it with no new event.
- The existing `debug("agent", "turn-budget", { ... })` breadcrumb (`loop.ts:613-630`) already
  logs `pressure`, `contextWindow`, and step. Seeding makes step 0's breadcrumb meaningful
  (non-zero `contextWindow` at step 0); confirm the seeded values appear there for postmortem.
- The empty-retry in `synthesize()` should be observable the same way the normal-path retry is
  (it currently retries silently via `step(n)`); keep parity - no new surface required, but the
  `empty` terminal event must still fire when the retry also fails.

## 7. Test Strategy

Pure-gate and loop-level tests already exist (`turn-policy.test.ts`, `loop.test.ts`,
`turn-budget.test.ts`, `turn-termination.test.ts`). New coverage:

- Gate/loop: a `runAgent` seeded over the fraction emits `context_pressure` and routes to
  `synthesize()` at **step 0** (no tool round opened first).
- Gate/loop: a `runAgent` seeded under the fraction runs the first tool round exactly as today
  (no regression).
- Loop: `runAgent` with no seed (first turn) behaves as today.
- Synthesize: a blank first synthesis triggers exactly one splice-and-retry; a non-blank retry
  is surfaced as the answer; a still-blank retry surfaces `empty`; the empty-retry budget is
  shared with the normal path (never double-retries in one turn).
- Controller: `usageSeed()` returns the captured usage after `noteTurnCompleted` /
  `noteUsage` / `noteCompacted`, and `undefined` before any usage.

## 8. Decisions

Canonical decisions live in the plan database. Key ones:

- D-001: Two coupled fixes (step-0 seed + synthesize empty-retry), shipped together.
- D-002: Seed source = carry-forward of the prior turn's measured usage from
  `CompactionController`; reject the `Provider.contextWindow` field and the history-chars
  estimate.
- D-003: Pre-baseline the progress guard from the seed (`checkpointInputTokens = seed.input`,
  `checkpointBaselined = true`).
- D-004: Share one `emptyRetried` budget across the normal path and `synthesize()`; factor the
  splice-and-retry into a shared helper.
- D-005: Fix #1 is a compaction backstop, not a replacement; persistent over-fraction
  inheritance correctly yields immediate synthesis.

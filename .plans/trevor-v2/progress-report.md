# Trevor V2 - Progress Report

> Canonical source of truth for what is done and what remains in the **active
> implementation cutoff**. Update this file as features are implemented - never
> mark a milestone complete until every current-cutoff checkbox under it is
> checked.

> **Scope.** This report tracks the near-term cutoff: **Phase 1 - concurrent
> read-only tool execution** (D-050, the active cutoff) and **Phase 2 - graceful
> turn-budget termination** (D-051…D-053, decomposed and queued next). The plan's
> already-shipped work is recorded in implementation.md §5; later roadmap items
> (cross-turn compaction D-040, subagents D-045, session recall D-044, …) stay
> sequenced in §6 and are decomposed into this report when they are picked up, so
> they do not count as current-cutoff blockers before then. Phase 2 is a
> self-contained correctness fix independent of Phase 1; promote it ahead if the
> silent turn-budget dead-ends bite before the perf work lands.

> Current focus: Phase 1 - Concurrent read-only tool execution
> Queued next: Phase 2 - Graceful turn-budget termination

## Phase 1: Concurrent read-only tool execution

Run a turn's read-only tool calls concurrently (bounded) while keeping mutating
tools as serial barriers, with results committed to history in call order.
Source: `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/tools/` (D-050).

### M1: Tool purity declaration
Source: `apps/agent-host/src/tools/types.ts`, `apps/agent-host/src/tools/index.ts`

- [ ] `Tool` interface gains an optional `readOnly?: boolean`, documented as defaulting to false (serial barrier)
- [ ] `read`, `glob`, `grep`, `web_search` declare `readOnly: true`
- [ ] `edit`, `write`, `multi_edit`, `bash` and the dynamic `process`/`task`/`skill` tools leave `readOnly` unset (stay barriers)
- [ ] `tools/index.ts` exports `READ_ONLY_TOOLS`, derived by filtering `TOOLS` on the `readOnly` flag (no hardcoded list)
- [ ] Unit test: a tool without the `readOnly` flag is absent from `READ_ONLY_TOOLS`

### M2: Concurrent dispatch in the agent loop
Source: `apps/agent-host/src/agent/loop.ts`

- [ ] `TOOL_CONCURRENCY` bound defined as loop policy
- [ ] The step's tool batch is partitioned into ordered segments: maximal read-only runs vs single mutating barriers
- [ ] A read-only segment executes concurrently via `Stream.mergeAll` bounded by `TOOL_CONCURRENCY`
- [ ] A mutating call executes alone as a barrier, in emission order relative to the reads around it
- [ ] `tool_start` and `tool_end` events are still emitted for every call
- [ ] Each result is captured into an index-keyed slot array (not pushed to the conversation on completion)
- [ ] Slots are committed to `conversation` in CALL order after the whole batch drains
- [ ] `step(n+1)` is concatenated after the commit, so the next model step reads a fully-committed conversation

### M3: Invariants preserved (verification)
Source: `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/agent/recovery.ts`

- [ ] Test: two `edit` calls to the same path in one batch apply sequentially with no lost update
- [ ] Concurrent reads in one batch overlap (observed latency below the serial sum)
- [ ] Cancellation mid-batch interrupts in-flight read children with no stream leak (A-004 still holds)
- [ ] Test: `trimLargestToolResult` recovery operates on a deterministic, call-ordered conversation
- [ ] Test: the same tool batch yields the same committed conversation regardless of completion order

### M4: Web wire-order tolerance
Source: `apps/web/src/components/chat/message.tsx`

- [ ] Verify the web renders correctly when `tool_start`/`tool_end` arrive out of call order (results keyed by `call.id`)
- [ ] If out-of-order rendering misbehaves, hoist read-group `tool_start` emissions ahead of the merged executes

## Phase 2: Graceful turn-budget termination

A long turn must never end silently at the step budget. The budget exit becomes
observable, forces a final answer instead of a tool-result stub, and is re-based
on context-window pressure rather than a fixed step count. Source:
`apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/turn.ts`,
`packages/session/` event schema, `apps/web` transcript (D-051…D-053). Motivated
by the 2026-06-24 local-4-bit/64k case: five consecutive turns died at exactly
`MAX_STEPS = 8` with the window at 16-18%, ending on a tool result with no answer
and no signal.

### M1: Observable budget exhaustion
Source: `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/turn.ts`, `packages/session/src/event.ts` (D-051)

- [x] `AgentEvent` gains a terminal `{ type: "step_limit"; steps: number }` variant
- [x] The `n >= MAX_STEPS` branch emits `step_limit` instead of returning `Stream.empty`
- [x] `turn.ts` maps `step_limit` to a `stepLimit` reason on the terminal `assistant.completed` (never a bare `complete({})`)
- [x] The `assistant.completed` event carries the `stepLimit` flag in the shared `@trevor/session` schema and the web decodes it
- [x] Unit test: a turn that hits the cap emits exactly one `step_limit` and a flagged completion, not a clean success

### M2: Forced final synthesis
Source: `apps/agent-host/src/agent/loop.ts` (D-052)

- [x] At the budget, run one model step with tools removed (`provider.stream(conversation, [], reasoning)`) instead of ending
- [x] A transient "tool budget reached - answer now" nudge is pushed into the loop's `conversation` only (never emitted or persisted)
- [x] Synthesis reasoning forced off/low; the step is bounded to exactly one (no recursion, independent of `MAX_STEPS`)
- [x] Synthesis output streams as ordinary `text` AgentEvents → `assistant.delta`
- [x] An empty synthesis falls through to the existing `empty`→`noReply` path
- [x] Unit test: a capped turn yields a non-empty final answer, and the nudge never appears in the persisted history projection

### M3: Context-pressure budget
Source: `apps/agent-host/src/agent/loop.ts` (D-053)

- [x] The loop captures the latest step's `usage.input`/`usage.contextWindow` into its closure (as it already does `overflowReason`)
- [x] `CONTEXT_BUDGET_FRACTION` (~0.80) defined as loop policy
- [x] The next tool round proceeds only while `usage.input < fraction * contextWindow`; otherwise → M2 synthesis
- [x] `MAX_STEPS` raised to a high runaway backstop (~30-40), documented as a backstop, not the governor
- [x] Fallback to `MAX_STEPS`-only when `contextWindow` is 0 / unknown
- [x] Unit test: under a small loaded window the turn stops at the context gate (not at a fixed count); under a large window it runs more rounds

### M4: Surfacing + reproduction (verification)
Source: `apps/web` transcript/panel, `apps/agent-host/src/commands.ts` (`/doctor`)

- [x] The web renders a "stopped after N steps" marker for a `stepLimit` completion, distinct from a normal answer and from `noReply`
- [ ] Host state / `/doctor` reports the turn termination reason (answered | step_limit | overflow | noReply | cancelled)
- [x] Manual repro: the previously-failing turns now end with an answer - deepseek (was 191-char cut-off → 4316), glm (was 299 → 3069), qwen4bit (was empty → 2701); none hit the cap now that MAX_STEPS is a backstop

## Summary
- Phase 1 (concurrent reads): 20 features, 0 completed, 20 remaining
- Phase 2 (turn-budget termination): 20 features, 19 completed, 1 remaining
- Total features: 40
- Completed: 19
- Remaining: 21
- Current cutoff blockers: 21 (Phase 1 + Phase 2 M4 /doctor)
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

> Phase 2 shipped 2026-06-25 ahead of Phase 1 (its silent turn-budget dead-ends were biting:
> deepseek/glm cut off mid-answer, qwen4bit returning empty). Phase 1 (concurrent reads) is
> now the remaining cutoff work.

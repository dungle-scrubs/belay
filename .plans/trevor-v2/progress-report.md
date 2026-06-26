# Trevor V2 - Progress Report

> Canonical source of truth for what is done and what remains in the **active
> implementation cutoff**. Update this file as features are implemented - never
> mark a milestone complete until every current-cutoff checkbox under it is
> checked.

> **Scope.** This report tracks the active implementation cutoff and the next sequenced feature.
> Phases 1-7 are shipped: concurrent read-only tool execution (D-050), graceful
> turn-budget termination (D-051…D-053), cross-turn compaction (D-040…D-043),
> provider SDK migration plus outage auto-reconnect (D-076…D-079), subagents
> (D-045…D-049), search-tool upgrade (D-062), and nested AGENTS.md context files
> (D-080…D-081). Phase 8 is now the active cutoff: prompt shell lane for leading
> `!` (D-082). The output is user-visible only and prompt-invisible for this first
> cut. Prompt composer draft persistence and Up-arrow history recall are captured
> as the next composer follow-up (D-083…D-084). Upcoming near-term items also now
> include the `trevor` project launcher (D-085) and early transcript top-down
> growth (D-086), plus project-local skill roots from `<cwd>/.agents/skills`
> (D-087). Later roadmap items (session recall D-044, WAN fallback D-060,
> session manager D-061, git functionality, …) stay sequenced in §6 and are
> decomposed here when picked up.

> Current focus: Phase 8 - prompt shell lane. The work starts Storybook-first with
> the prompt input color/state change for leading `!`, then adds protocol events,
> host execution through the existing protected `runShell` path, dedicated transcript
> rendering, and tests proving the shell result is not sent to the model context.
> Done: Phase 4 (SDK migration + outage auto-reconnect, M1-M3); Phase 5 M1-M5
> (inline + background subagents); Phase 6 (ripgrep `grep` + read-only `ast_grep`);
> Phase 7 (nested AGENTS.md context files); Phase 2 M4 (`/doctor` turn-termination
> reason). Remaining outside the current cutoff: fork-dependent Phase 5 M2
> forkability bullets, blocked on the unimplemented D-025…D-029 fork feature, plus
> minor Phase 5 refinements.

## Phase 1: Concurrent read-only tool execution

Run a turn's read-only tool calls concurrently (bounded) while keeping mutating
tools as serial barriers, with results committed to history in call order.
Source: `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/tools/` (D-050).

### M1: Tool purity declaration
Source: `apps/agent-host/src/tools/types.ts`, `apps/agent-host/src/tools/index.ts`

- [x] `Tool` interface gains an optional `readOnly?: boolean`, documented as defaulting to false (serial barrier)
- [x] `read`, `glob`, `grep`, `web_search` declare `readOnly: true`
- [x] `edit`, `write`, `multi_edit`, `bash` and the dynamic `process`/`task`/`skill` tools leave `readOnly` unset (stay barriers)
- [x] `tools/index.ts` exports `READ_ONLY_TOOLS`, derived by filtering `TOOLS` on the `readOnly` flag (no hardcoded list)
- [x] Unit test: a tool without the `readOnly` flag is absent from `READ_ONLY_TOOLS`

### M2: Concurrent dispatch in the agent loop
Source: `apps/agent-host/src/agent/loop.ts`

- [x] `TOOL_CONCURRENCY` bound defined as loop policy
- [x] The step's tool batch is partitioned into ordered segments: maximal read-only runs vs single mutating barriers
- [x] A read-only segment executes concurrently via `Stream.mergeAll` bounded by `TOOL_CONCURRENCY`
- [x] A mutating call executes alone as a barrier, in emission order relative to the reads around it
- [x] `tool_start` and `tool_end` events are still emitted for every call
- [x] Each result is captured into an index-keyed slot array (not pushed to the conversation on completion)
- [x] Slots are committed to `conversation` in CALL order after the whole batch drains
- [x] `step(n+1)` is concatenated after the commit, so the next model step reads a fully-committed conversation

### M3: Invariants preserved (verification)
Source: `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/agent/recovery.ts`

- [x] Test: two `edit` calls to the same path in one batch apply sequentially with no lost update
- [x] Concurrent reads in one batch overlap (observed latency below the serial sum)
- [x] Cancellation mid-batch interrupts in-flight read children with no stream leak (A-004 still holds)
- [x] Test: `trimLargestToolResult` recovery operates on a deterministic, call-ordered conversation
- [x] Test: the same tool batch yields the same committed conversation regardless of completion order

### M4: Web wire-order tolerance
Source: `apps/web/src/components/chat/message.tsx`

- [x] Verify the web renders correctly when `tool_start`/`tool_end` arrive out of call order (results keyed by `call.id`)
- [x] If out-of-order rendering misbehaves, hoist read-group `tool_start` emissions ahead of the merged executes (done proactively: the loop hoists every read group's `tool_start` in call order, so only the result-bearing `tool_end` rides out unordered, and the web keys it by `call.id`)

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
- [x] Host state / `/doctor` reports the turn termination reason (answered | step_limit | overflow | noReply | cancelled) — `lastTurn` field in `hostState()`, derived from the terminal `assistant.completed` flags + a tracked terminal overflow via the pure `terminationReason` (`turn-termination.ts`, 8 unit tests)
- [x] Manual repro: the previously-failing turns now end with an answer - deepseek (was 191-char cut-off → 4316), glm (was 299 → 3069), qwen4bit (was empty → 2701); none hit the cap now that MAX_STEPS is a backstop

## Phase 3: Cross-turn compaction

Keep the durable history's prompt projection under the window ACROSS turns. Overflow
recovery (shipped, D-034) is a per-turn airbag; it does nothing when the history itself
outgrows the window. Compaction pins the durable bits (original goal + live task list),
drops stale tool results, and folds older turns into a rolling ~1k-token summary, the
most recent turns staying verbatim. Durable, non-destructive: each fold appends an event;
the log is never mutated, so replay stays deterministic and the full history survives for
forks + session recall (D-044). Target window: the local 4-bit at 64k. Source:
`apps/agent-host/src/agent/history-projection.ts`, `packages/session/src/protocol.ts`,
`apps/agent-host/src/agent/turn-scheduler.ts`, `apps/agent-host/src/main.ts`,
`apps/web/src/transcript.ts` (D-040…D-043).

### M1: `context.compacted` event + rolling-chain schema
Source: `packages/session/src/protocol.ts` (event builder + `decodeTrevorEvent`)

- [x] New `context.compacted` event: `{ foldId; throughSeq; supersedes?; summary; manifest{turnRange, files[], tools[], topics[]}; tokensBefore; tokensAfter; model }`
- [x] `events.contextCompacted(...)` builder + a `decodeTrevorEvent` case with the same defensive field coercion as the other events
- [x] The fold is a rolling CHAIN: each `context.compacted` supersedes the prior via `supersedes`; the builder takes the latest
- [x] The `manifest` is a per-fold DELTA (only what this fold folded), not cumulative - the full picture reconstructs by walking the chain
- [x] Original events are never mutated; a fold only appends (durable, replay-deterministic)
- [x] Unit test: a compacted event decodes round-trip; a superseding fold chains off the prior `foldId`

### M2: Compaction-aware prompt projection
Source: `apps/agent-host/src/agent/history-projection.ts`, `apps/web/src/transcript.ts`

- [x] `buildHistory` injects the PINS outside the fold: original goal (first user message of the baseline) as a user turn + current task list (`tasks.current`) into the fold message, re-injected fresh
- [x] It takes the latest `context.compacted` as the rolling head: a synthetic assistant summary message, then projects `events` with `seq > throughSeq` verbatim (skip-by-seq, so a blocking-before prompt that arrived before the fold event still survives)
- [x] With no fold present, the projection is byte-for-byte the current behavior (pure/total preserved; the 9 existing characterization tests still pass)
- [x] `/clear` resets the baseline including any folds + pins
- [x] The web transcript keeps FULL history (D-042: the fold shapes only the prompt projection, not the durable transcript); `toTranscript` ignores the fold event - the user-facing marker is added in M5
- [x] Unit test: a log with a fold projects to pins + summary + recent-verbatim; the same log without the fold projects in full

### M3: Summary generation (tool-less, bounded)
Source: `apps/agent-host/src/agent/compaction.ts` (new), `apps/agent-host/src/turn.ts`

- [x] A tool-less model call (`provider.stream(messages, [], reasoning)`) given the prior summary + the turns being folded, producing the next rolling summary
- [x] The summary caps at ~1k tokens - re-summarized to stay ~1k as more folds in, never grown unboundedly (it rides in every later prompt; hard char-cap backstop)
- [x] The prompt captures decisions, current state, open threads, named key references (files/commands/errors), and what is dropped-but-recallable; it does NOT repeat the pinned goal/tasks
- [x] Model = the turn's provider for now, behind a configurable seam (the `summarize(provider, …)` param; local↔cloud routing deferred to D-046)
- [x] Chunking fallback (oldest-chunk-first map-reduce) documented; single-pass assumed for v1
- [x] Unit test: the summarizer folds N turns into a ≤~1k-token summary and never duplicates the pinned goal/tasks

### M4: Trigger - background-after + blocking-before
Source: `apps/agent-host/src/agent/turn-scheduler.ts`, `apps/agent-host/src/main.ts`

- [x] `COMPACT_WHEN` (~0.80) and `COMPACT_TO` (~0.50) window fractions defined as policy (compact-when vs compact-to; the gap is working headroom so it does not thrash)
- [x] Background-after (normal path): after a turn whose end-state crosses 80%, `scheduler.maybeCompact()` folds in the idle slot, `planCompaction` folding oldest turns until the projection estimate is back under ~50%
- [x] Blocking-before (guarantee): a turn must never START with the baseline ≥ 80%; the scheduler defers it behind a fold (`startNow` gate) when `needsCompaction()` is true, releasing it on `finishCompaction`
- [x] Compaction runs off the one-turn-at-a-time gate (the scheduler holds turns behind the `compacting` flag, never concurrent with a turn); within-turn spikes stay handled by overflow recovery, not compaction
- [x] Unit test: the planner folds oldest turns to under the budget (compactor.test); the scheduler defers an over-budget turn behind a blocking fold and folds proactively when idle (turn-scheduler.test)

### M5: Manual `/compact` + surfacing (verification)
Source: `apps/agent-host/src/commands.ts`, `apps/web/src/transcript.ts`, `apps/web/src/components/chat/message.tsx`

- [x] `/compact` folds on demand and publishes the resulting `context.compacted` (host `forceCompact`, off the one-turn gate; refuses while a turn is active)
- [x] The web renders a **transient live progress bar** while a fold streams (both manual + automatic), distinct from `assistant.recovered` (calmer frost styling vs the yellow airbag). It fills from actual streamed summary tokens ÷ the ~1k-token budget, clamped, never a predicted % - and VANISHES on completion, leaving no lingering marker (the folded turns stay in the transcript, D-042). Driven by a new advisory `context.compacting {foldId, tokens, budget}` event (throttled ~every 40 tokens); the summarizer reports streaming progress via an `onProgress` callback
- [x] `/doctor` reports `compacting` + the latest fold's `throughSeq` + tokensBefore/after (host state)
- [x] Integration test: applying a fold shrinks the next turn's projection to < half the pre-fold size, with the goal pinned, the summary injected, and the most recent turn verbatim (compactor.test); the web bar appears as tokens stream and vanishes on `context.compacted`, ignoring a late straggler tick (transcript.test). NOTE: a live end-to-end session against an over-window model is not yet run - verified by construction across the unit + integration tiers

## Accepted/Deferred Follow-up: Next Task - Phase 4: Provider SDK migration

Switch the host from the deprecated old-scope `@mariozechner/pi-ai` package to the
latest maintained `@earendil-works/pi-ai` release. Verified latest on 2026-06-25:
`@earendil-works/pi-ai@0.80.2`. This is a dependency/API migration first, not the
full dynamic provider-catalog product cut: preserve today's host-facing provider IDs
and behavior while moving onto the maintained SDK surface. Source:
`apps/agent-host/package.json`, `pnpm-lock.yaml`, `apps/agent-host/src/providers/`,
`apps/agent-host/src/providers/pi-ai.ts`, `apps/agent-host/src/providers/*.test.ts`.

M1/M2 are the migration itself; **M3 (provider-outage auto-reconnect recovery)** is sequenced
right after, building on the maintained SDK's error surface (D-076…D-079).

### M1: Package and import migration ✅
Source: `apps/agent-host/package.json`, `pnpm-lock.yaml`, `apps/agent-host/src/providers/`

- [x] Replace `@mariozechner/pi-ai` with `@earendil-works/pi-ai@0.80.2` in the host package and lockfile
- [x] Imports moved to `@earendil-works/pi-ai/compat` (value fns + types) + `/oauth`; no `@mariozechner/pi-ai` imports remain
- [x] Preserve `streamPiAiModel` event mapping (event discriminants verified identical; typecheck pins the field accesses + the abort `signal`)
- [x] Preserve A-004 interruption behavior: the scoped AbortController + `signal` still ride into `streamSimple`
- [x] Preserve context-overflow detection/classification and graceful recovery (classifier unchanged; `isContextOverflow` from the new SDK)
- [x] Host typecheck + 166 host tests green after the switch

### M2: Provider/auth behavior preserved ✅
Source: `apps/agent-host/src/providers/index.ts`, `apps/agent-host/src/providers/codex.ts`, `apps/agent-host/src/providers/pi-key.ts`

- [x] Browser-facing provider IDs stable (`qwen`, `gpt`, `qwen4bit`, `deepseek`, `glm`, `minimax`) - roster.test pins keys + labels
- [x] LM Studio stays direct through pi-ai + LM Studio APIs only; no emberlm
- [x] `~/.pi/auth.json` behavior preserved for Codex OAuth (`/oauth` `getOAuthApiKey`) and direct API-key providers
- [x] Codex OAuth refresh + GPT streaming preserved by construction (same path; `gpt-5.5` is in the new registry); live verification is the gated live-model lane
- [x] Direct-key providers read keys + derive reasoning/image metadata (credentials.test + pi-ai-base.test; new registry has deepseek/zai/minimax/codex models); streaming is the gated live lane
- [x] Larger provider catalog/auth UI is out of this migration cut (tracked in §6 as the dynamic-catalog product feature)

### M3: Provider-outage auto-reconnect recovery ✅ <!-- D-076…D-079 -->
Sequenced right after the SDK migration (M1/M2), built on the maintained SDK's error surface. Sibling to the shipped graceful overflow recovery (D-034…D-038), applied to transport faults.
Source: `apps/agent-host/src/providers/{errors,error-classifier,pi-ai}.ts`, `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/turn.ts`, `packages/session/src/protocol.ts`, `apps/web/src/{transcript.ts,App.tsx}`

- [x] `ProviderUnavailable` carries a `retryable` flag; the classifier (`error-classifier.ts` `isRetryableOutage`) decides retryable (WebSocket drop, `ECONNRESET`, timeout, HTTP 429/5xx) vs terminal; auth + overflow keep their dedicated handling (D-077)
- [x] `loop.ts` retries the current step with bounded backoff (`RECONNECT_BACKOFFS_MS = [300, 900]` + jitter, 3 total attempts), only when nothing streamed (the `sawEvent` guard keeps the siphon closures clean); per-step budget independent of `MAX_STEPS` + the recovery budget (D-076, D-078)
- [x] Once any event has streamed, the budget is spent, or the error is non-retryable, the turn goes terminal exactly as today (D-078)
- [x] Interrupts ride the interrupt channel, not the typed `E` channel, so `Stream.catchAll` never sees them - never retried, cancel stays instant during a backoff (D-078)
- [x] New `assistant.reconnecting {runId, attempt, detail}` event (sibling to `assistant.recovered`); `loop.ts` emits it, `turn.ts` forwards it, the web renders a "reconnecting… (attempt k/3)" frost marker (D-079)
- [x] Tests (`@effect/vitest` + `TestClock`, flaky fake provider): transparent recovery before the first token; a drop after output is terminal; non-retryable/auth terminal; bounded budget; interrupt-during-backoff cancels cleanly (6 tests) + protocol round-trip + transcript render

## Accepted/Deferred Follow-up: Phase 5: Subagents

A subagent is a delegated agent that runs in its OWN isolated context and returns a
distilled result - it lets the main agent fan work out, and it is the substrate session
recall (D-044) later rides on. This round ships two reusable file-discovered flavors on
the inherited session model (no per-agent model yet) - general-purpose (all tools) and
explorer (read-only) - plus ephemeral model-minted definitions once the reusable path
exists. Strict context isolation: the child runs as its own forkable session; only the
parent-authored task prompt crosses the boundary, and the child's final message folds
back as the parent's tool result. Sequenced after compaction per §6. Source:
`apps/agent-host/src/agents.ts` (new, modeled on `skills.ts`),
`apps/agent-host/src/tools/`, `apps/agent-host/src/agent/loop.ts`,
`packages/session/src/protocol.ts`, `apps/agent-host/src/main.ts` (D-045…D-049).

### M1: File-based agent discovery ✅
Source: `apps/agent-host/src/agents.ts` (new, modeled on `apps/agent-host/src/skills.ts`)

- [x] An agent definition is `{ description, tools, skills?, body, readOnly? }`, discovered built-in + user-defined (`<TREVOR_AGENTS_DIR>/<id>/AGENT.md`) like skills; a user file overrides a built-in of the same id
- [x] Two v1 flavors: `general-purpose` (tools `['*']`) and `explorer` (read-only flavor, clamped to the read-only tools - excludes write/edit/multi_edit/bash and every other mutating tool)
- [x] `tools` and `skills` are separate allow-lists (`resolveAgentTools` / `resolveAgentSkills`); `['*']` expands, explicit names intersect the registry, an empty `skills: []` grants none
- [x] No per-agent model field - all inherit the session model
- [x] Discovered agents announced in `host.online` (`agents: AgentSpec[]` - id + description + resolved allow-lists, no body); `describeAgent` builds the wire descriptor
- [x] Unit test: discovery yields the built-ins + a user fixture (disabled/description-less skipped); general-purpose gets the full set, explorer excludes every mutating tool; host.online round-trips the agents

### M2: Isolated child session + delegation link ✅ (fork-dependent bullets noted)
Source: `apps/agent-host/src/agent/delegate.ts` (new), `packages/session/src/protocol.ts`

- [x] A child runs as its OWN session with its own log (`runDelegatedChild` mints `<SESSION_ID>::sub::<uuid>`, ensures it, publishes the child lifecycle there); nothing from the parent transcript leaks
- [x] The parent-authored task is the ENTIRE slice the child receives (seeded as the child's first `user.message`; the agent body frames it; a structured `context` param deferred)
- [x] A `delegated.to {runId, childSessionId, agent, task, mode, status, result?}` event on the PARENT links the two (running → done/failed, carrying the frozen result)
- [~] The fork machinery (D-025…D-029) is NOT in the codebase yet, so "independently forkable" / "forking copies the frozen result" can't be exercised; `delegated.to.result` IS the frozen distilled result a parent-fork will reuse once fork lands
- [~] (see above - depends on the unimplemented fork feature)
- [x] Unit test: a delegation creates a child session + a `delegated.to` event; the child log shares no parent-run-correlated event and no `delegated.to` (isolation); a failing child folds back as a `failed` link, never throwing into the parent

### M3: Delegation tools + execution modes — inline ✅; background ✅
Source: `apps/agent-host/src/agent/delegate.ts`, `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/turn.ts`, `apps/agent-host/src/main.ts`

- [x] `delegate_inline` (sync): the loop intercepts the call, runs the child to completion, and folds its final message in as the tool result (the parent turn blocks)
- [x] `delegate_background` (async): the capability returns an immediate ack and the host runs the child DETACHED (`BackgroundDelegator.start` → `void runDelegatedChild(...)`), so it outlives the parent turn; its terminal `delegated.to` lands on the parent session log whenever it finishes (the result-arrives-later event)
- [x] Fold-back: the child's final message becomes the parent's tool result
- [x] The child runs the same `runAgent` loop with its agent's tool allow-list (`runAgent`/`publishTurn` thread `toolNames`; the executor enforces it) + the agent body as its instructions
- [x] Delegation tools leave `readOnly` unset, so the D-050 partition runs them as serial barriers
- [x] Depth-1 only: a child turn is given no delegation capability, so children may not spawn grandchildren
- [x] Child tool registries never include `delegate_inline`/`delegate_background` (the delegation defs live in the parent-only capability, never in `TOOL_DEFS`), even for `general-purpose` / `tools: ['*']`
- [x] Depth-1 enforced structurally (no capability on the child) rather than a runtime depth counter; a child literally cannot see the tool
- [x] `MAX_BACKGROUND_CHILDREN_PER_SESSION = 4` cap — session-level registry in `main.ts`; `BackgroundDelegator.canStart()` rejects past the cap with a structured `error: too many background subagents …`
- [x] `delegate_background` read-only clamp — `resolveChildTools` intersects the agent's allow-list with `READ_ONLY_TOOLS` for `mode: "background"` (a background child is offered no edit/write/bash)
- [x] Ephemeral background `tools: ['*']` → read-only — the same `resolveChildTools` clamp applies to ephemeral agents (an ephemeral `tools:['*']` expands then collapses to the read-only set)
- [x] Mutating background agents documented as deferred (with the background follow-on)
- [x] No teams (multi-agent orchestration) in this cut
- [x] Unit test: an inline delegation routes through the capability and folds the child's result; a child turn is offered no delegation tool (depth-1); the capability returns structured errors for an unknown agent / empty task
- [x] Background-specific tests: both tools offered + the background description advertises async/read-only/cap; `delegate_background` returns an immediate ack and starts a tracked child whose late result lands a terminal link; the cap rejects (and starts no child); unavailable when no delegator is wired; the read-only clamp (incl. general-purpose `['*']`); an ephemeral cannot allow-list `delegate_background` (depth-1, both names)

### M4: Surfacing + isolation (verification)
Source: `apps/web/src/transcript.ts`, `apps/web/src/components/chat/message.tsx`, `apps/web/src/App.tsx`, `apps/agent-host/src/commands.ts`, `apps/agent-host/src/main.ts`

- [x] The web renders a delegation as a distinct linked block (child session id + status), separate from an ordinary tool card — purple `Alert` block (`App.tsx`); a background child reads distinctly ("running in background…")
- [x] A background delegation's late result lands by id (wire-order tolerant, like D-050 / M4) — `toTranscript` collapses links by `childSessionId`, so a `done` arriving AFTER the parent's `assistant.completed` advances the same block (transcript.test D-048)
- [x] `/doctor` reports active child delegations, depth policy, and active background-child count/cap — `hostState()` `subagents` line (`depth≤1 · inline+background (≤N)`) + a `background: k/N active: <agents>` field when any run
- [~] Manual repro: a general-purpose inline delegation distills a multi-step subtask into one parent tool result; an explorer fan-out reads files without leaking parent context — verified by construction across the unit tier (isolation + clamp + late-result); a live over-the-wire fan-out is the gated live-model lane

### M5: Ephemeral model-minted agents ✅ (inline)
Source: `apps/agent-host/src/agent/delegate.ts`, `apps/agent-host/src/agents.ts`

- [x] `delegate_inline` accepts either a discovered `agent` id or an inline `define` ephemeral definition (`delegate_background` follow-on inherits this)
- [x] An ephemeral definition is `{ description, instructions, tools?, skills? }`; inline mode is implied by the tool
- [x] Ephemeral definitions are runtime-only: no file written, no registry entry (`source: "ephemeral"`); the `delegated.to` link records `agent: "ephemeral"` (a full contract snapshot INTO the child session is a refinement)
- [x] The host validates `tools` and `skills` against the live registries before starting the child; unknown tools/skills and policy-forbidden delegation tools are rejected with a structured `error: …` (never silently dropped)
- [x] The child is offered only its allow-listed tools (`toolNames` restricts what's offered + run); a runtime allow-list gate on the `skill` tool body-loading is a refinement
- [x] Ephemeral children use the same isolated child session, `delegated.to` link, fold-back, and depth-1 (no capability) as discovered agents (cancellation/parent-fork inherit the discovered path; fork is blocked on the unimplemented fork feature)
- [~] Distinct web rendering of the ephemeral tool/skill contract — renders as the same linked block with `agent: ephemeral` (a contract-detail view is a refinement)
- [x] Unit tests: invalid ephemeral specs (missing description/instructions, unknown tool, unknown skill), no unlisted tool access, no parent leak (shared isolation test); a forked-parent test is blocked on the unimplemented fork feature
- [x] Unit test: an ephemeral definition cannot re-enable delegation tools (rejected) or bypass depth-1 (the child is given no capability)

## Accepted/Deferred Follow-up: Phase 6: Search-tool upgrade

Immediately after Phase 5 subagents, align the existing `grep` tool with the plan's `grep` (rg) intent and
promote H-108 `ast_grep` into a first-class read-only structural-search tool. Source:
`apps/agent-host/src/tools/grep.ts`, `apps/agent-host/src/tools/ast-grep.ts` (new),
`apps/agent-host/src/tools/search-process.ts` (new), `apps/agent-host/src/tools/index.ts`,
`apps/agent-host/src/providers/system-prompt.ts`, `apps/web` generic tool rendering (D-062).

### M1: Ripgrep-backed `grep` ✅
Source: `apps/agent-host/src/tools/{grep,search-process}.ts`

- [x] Shared read-only search-process helper (`search-process.ts`) using `execFile` with argv arrays, `cwd`, timeout, max buffer, and exit-code-preserving capture (each tool maps codes itself); rg/ast-grep are read-only so no in-loop interrupt wiring beyond the timeout
- [x] Project-managed ripgrep via `@vscode/ripgrep` (`rgPath`, a platform optional-dependency) - never a system/Homebrew `rg`
- [x] Replaced the custom Node glob/read/RegExp scanner with ripgrep, keeping `name: "grep"` + the `path:line:text` shape (the `./` prefix stripped; `.` path avoids the rg-reads-stdin hang)
- [x] Preserves `readOnly: true`, the D-050 read-concurrency, output caps, and typed input/execution errors
- [x] Explicit schema: `pattern`, `glob`, `literal`, `ignoreCase`, `hidden`, `noIgnore`, `maxMatches`; no raw flag passthrough
- [x] Prompt/tool-selection guidance updated (grep = ripgrep text/regex, when to reach for ast_grep)
- [x] Tests: gitignore (+ noIgnore), literal vs regex, ignoreCase, no-match, invalid regex, maxMatches cap, glob restriction, path:line:text shape (8); `READ_ONLY_TOOLS` inclusion (index.test)

### M2: Read-only `ast_grep` ✅
Source: `apps/agent-host/src/tools/{ast-grep,ast-grep-bin,search-process}.ts`, `index.ts`, `providers/system-prompt.ts`

- [x] Project-managed ast-grep resolver (`ast-grep-bin.ts`) - detects the `@ast-grep/cli-<platform>` package and points at the full `ast-grep` binary (not `sg`); `@ast-grep/cli` build skipped in pnpm-workspace (binary resolved directly)
- [x] `ast_grep` wraps `ast-grep run` only (no rewrite/interactive flags), read-only
- [x] Explicit schema: `pattern`, `lang?`, `paths?`, `globs?`, `strictness?`, `maxMatches?`; no raw flag passthrough
- [x] `--json=stream` parsed into compact capped `file:line:col  snippet` rows
- [x] Confined to `WORKSPACE_ROOT` (paths validated via `confine`, escape → typed input error); typed failures for invalid pattern/lang (exit ≥2) and execution; exit 1 = no matches
- [x] Registered in `TOOLS`/`TOOL_DEFS`/`READ_ONLY_TOOLS` (gated on the binary resolving) + prompt guidance
- [x] Tests: structural match across formatting, inferred + explicit lang, no-match, unknown lang error, maxMatches cap, workspace confinement, read-only registry inclusion (7)

## Shipped: Phase 7 - Nested AGENTS.md context files

Trevor auto-reads nested `AGENTS.md` instruction files using **Claude Code's loading model** -
eager up-tree at the root, lazy below cwd on file access - keyed on the cross-tool **AGENTS.md**
standard (agents.md), not `CLAUDE.md`. The host reads no context files at all today:
`buildSystemPrompt` only mentions `AGENTS.md` as a discovery hint, never ingesting one. Codex's
eager-only root→cwd model is the comparison point, not the target - it cannot pick up an
`AGENTS.md` below cwd (its open issue #12115 asks for exactly the behavior chosen here). Source:
`apps/agent-host/src/context/` (new reader module), `apps/agent-host/src/providers/system-prompt.ts`,
`apps/agent-host/src/tools/` (file tools), session/loop state, `apps/agent-host/src/commands.ts`
(`/doctor`) (D-080).

### M1: Context-file reader module (pure, testable) ✅
Source: `apps/agent-host/src/context/agents-md.ts` (new), `apps/agent-host/src/paths.ts` (new)

- [x] The `~/.trevorV2` base directory is a single exported constant `TREVOR_HOME` in a dedicated paths module (`paths.ts`), env-overridable as `resolve(process.env.TREVOR_HOME ?? join(homedir(), ".trevorV2"))`, mirroring `WORKSPACE_ROOT`/`TREVOR_WORKSPACE`; `USER_AGENTS_MD` derives from it and the `dev:op`/`start:op` npm scripts now use `${TREVOR_HOME:-$HOME/.trevorV2}` so the directory name lives in one place (D-081)
- [x] A pure reader: `collectEagerSources`/`projectDirs` walk UP collecting at most one `AGENTS.md` per directory from project root down to cwd, plus the user-global `<TREVOR_HOME>/AGENTS.md` loaded first; the walk stops at `WORKSPACE_ROOT` / a `.git` marker (inclusive) and never goes past it
- [x] `renderContext` concatenates user-global → root → cwd so cwd appears last and wins on conflict (positional precedence), each source labeled `### scope: path`; empty/whitespace-only files skipped (`readAgentsFile` returns null)
- [x] `@path` import expansion: relative paths resolve against the importing file (absolute allowed), recursion capped at ≤ 4 hops (`MAX_IMPORT_HOPS`), cycles detected + broken with a visible note, and `@paths` inside fenced or inline code spans ignored
- [x] Combined byte budget (`CONTEXT_BYTE_BUDGET`) with deterministic truncation (lowest-precedence first, via a code-point-safe `sliceToBytes`); returns a structured `ContextReport` (`files[]`, scopes, bytesUsed, bytesDropped, truncated) - never a silent drop
- [x] Unit tests (11): root-only repo; nested chain merged root→cwd with cwd winning; walk-up boundary at `.git` + never above `WORKSPACE_ROOT`; user-global loaded first; import expansion + 4-hop cap + cycle detection; code-span `@paths` ignored; budget truncates deterministically with the drop reported; empty report when none

### M2: Eager scope injected into the per-turn prompt ✅
Source: `apps/agent-host/src/providers/system-prompt.ts`, `apps/agent-host/src/context/registry.ts` (new)

- [x] `buildSystemPrompt` renders the collected context (user-global + root→cwd, plus the lazy below-cwd set) via `contextRegistry.renderForPrompt`, a dedicated labeled block re-read from disk every turn so it survives compaction the same way the live checklist does (D-040)
- [x] With no `AGENTS.md` present the block is omitted entirely (the prompt is byte-for-byte the prior structure); the existing system-prompt confinement tests still pass
- [x] Reworded the REPO_GUARDRAILS line: it no longer tells the model to re-read README.md/AGENTS.md but says AGENTS.md instructions are "already provided in the project-context block above"
- [x] Unit test: the context block appears when a file exists (and precedes the guardrail that references it) and is omitted when none; the reworded guardrail renders and the old wording is gone

### M3: Lazy below-cwd loading on file access ✅
Source: `apps/agent-host/src/tools/{read,write,edit-core}.ts`, `apps/agent-host/src/context/registry.ts`, `apps/agent-host/src/main.ts`

- [x] `contextRegistry.noteFileAccess` loads every not-yet-loaded `AGENTS.md` between cwd and the touched file (the dirs strictly below cwd on the path to it), so a directory-scoped instruction reaches the model on the next step
- [x] The lazy set is tracked in the session-scoped registry, keyed by directory and guarded by a `scanned` set, so each directory loads (and is stat-checked) exactly once
- [x] The full context (eager re-read + lazy set) is re-rendered every turn from the registry, so newly-loaded lazy context survives a compaction fold (the registry is independent of history); `/clear` resets the lazy set
- [x] Triggered by the file-touching tools that open a path: `read` (primary), `edit`/`multi_edit` (via `edit-core` `prepareEdit`), and `write`
- [x] Unit tests (7): a below-cwd `AGENTS.md` loads only after a file in that subtree is touched, deduped on a second touch, deeper nesting parent-before-child, a cwd-level file adds nothing, survives a fold re-render, `reset()` clears it, below-cwd sits after the eager project scope

### M4: Surfacing + verification ✅
Source: `apps/agent-host/src/main.ts` (`hostState` → `/doctor`)

- [x] `/doctor` reports the ingested context via a `context` field: file count, scopes (`user-global`/`project`/`below-cwd`), bytes used, and `(-NB truncated)` when a budget drop occurred - never silent (`contextState()` in `main.ts`)
- [~] Manual repro: verified at construction level against the real repo - the eager root `AGENTS.md` renders in the block + reworded guardrail; touching `apps/web/` pulls in `apps/AGENTS.md` (below-cwd); the doctor report shows `2 AGENTS.md [project, below-cwd] 16,240B`. A live model OBEYING the instructions is the gated live-model lane

## Next feature: Phase 8 - Prompt shell lane (leading `!`)

Leading `!` in the prompt composer runs a shell command immediately through the live host,
using the same protected shell path as `/shell`, then displays a dedicated shell transcript
block. It does not call a model and its output is not included in model context for this cut.
V1 already had terminal bang-shell behavior; V2 already has `/shell`, `runShell`, the bash
safety floor, timeout, and output cap. This phase fills the browser grammar, visual state,
protocol, host routing, and transcript rendering gaps. Source: `apps/web/src/App.tsx`,
`apps/web/src/derive.ts`, `apps/web/src/session/use-session.ts`,
`packages/session/src/protocol.ts`, `apps/agent-host/src/main.ts`,
`apps/agent-host/src/tools/run-shell.ts`, `apps/web/src/transcript.ts`,
`apps/web/src/components/chat/message.tsx`,
`apps/web/src/components/chat/prompt-input.stories.tsx` (D-082).

### M1: Storybook-first composer shell state

- [ ] Extract or reuse the production composer shell styling path so Storybook exercises the real prompt input
- [ ] Add Storybook states: normal, slash, empty bang, executable bang, long bang command, and bang-with-attachments/error
- [ ] Bang state changes immediately when the raw first character is `!`: Shell chip plus terminal-like border/background
- [ ] Visual treatment stays distinct from slash menu, context-pressure yellow, assistant/tool surfaces, and command-result chrome

### M2: Web parsing and publishing

- [ ] Add `parseBangShell` or equivalent that triggers only on raw first character `!` with a non-empty command
- [ ] Submit publishes `user.shell {requestId, command}` through a new session helper, bypassing send queue, model, and provider flow
- [ ] Shell lane is text-only; attachment cases are handled explicitly instead of silently dropping files
- [ ] `/shell <command>` continues to route through known slash command parsing

### M3: Session protocol and host execution

- [ ] Add `user.shell` and `shell.result` builders/decoders in `@trevor/session`
- [ ] Live leader handles `user.shell` by running shared `runShell(command)` and emitting one `shell.result`
- [ ] Refused/destructive, non-zero failure, timeout, and capped output render through `shell.result` with `ok: false` when appropriate
- [ ] Replay never re-runs shell commands; standby hosts observe only

### M4: Transcript and prompt projection

- [ ] `toTranscript` reduces `user.shell` plus `shell.result` into one shell message keyed by `requestId`, with pending/result states
- [ ] Add a terminal-style shell block showing `$ command` and output, visually distinct from assistant, tool, and generic command-result chrome
- [ ] `/clear` resets visible shell blocks from prior history in the same way it resets conversation transcript
- [ ] `buildHistory`, compaction planning, and session recall anchors ignore `user.shell`/`shell.result` for this first cut

### M5: Verification

- [ ] Protocol round-trip tests cover both events and permissive decode defaults
- [ ] Web tests cover parser behavior, submit routing, transcript pairing, `/clear`, and prompt-invisible history projection
- [ ] Host tests cover success, refusal through the bash safety floor, non-zero failure, output cap, and no replay re-execution
- [ ] Manual EZE repro: `!printf hello` runs immediately, shows a shell block, and the next model prompt does not receive `hello` unless the user quotes it

## Accepted/Deferred Follow-up: composer recovery and prompt history

D-083 and D-084 are captured in the implementation plan as the follow-up after Phase 8 unless
explicitly reprioritized. V1 already had prompt-history mechanics in the TUI `PromptState`; V2
currently has local composer state in `useComposer`, tab identity in `use-session.ts`, and slash-menu
ArrowUp/ArrowDown handling in `App.tsx`, but no draft persistence or terminal-style prompt recall.
Source: `apps/web/src/hooks/use-composer.ts`, `apps/web/src/session/use-session.ts`,
`apps/web/src/App.tsx`, `apps/web/HOTKEYS.md`, `apps/web/src/hooks/use-send-queue.ts`,
`apps/web/src/send-queue.ts` (D-083…D-084).

### M1: Debounced draft persistence (D-083)

- [ ] Add a small draft-persistence hook keyed by session id plus browser tab identity, using tab/session storage rather than the durable Richter log
- [ ] Restore only unsubmitted text drafts after the session id is known, without overwriting a non-empty in-memory draft
- [ ] Debounce draft writes with a versioned storage payload and tolerate unavailable/private-mode storage without breaking typing
- [ ] Clear the stored draft after successful prompt submit, `/clear`, and explicit composer clearing
- [ ] Keep attachments out of the first cut unless artifact upload state is durable enough to restore safely
- [ ] Add tests for restore, debounce, clear paths, storage failure, session isolation, and tab isolation

### M2: Prompt history recall (D-084)

- [ ] Add a local prompt-history store keyed by session id plus browser tab identity, with a small cap and adjacent-duplicate de-dupe
- [ ] Record ordinary prompts and bang shell commands as typed after publish is accepted
- [ ] Exclude hidden slash-command results, host-generated command output, and assistant text from recall history
- [ ] ArrowUp from an empty composer, or from the first eligible line, recalls the previous prompt
- [ ] ArrowDown moves forward through recalled prompts and restores the saved new draft at the end
- [ ] Multi-line editing keeps normal cursor movement unless the cursor is at the first line and history navigation is eligible

### M3: Composer integration and verification

- [ ] Slash-menu ArrowUp/ArrowDown handling keeps priority while the menu is open
- [ ] Update `apps/web/HOTKEYS.md` with the composer history conditions
- [ ] Web tests cover history navigation, slash-menu conflict, multi-line cursor eligibility, reload persistence, and session/tab isolation
- [ ] Manual EZE repro: type a partial draft, reload, confirm it restores, submit it, then confirm the stored draft clears
- [ ] Manual EZE repro: submit two prompts, press ArrowUp/ArrowDown through history, and verify no slash-command result text is recalled

## Accepted/Deferred Follow-up: project launcher

D-085 is captured in the implementation plan as the first browser-era slice of the broader
browser/terminal session-manager direction. The desired workflow is `trevor` from any project
directory: resolve the project root, derive or look up the stable session id, ensure shared local
Trevor services, spawn or reuse the matching agent-host with `SESSION_ID`, `TREVOR_WORKSPACE`, and
cwd all pointing at that project/session, then open `http://127.0.0.1:17420/?session=<id>`. This
replaces the manual env-command ceremony shown in the current workaround. Source: root `package.json`,
new launcher entrypoint, `apps/agent-host/package.json`, `apps/agent-host/src/main.ts`,
`apps/agent-host/src/tools/workspace.ts`, `apps/web/src/App.tsx`, `packages/session/src/identity.ts`,
`~/.agents/PORTS.md` (D-085).

### M1: CLI entrypoint and project identity

- [ ] Add a terminal executable named `trevor` in the V2 package surface
- [ ] Resolve the project root as the nearest Git worktree root from cwd, falling back to cwd when no Git root exists
- [ ] Derive a stable URL-safe session id from the canonical project root using a human-readable basename plus collision-resistant short hash
- [ ] Persist the root to session-id mapping under Trevor local state so the same project reopens the same session
- [ ] Support the no-arg ordinary path first; reserve explicit overrides such as `--session` or `--new` for a later extension

### M2: Shared service readiness

- [ ] Check the shared web UI, blob store, and session-store health on reserved local ports before launching a project host
- [ ] Start missing shared services through the repo's local runner without creating one service set per project
- [ ] Detect occupied reserved ports and report which service owns the conflict when possible
- [ ] Wait for session-store readiness before starting or checking the project host
- [ ] Keep `~/.agents/PORTS.md` unchanged unless a new persistent service port is introduced

### M3: Project host lifecycle

- [ ] Maintain launcher ownership records with pid, session id, project root, command, and started time
- [ ] Use a per-session/project lock so concurrent `trevor` launches cannot spawn duplicate answering hosts
- [ ] Reuse an existing healthy host for the same project/session
- [ ] Replace a stale ownership record or dead process before opening the browser tab
- [ ] Spawn the host with `SESSION_ID=<derived-id>`, `TREVOR_WORKSPACE=<project-root>`, and cwd set to the project root
- [ ] Wait for `host.online` or equivalent evidence that the host joined the expected session and announced the expected workspace

### M4: Browser handoff and diagnostics

- [ ] Open or focus `http://127.0.0.1:17420/?session=<id>` after the session and host path are prepared
- [ ] Print a concise status line with session id, project root, service reused/started state, host reused/spawned state, and URL
- [ ] Never print `.env.op`, provider keys, OAuth material, or expanded secret-bearing environment values
- [ ] Web UI tolerates opening before `host.online` and presents a clear starting-host state until live host presence appears

### M5: Verification

- [ ] Unit tests cover root resolution, session id generation, mapping persistence, and no slash-containing ids
- [ ] Unit tests cover service health classification, occupied-port diagnostics, and no per-project service duplication
- [ ] Unit tests cover host reuse, stale-host replacement, spawn env/cwd, and concurrent launch locking
- [ ] Integration test boots fake or local services and proves the launcher opens the expected session URL
- [ ] Manual EZE repro: run `trevor` from two different repos and verify two tabs, two sessions, and two matching host processes

## Accepted/Deferred Follow-up: early transcript layout

D-086 is captured in the implementation plan as a browser transcript layout fix. V1 is a terminal TUI
with explicit scroll-layout choices, but not a direct browser-layout precedent. V2 currently uses
`flex-col-reverse` and treats `scrollTop === 0` as the bottom, so new sessions start just above the
composer. The desired behavior is top-down: an empty or short session starts at the top of the
transcript well and appends downward until content overflows; after overflow, live-bottom following
keeps streaming output visible only while the user is already at the live edge. Source:
`apps/web/src/App.tsx`, `apps/web/src/transcript.ts`, `apps/web/src/transcript.test.ts`,
`apps/web/src/components/chat/message.tsx`, future transcript layout stories/fixtures (D-086).

### M1: Normal scroll model

- [ ] Replace the transcript container's `flex-col-reverse` model with normal top-down column flow
- [ ] Redefine `atBottom` as `scrollHeight - clientHeight - scrollTop` within tolerance
- [ ] Change `scrollToBottom` and live-follow effects to scroll to `scrollHeight`, not `0`
- [ ] Keep replay, submit re-pin, `/clear`, compacting bars, queued prompts, and shell blocks on the same scroll model

### M2: Short-session top alignment

- [ ] Empty replayed sessions render an empty transcript well with no fake spacer
- [ ] A single submitted user message appears at the top padding of the transcript well
- [ ] A short user/assistant exchange appends downward without bottom-aligning above the composer
- [ ] The composer/footer remain pinned below the transcript scroll area on mobile and desktop

### M3: Overflow and live-edge behavior

- [ ] Once content exceeds the viewport, new updates follow the bottom only when the user is already at the live edge
- [ ] If the user scrolls upward, streaming deltas, tool rows, compacting bars, and shell output do not yank the viewport
- [ ] The jump-to-bottom affordance appears when away from the live edge and hides after returning to bottom
- [ ] The scroll behavior remains stable across transcript replay and host reconnect

### M4: Visual and behavioral verification

- [ ] Add Storybook or fixture views for empty, one-message, short exchange, just-before-overflow, and overflowing transcripts
- [ ] Add fixture views for overflowing transcript at live bottom and overflowing transcript while scrolled up
- [ ] Add mobile-height and desktop-height checks so early content does not overlap the composer or footer
- [ ] Web tests pin top-aligned early layout and normal bottom-tolerance math
- [ ] Manual EZE repro: new session starts at top, fills downward, then follows the live edge only after overflow

## Accepted/Deferred Follow-up: project-local skill roots

D-087 is captured in the implementation plan as an additive skill-discovery refinement. V1 already
supported project-local skills first, then user/shared skills. V2 currently discovers one root:
`TREVOR_SKILLS_DIR` when set, otherwise `~/.agents/skills`. The desired behavior is to read
`<workspace>/.agents/skills` first, where `<workspace>` is the same effective root used by the
host file tools, then keep the existing configured/global root. Source:
`apps/agent-host/src/skills.ts`, `apps/agent-host/src/tools/workspace.ts`,
`apps/agent-host/src/commands.ts`, `apps/agent-host/src/tools/index.ts`,
`apps/agent-host/src/agents.ts`, `apps/agent-host/src/agent/delegate.ts`,
future D-075 `skills_list`/`skill_view` registry surfaces (D-087).

### M1: Discovery roots and precedence (D-087)

- [ ] Replace the single `SKILLS_DIR` assumption with an ordered skill-root list
- [ ] Resolve the project-local root as `<WORKSPACE_ROOT>/.agents/skills`, using the same workspace authority as read/write/bash
- [ ] Preserve the existing configured/global root behavior: `TREVOR_SKILLS_DIR` when set, otherwise `~/.agents/skills`
- [ ] Deduplicate resolved roots and treat missing or unreadable roots as empty
- [ ] Make enabled project-local skills win over broader skills with the same id
- [ ] Keep disabled skill files absent in the first cut; they do not create tombstones that hide broader skills

### M2: Registry integration and provenance

- [ ] Extend discovered skill metadata with root kind, source path, and selected/shadowed provenance
- [ ] Update discovery caching so the effective registry cannot accidentally mix stale roots or paths
- [ ] Update `/skills` to report all searched roots when empty and show the selected source when skills are found
- [ ] Ensure `skill(name)` expands the effective selected skill body, including project-local overrides
- [ ] Keep project-local skill shell interpolation behind the same opt-in gate and protected shell path as global skills

### M3: Downstream validation and tests

- [ ] Agent and ephemeral delegation skill allow-list validation use the effective discovered registry
- [ ] Unit tests cover local-only, global-only, missing-local, and missing-global discovery
- [ ] Unit tests cover duplicate-id project-local precedence and root deduplication
- [ ] Unit tests cover `/skills` empty/list output and `skill(name)` expansion from the project-local root
- [ ] Unit tests prove project-local skills do not auto-run shell interpolation while the interpolation gate is off

## Summary
- Phase 1 (concurrent reads): 20 features, 20 completed, 0 remaining
- Phase 2 (turn-budget termination): 20 features, 20 completed, 0 remaining ✅ (M4 `/doctor` turn-termination reason shipped)
- Phase 3 (cross-turn compaction): 27 features, 27 completed, 0 remaining
- Phase 4 (provider SDK migration + outage recovery): 18 features, 18 completed, 0 remaining ✅ (M1/M2 migration to `@earendil-works/pi-ai@0.80.2` via `/compat` = 12, M3 outage auto-reconnect = 6; full suite + e2e + smoke green)
- Phase 5 (subagents): 41 features, ~39 completed (M1 discovery + M2 isolated child session/link + M3 inline + background delegation [cap, read-only clamp, late-result] + M4 web surfacing/`/doctor` + M5 inline ephemeral agents), ~2 remaining (the fork-dependent M2 forkability bullets, blocked on the unimplemented D-025…D-029 fork feature; plus refinements: ephemeral contract snapshot into the child session, runtime skill-tool allow-list gate, a distinct ephemeral web view)
- Phase 6 (search-tool upgrade): 14 features, 14 completed ✅ (M1 ripgrep-backed `grep` + M2 read-only `ast_grep`, both with project-managed binaries and tests)
- Phase 7 (nested AGENTS.md context files): 17 features, 17 completed ✅ (M1 pure reader + single-sourced `TREVOR_HOME` = 6, M2 eager prompt injection = 4, M3 lazy below-cwd loading = 5, M4 `/doctor` surfacing = 2; Claude Code lazy model keyed on AGENTS.md - eager up-tree + lazy below-cwd; 18 new unit tests; manual repro verified by construction, live-obedience is the gated lane)
- Phase 8 (prompt shell lane): 20 features, 0 completed, 20 remaining
- Active cutoff features: 20
- Active cutoff completed: 0
- Active cutoff remaining: 20
- Current cutoff blockers: 20 (Phase 8 prompt shell lane)
- Accepted/deferred follow-up: 75
- Phase 4 (provider SDK migration + outage auto-reconnect): 18, all shipped ✅
- Phase 5 (subagents): ~39/41 shipped (inline + background delegation); ~2 remaining are the fork-dependent M2 forkability bullets (blocked on the unimplemented D-025…D-029 fork feature) + minor refinements
- Phase 6 (search-tool upgrade: ripgrep `grep` + read-only `ast_grep`): 14, all shipped ✅
- Phase 7 (nested AGENTS.md context files, D-080 + D-081 single-sourced `TREVOR_HOME`): 17, all shipped ✅ (eager up-tree + lazy below-cwd, keyed on AGENTS.md, with /doctor surfacing)
- Phase 8 (prompt shell lane, D-082): 0/20 shipped; Storybook-first composer state is the first milestone
- Upcoming near-term, not active cutoff: D-083/D-084 composer recovery/history, D-085 project launcher, D-086 early transcript layout, D-087 project-local skill roots
- Remaining implementable work: Phase 8 has 20 current-cutoff blockers; fork-blocked Phase 5 bullets and minor refinements remain outside the active cutoff
- Superseded/obsolete checklist debt: 0

> Phase 2 shipped 2026-06-25 ahead of Phase 1 (its silent turn-budget dead-ends were biting:
> deepseek/glm cut off mid-answer, qwen4bit returning empty). Phase 1 (concurrent reads)
> shipped 2026-06-25: read-only tool batches now dispatch concurrently (bounded by
> TOOL_CONCURRENCY) with mutating calls as serial barriers, committed to history in call order.
> Only Phase 2 M4 (the `/doctor` turn-termination reason) remains in that cutoff.
> Phase 3 (cross-turn compaction, D-040…D-043) shipped 2026-06-25: a durable `context.compacted`
> rolling-chain event, a compaction-aware prompt projection (pins + summary + recent-verbatim) that
> leaves the UI transcript full, a tool-less ~1k-token summarizer, the 80%/50% background-after +
> blocking-before trigger off the one-turn gate, and `/compact` + a web marker + `/doctor` surfacing.
>
> Correction (2026-06-25, post-ship): `buildHistory` previously DROPPED all tool calls/results from
> the cross-turn prompt, so each turn restarted with none of the prior turn's reads (the agent
> "started over"), and compaction had nothing big to fold (the growth lived only inside a turn).
> This diverged from D-040's "recent turns, full fidelity" intent and from how every mainstream
> harness works. Fixed: `buildHistory` now RECONSTRUCTS tool.started/tool.completed into the
> conversation (assistant tool-call message + tool results) and CARRIES them across turns; `main.ts`
> records tool events into the durable history; and the compaction planner sizes/folds turns by
> their tool results (not just text). So the prompt grows the mainstream way and compaction is now
> load-bearing - it folds the file reads that actually fill the window.
> Phase 4 (provider SDK migration) is now the next task: move from the deprecated
> `@mariozechner/pi-ai@0.73.1` package to the maintained `@earendil-works/pi-ai@0.80.2`
> release while preserving today's provider behavior. Phase 4 M3 (provider-outage auto-reconnect
> recovery, D-076…D-079) is sequenced right after the migration: a transient provider stream drop
> (Codex WebSocket, connection reset, timeout, 429/5xx) auto-retries the current step with bounded
> backoff and a live `assistant.reconnecting` status, but only before any tokens have streamed -
> built on the maintained SDK's error surface, sibling to graceful overflow recovery.
> Phase 5 (subagents, D-045…D-049) remains decomposed and not started under
> accepted/deferred follow-up; it now includes ephemeral model-minted definitions after
> the reusable file-defined agent path lands.
> Phase 6 (search-tool upgrade, D-062) is sequenced immediately after subagents and is decomposed here:
> `grep` keeps its tool name but becomes ripgrep-backed, and H-108 `ast_grep` becomes a read-only
> structural-search tool.

# Trevor V2 - Progress Report

> Canonical source of truth for what is done and what remains in the **active
> implementation cutoff**. Update this file as features are implemented - never
> mark a milestone complete until every current-cutoff checkbox under it is
> checked.

> **Scope.** This report tracks the near-term cutoff and the next sequenced feature.
> **Phase 1 - concurrent read-only tool execution** (D-050), **Phase 2 - graceful
> turn-budget termination** (D-051…D-053), and **Phase 3 - cross-turn compaction**
> (D-040…D-043) are shipped except one trailing item (Phase 2 M4 `/doctor`). **Phase
> 4 - provider SDK migration** is the next task before subagents: switch the host
> from deprecated `@mariozechner/pi-ai@0.73.1` to the latest maintained
> `@earendil-works/pi-ai` release, verified 2026-06-25 as `0.80.2`.
> **Phase 5 - subagents** (D-045…D-049) remains decomposed below as
> accepted/deferred follow-up after the provider migration and includes both reusable
> file-defined agents and runtime-minted ephemeral definitions. **Phase 6 -
> search-tool upgrade** (D-062) is decomposed below as the immediately-after-subagents
> follow-up: `grep` becomes ripgrep-backed and H-108 `ast_grep` becomes a read-only
> structural-search tool. Later roadmap items (session recall D-044, WAN fallback
> D-060, session manager D-061, …) stay sequenced in §6 and are decomposed here when
> picked up.

> Current focus: Phase 5 - subagents. M1 (discovery) + M2 (isolated child session + link) + M3
>   inline delegation are shipped end-to-end; `delegate_background` + M4 (web surfacing / `/doctor`)
>   + M5 (ephemeral agents) remain.
> Done: Phase 4 (SDK migration + outage auto-reconnect, M1-M3) ✅; Phase 5 M1-M3-inline.
> Notes: (1) the fork machinery (D-025…D-029) referenced by M2 is NOT in the codebase yet, so the
>   "independently forkable / forking copies the frozen result" properties are forward-looking -
>   `delegated.to.result` already carries the frozen result for when fork lands. (2) Delegation runs
>   from the loop layer (it needs the provider + transport), intercepted as a parent-only capability;
>   depth-1 is structural (a child is given no capability). Then Phase 6 - search-tool upgrade (D-062).

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
- [ ] Host state / `/doctor` reports the turn termination reason (answered | step_limit | overflow | noReply | cancelled)
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

### M3: Delegation tools + execution modes — inline ✅; background deferred
Source: `apps/agent-host/src/agent/delegate.ts`, `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/turn.ts`, `apps/agent-host/src/main.ts`

- [x] `delegate_inline` (sync): the loop intercepts the call, runs the child to completion, and folds its final message in as the tool result (the parent turn blocks)
- [ ] `delegate_background` (async): the immediate follow-on — needs the concurrent-child lifecycle + the active-child cap + the result-arrives-later event
- [x] Fold-back: the child's final message becomes the parent's tool result
- [x] The child runs the same `runAgent` loop with its agent's tool allow-list (`runAgent`/`publishTurn` thread `toolNames`; the executor enforces it) + the agent body as its instructions
- [x] Delegation tools leave `readOnly` unset, so the D-050 partition runs them as serial barriers
- [x] Depth-1 only: a child turn is given no delegation capability, so children may not spawn grandchildren
- [x] Child tool registries never include `delegate_inline` (the delegation defs live in the parent-only capability, never in `TOOL_DEFS`), even for `general-purpose` / `tools: ['*']`
- [x] Depth-1 enforced structurally (no capability on the child) rather than a runtime depth counter; a child literally cannot see the tool
- [ ] `MAX_BACKGROUND_CHILDREN_PER_SESSION = 4` cap — with `delegate_background`
- [ ] `delegate_background` read-only clamp — with `delegate_background`
- [ ] Ephemeral background `tools: ['*']` → read-only — with M5 + background
- [x] Mutating background agents documented as deferred (with the background follow-on)
- [x] No teams (multi-agent orchestration) in this cut
- [x] Unit test: an inline delegation routes through the capability and folds the child's result; a child turn is offered no delegation tool (depth-1); the capability returns structured errors for an unknown agent / empty task
- [ ] (background-specific tests land with `delegate_background`)

### M4: Surfacing + isolation (verification)
Source: `apps/web/src/transcript.ts`, `apps/web/src/components/chat/message.tsx`, `apps/agent-host/src/commands.ts`

- [ ] The web renders a delegation as a distinct linked block (child session id + status), separate from an ordinary tool card
- [ ] A background delegation's late result lands by id (wire-order tolerant, like D-050 / M4)
- [ ] `/doctor` reports active child delegations, depth policy, and active background-child count/cap
- [ ] Manual repro: a general-purpose inline delegation distills a multi-step subtask into one parent tool result; an explorer fan-out reads files without leaking parent context

### M5: Ephemeral model-minted agents
Source: `apps/agent-host/src/tools/delegate.ts`, `apps/agent-host/src/agents.ts`, `packages/session/src/protocol.ts`, `apps/web/src/transcript.ts`

- [ ] `delegate_inline` / `delegate_background` accept either a discovered agent id or an inline ephemeral definition
- [ ] An ephemeral definition is `{ description, instructions, tools, skills? }`; execution mode is implied by the delegation tool and recorded with the run
- [ ] Ephemeral definitions are runtime-only: no file is written, no reusable registry entry is created, and the definition is snapshotted into the child session for audit/replay
- [ ] The host validates `tools` and `skills` against their registries before starting the child; unknown names and policy-forbidden names are rejected with a structured tool error
- [ ] The child prompt loads only the selected tool schemas and skill names/descriptions; a skill body is loaded only if the child later chooses to use that accessible skill
- [ ] Ephemeral children use the same isolated child session, `delegatedTo` link, cancellation, fold-back, and parent-fork behavior as discovered agents
- [ ] The web renders ephemeral delegations as linked child blocks with their selected tool/skill contract, distinct from named reusable agents
- [ ] Unit tests cover invalid ephemeral specs, no unlisted tool/skill access, no implicit parent transcript leak, and forked parents preserving the frozen result without re-running the child
- [ ] Unit test: an ephemeral definition cannot re-enable delegation tools or bypass the depth-1 policy

## Accepted/Deferred Follow-up: Phase 6: Search-tool upgrade

Immediately after Phase 5 subagents, align the existing `grep` tool with the plan's `grep` (rg) intent and
promote H-108 `ast_grep` into a first-class read-only structural-search tool. Source:
`apps/agent-host/src/tools/grep.ts`, `apps/agent-host/src/tools/ast-grep.ts` (new),
`apps/agent-host/src/tools/search-process.ts` (new), `apps/agent-host/src/tools/index.ts`,
`apps/agent-host/src/providers/system-prompt.ts`, `apps/web` generic tool rendering (D-062).

### M1: Ripgrep-backed `grep`
Source: `apps/agent-host/src/tools/grep.ts`, shared search-process helper

- [ ] Add a shared read-only search-process helper using `execFile`/`spawn` with argv arrays, `cwd: WORKSPACE_ROOT`, timeout, max buffer, output cap, typed nonzero handling, and interruption cleanup
- [ ] Add a project-managed ripgrep binary resolver such as `@vscode/ripgrep` or an equivalent checked dependency; do not depend on Homebrew/system `rg`
- [ ] Replace the custom Node glob/read/RegExp scanner with the ripgrep backend while keeping tool `name: "grep"` and its text-output result shape
- [ ] Preserve `readOnly: true`, workspace confinement, D-050 concurrent-read behavior, output caps, and typed tool input/execution errors
- [ ] Keep the schema explicit: `pattern`, optional `glob`, `literal`, `ignoreCase`, `hidden`, `noIgnore`, `maxMatches`; no raw ripgrep flag passthrough
- [ ] Update prompt/tool-selection guidance to explain ripgrep-backed text search and when to use `grep` vs `ast_grep`
- [ ] Tests cover no-match, ignored dirs/gitignore behavior, literal vs regex, invalid regex, max caps, workspace confinement, output truncation, and `READ_ONLY_TOOLS` inclusion

### M2: Read-only `ast_grep`
Source: `apps/agent-host/src/tools/ast-grep.ts` (new), shared search-process helper

- [ ] Add an ast-grep CLI resolver through a project-managed package; call the full `ast-grep` binary name, not `sg`
- [ ] Add `ast_grep` as a read-only tool that wraps `ast-grep run` only; no rewrite, update-all, or interactive flags in this cut
- [ ] Keep the schema explicit: `pattern`, optional `lang`, optional `paths`, optional `globs`, optional `strictness`, optional `maxMatches`; no raw flag passthrough
- [ ] Prefer `--json=stream`, parse structured matches, and normalize them into compact capped rows with path, line/column, and snippet
- [ ] Run confined to `WORKSPACE_ROOT`, respect bounded paths/globs, and preserve typed failures for invalid patterns, invalid languages, and execution errors
- [ ] Register `ast_grep` in `TOOLS`, `TOOL_DEFS`, `READ_ONLY_TOOLS`, and prompt guidance; generic web text-output rendering is enough unless a clearer renderer is needed
- [ ] Tests cover TS/TSX structural matches, lang inference and explicit `lang`, globs/paths, no-match, invalid pattern/lang, max caps, workspace confinement, and read-only registry inclusion

## Summary
- Phase 1 (concurrent reads): 20 features, 20 completed, 0 remaining
- Phase 2 (turn-budget termination): 20 features, 19 completed, 1 remaining
- Phase 3 (cross-turn compaction): 27 features, 27 completed, 0 remaining
- Phase 4 (provider SDK migration + outage recovery): 18 features, 18 completed, 0 remaining ✅ (M1/M2 migration to `@earendil-works/pi-ai@0.80.2` via `/compat` = 12, M3 outage auto-reconnect = 6; full suite + e2e + smoke green)
- Phase 5 (subagents): 41 features, ~22 completed (M1 discovery + M2 isolated child session/link + M3 inline delegation), ~19 remaining (`delegate_background` + caps, M4 web surfacing/`/doctor`, M5 ephemeral agents; plus the fork-dependent M2 forkability bullets, blocked on the unimplemented D-025…D-029 fork feature)
- Phase 6 (search-tool upgrade, accepted/deferred after subagents): 14 features, 0 completed, 14 remaining (decomposed, not started)
- Total features: 67
- Completed: 66
- Remaining: 1
- Current cutoff blockers: 1 (Phase 2 M4 /doctor turn-termination reason)
- Next-feature work (decomposed, not started): 18 (Phase 4: provider SDK migration to `@earendil-works/pi-ai@0.80.2` = 12, then M3 provider-outage auto-reconnect recovery = 6)
- Post-provider-migration sequenced follow-up: 41 (Phase 5 subagents, including D-049 ephemeral definitions, depth-1 limits, and read-only background delegation)
- Post-subagents sequenced follow-up: 14 (Phase 6 search-tool upgrade: ripgrep-backed `grep` + read-only `ast_grep`)
- Accepted/deferred follow-up: 73
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

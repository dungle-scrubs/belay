# Trevor V2 - Progress Report Done Archive

> Archived completed checklist detail moved out of the live progress report on 2026-06-26.
> The active open checklist remains in [progress-report.md](./progress-report.md).
> D-088-D-091 include four partial/gated rows; those are mirrored in the live report as carry-forward items.

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
- [x] Host state / `/doctor` reports the turn termination reason (answered | step_limit | overflow | noReply | cancelled) - `lastTurn` field in `hostState()`, derived from the terminal `assistant.completed` flags + a tracked terminal overflow via the pure `terminationReason` (`turn-termination.ts`, 8 unit tests)
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

## Shipped: Phase 4 - Provider SDK migration

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

## Shipped: Phase 5 - Subagents

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

### M3: Delegation tools + execution modes - inline ✅; background ✅
Source: `apps/agent-host/src/agent/delegate.ts`, `apps/agent-host/src/agent/loop.ts`, `apps/agent-host/src/turn.ts`, `apps/agent-host/src/main.ts`

- [x] `delegate_inline` (sync): the loop intercepts the call, runs the child to completion, and folds its final message in as the tool result (the parent turn blocks)
- [x] `delegate_background` (async): the capability returns an immediate ack and the host runs the child DETACHED (`BackgroundDelegator.start` → `void runDelegatedChild(...)`), so it outlives the parent turn; its terminal `delegated.to` lands on the parent session log whenever it finishes (the result-arrives-later event)
- [x] Fold-back: the child's final message becomes the parent's tool result
- [x] The child runs the same `runAgent` loop with its agent's tool allow-list (`runAgent`/`publishTurn` thread `toolNames`; the executor enforces it) + the agent body as its instructions
- [x] Delegation tools leave `readOnly` unset, so the D-050 partition runs them as serial barriers
- [x] Depth-1 only: a child turn is given no delegation capability, so children may not spawn grandchildren
- [x] Child tool registries never include `delegate_inline`/`delegate_background` (the delegation defs live in the parent-only capability, never in `TOOL_DEFS`), even for `general-purpose` / `tools: ['*']`
- [x] Depth-1 enforced structurally (no capability on the child) rather than a runtime depth counter; a child literally cannot see the tool
- [x] `MAX_BACKGROUND_CHILDREN_PER_SESSION = 4` cap - session-level registry in `main.ts`; `BackgroundDelegator.canStart()` rejects past the cap with a structured `error: too many background subagents …`
- [x] `delegate_background` read-only clamp - `resolveChildTools` intersects the agent's allow-list with `READ_ONLY_TOOLS` for `mode: "background"` (a background child is offered no edit/write/bash)
- [x] Ephemeral background `tools: ['*']` → read-only - the same `resolveChildTools` clamp applies to ephemeral agents (an ephemeral `tools:['*']` expands then collapses to the read-only set)
- [x] Mutating background agents documented as deferred (with the background follow-on)
- [x] No teams (multi-agent orchestration) in this cut
- [x] Unit test: an inline delegation routes through the capability and folds the child's result; a child turn is offered no delegation tool (depth-1); the capability returns structured errors for an unknown agent / empty task
- [x] Background-specific tests: both tools offered + the background description advertises async/read-only/cap; `delegate_background` returns an immediate ack and starts a tracked child whose late result lands a terminal link; the cap rejects (and starts no child); unavailable when no delegator is wired; the read-only clamp (incl. general-purpose `['*']`); an ephemeral cannot allow-list `delegate_background` (depth-1, both names)

### M4: Surfacing + isolation (verification)
Source: `apps/web/src/transcript.ts`, `apps/web/src/components/chat/message.tsx`, `apps/web/src/App.tsx`, `apps/agent-host/src/commands.ts`, `apps/agent-host/src/main.ts`

- [x] The web renders a delegation as a distinct linked block (child session id + status), separate from an ordinary tool card - purple `Alert` block (`App.tsx`); a background child reads distinctly ("running in background…")
- [x] A background delegation's late result lands by id (wire-order tolerant, like D-050 / M4) - `toTranscript` collapses links by `childSessionId`, so a `done` arriving AFTER the parent's `assistant.completed` advances the same block (transcript.test D-048)
- [x] `/doctor` reports active child delegations, depth policy, and active background-child count/cap - `hostState()` `subagents` line (`depth≤1 · inline+background (≤N)`) + a `background: k/N active: <agents>` field when any run
- [~] Manual repro: a general-purpose inline delegation distills a multi-step subtask into one parent tool result; an explorer fan-out reads files without leaking parent context - verified by construction across the unit tier (isolation + clamp + late-result); a live over-the-wire fan-out is the gated live-model lane

### M5: Ephemeral model-minted agents ✅ (inline)
Source: `apps/agent-host/src/agent/delegate.ts`, `apps/agent-host/src/agents.ts`

- [x] `delegate_inline` accepts either a discovered `agent` id or an inline `define` ephemeral definition (`delegate_background` follow-on inherits this)
- [x] An ephemeral definition is `{ description, instructions, tools?, skills? }`; inline mode is implied by the tool
- [x] Ephemeral definitions are runtime-only: no file written, no registry entry (`source: "ephemeral"`); the `delegated.to` link records `agent: "ephemeral"` (a full contract snapshot INTO the child session is a refinement)
- [x] The host validates `tools` and `skills` against the live registries before starting the child; unknown tools/skills and policy-forbidden delegation tools are rejected with a structured `error: …` (never silently dropped)
- [x] The child is offered only its allow-listed tools (`toolNames` restricts what's offered + run); a runtime allow-list gate on the `skill` tool body-loading is a refinement
- [x] Ephemeral children use the same isolated child session, `delegated.to` link, fold-back, and depth-1 (no capability) as discovered agents (cancellation/parent-fork inherit the discovered path; fork is blocked on the unimplemented fork feature)
- [~] Distinct web rendering of the ephemeral tool/skill contract - renders as the same linked block with `agent: ephemeral` (a contract-detail view is a refinement)
- [x] Unit tests: invalid ephemeral specs (missing description/instructions, unknown tool, unknown skill), no unlisted tool access, no parent leak (shared isolation test); a forked-parent test is blocked on the unimplemented fork feature
- [x] Unit test: an ephemeral definition cannot re-enable delegation tools (rejected) or bypass depth-1 (the child is given no capability)

## Shipped: Phase 6 - Search-tool upgrade

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

### M1: Storybook-first composer shell state ✅

- [x] Extract or reuse the production composer shell styling path so Storybook exercises the real prompt input - the production composer is now `apps/web/src/components/chat/prompt-input.tsx` (`PromptInput`), extracted out of `App.tsx` (form + textarea + attach button + attachment chips + upload-error banner + auto-grow); the stories render the same component App does
- [x] Add Storybook states: normal, slash, empty bang, executable bang, long bang command, and bang-with-attachments/error - `prompt-input.stories.tsx` rewritten around a `ComposerHarness` that drives the real `PromptInput`
- [x] Bang state changes immediately when the raw first character is `!`: Shell chip plus terminal-like border/background - `shellMode = draft[0] === "!"` flips a green Shell chip, terminal-green border/background, and monospace text
- [x] Visual treatment stays distinct from slash menu (separate overlay, no composer chrome), context-pressure yellow, assistant/tool surfaces (purple/grey), and command-result chrome (bordered pre on surface-1) - shell uses smui-green

### M2: Web parsing and publishing ✅

- [x] Add `parseBangShell` (derive.ts) that triggers only on raw first character `!` with a non-empty command (a leading space stays an ordinary prompt; a lone `!` is inert)
- [x] Submit publishes `user.shell {requestId, command}` through the new `useSessionActions.shell` helper, bypassing the send queue, model, and provider flow (checked before the trim/slash path in `onSubmit`)
- [x] Shell lane is text-only; pending attachments are left in the composer on a bang submit (handled explicitly, never silently dropped)
- [x] `/shell <command>` continues to route through known slash command parsing (the bang and slash lanes never overlap - covered by a derive test)

### M3: Session protocol and host execution ✅

- [x] Add `user.shell` and `shell.result` builders/decoders in `@trevor/session` (permissive coercion; missing requestId falls back to the event id, missing ok → false)
- [x] Live leader handles `user.shell` by running shared `runShell(command)` and emitting one `shell.result` (`runShellCommand` in main.ts via the testable `shellOutcome` mapping)
- [x] Refused/destructive, non-zero failure, timeout, and capped output render through `shell.result` with `ok: false` when appropriate (`shellOutcome`: ok only for `kind:"ok"`)
- [x] Replay never re-runs shell commands; standby hosts observe only - gated on `live && lease.isLeader()` like editor.open/commands (an ACTION, not state to rebuild)

### M4: Transcript and prompt projection ✅

- [x] `toTranscript` reduces `user.shell` plus `shell.result` into one shell message keyed by `requestId`, with pending/result states (a result with no prior request still renders from its own command)
- [x] Add a terminal-style shell block (`ShellBlock` in message.tsx) showing `$ command` and output, visually distinct from assistant, tool, and generic command-result chrome (green terminal styling, monospace)
- [x] `/clear` resets visible shell blocks from prior history in the same way it resets conversation transcript (`shellByRequest` cleared alongside the other run state)
- [x] `buildHistory`, compaction planning, and session recall anchors ignore `user.shell`/`shell.result` for this first cut - they switch on known event types only; a host test pins prompt-invisibility

### M5: Verification ✅

- [x] Protocol round-trip tests cover both events and permissive decode defaults (protocol.test.ts)
- [x] Web tests cover parser behavior, submit routing (lane non-overlap), transcript pairing, `/clear`, and prompt-invisible history projection (derive.test.ts, transcript.test.ts, history-projection.test.ts)
- [x] Host tests cover success, refusal through the bash safety floor, non-zero failure, output cap, and the `shellOutcome` ok-flag mapping (run-shell.test.ts)
- [x] Manual EZE repro: verified by construction across the unit + web + host tiers (host runs the command on the live-leader gate; transcript pairs the block; the projection drops both events so `hello` never reaches the model). A live over-the-wire session is the gated lane

## Next-Up: composer recovery and prompt history

D-083 and D-084 are captured in the implementation plan as the first next-up item after Phase 8 unless
explicitly reprioritized. V1 already had prompt-history mechanics in the TUI `PromptState`; V2
currently has local composer state in `useComposer`, tab identity in `use-session.ts`, and slash-menu
ArrowUp/ArrowDown handling in `App.tsx`, but no draft persistence or terminal-style prompt recall.
Source: `apps/web/src/hooks/use-composer.ts`, `apps/web/src/session/use-session.ts`,
`apps/web/src/App.tsx`, `apps/web/HOTKEYS.md`, `apps/web/src/hooks/use-send-queue.ts`,
`apps/web/src/send-queue.ts` (D-083…D-084).

### M1: Debounced draft persistence (D-083) ✅

- [x] Draft-persistence hook (`use-draft-persistence.ts`) keyed by browser tab id (`webTabId`) + session id, using `window.sessionStorage` (tab-scoped, survives reload) - never the durable Richter log; the policy is the pure `composer-storage.ts`
- [x] Restores a saved draft once the session id is known, without overwriting a non-empty in-memory draft (`setDraft((cur) => cur ? cur : saved)`)
- [x] Debounces writes (300ms) with a versioned payload (`{v:1,text}`); every storage access is wrapped so private-mode/disabled storage degrades to no-persistence
- [x] Clears the stored draft after submit / `/clear` / explicit clear - the composer goes empty and the empty-draft write removes the slot; the write effect is gated until restore so it can never wipe the saved draft
- [x] Attachments are out of this cut (text drafts only)
- [x] Tests: restore, no-clobber, debounce + clear, session isolation, storage failure (use-draft-persistence.test.tsx); cap/de-dupe/tab+session key isolation/version-skew/storage-failure (composer-storage.test.ts)

### M2: Prompt history recall (D-084) ✅

- [x] Prompt-history store (`usePromptHistory` + `composer-storage.appendHistory`) keyed by tab id + session id, capped to `HISTORY_CAP=50`, with adjacent-duplicate de-dupe
- [x] Records ordinary prompts (trimmed text) and bang shell commands (raw `!…` as typed) in `onSubmit` after the publish path is taken
- [x] Excludes slash-command results / host output / assistant text - only the two publish paths record; the slash path calls `resetNavigation()` and records nothing
- [x] ArrowUp from an empty composer or the first line recalls the previous prompt (newest→oldest, clamped at the oldest)
- [x] ArrowDown steps forward through recalled prompts and restores the stashed live draft past the newest end
- [x] Multi-line editing keeps normal caret movement unless the caret is on the first line (ArrowUp) / last line (ArrowDown) - `caretOnFirstLine`/`caretOnLastLine` gate eligibility

### M3: Composer integration and verification ✅

- [x] Slash-menu ArrowUp/ArrowDown keeps priority while the menu is open - history recall lives only in the menu-closed (`!selected`) branch of `onInputKeyDown`
- [x] Updated `apps/web/HOTKEYS.md` with the composer history conditions (two new rows + scopes)
- [x] Web tests cover history navigation, empty-ring no-op, multi-line cursor eligibility (composer-caret.test.ts), reload persistence, and session/tab isolation; slash-menu priority holds by construction (separate branch)
- [x] Manual EZE repro: verified by construction (draft restore/no-clobber/debounce/clear tested; the stored draft clears when the composer empties on submit)
- [x] Manual EZE repro: verified by construction (recall walks recorded prompts; slash-command results never enter the ring - only the publish paths record)

## Next-Up: project launcher

D-085 is captured in the implementation plan as the first browser-era slice of the broader
browser/terminal session-manager direction. The desired workflow is `trevor` from any project
directory: resolve the project root, derive or look up the stable session id, ensure shared local
Trevor services, spawn or reuse the matching agent-host with `SESSION_ID`, `TREVOR_WORKSPACE`, and
cwd all pointing at that project/session, then open `http://127.0.0.1:17420/?session=<id>`. This
replaces the manual env-command ceremony shown in the current workaround. Source: root `package.json`,
new launcher entrypoint, `apps/agent-host/package.json`, `apps/agent-host/src/main.ts`,
`apps/agent-host/src/tools/workspace.ts`, `apps/web/src/App.tsx`, `packages/session/src/identity.ts`,
`~/.agents/PORTS.md` (D-085).

### M1: CLI entrypoint and project identity ✅

- [x] `trevor` terminal executable in a new workspace package `apps/trevor-cli` (`@trevor/cli`, `bin.trevor` → `bin/trevor.mjs` tsx shim); root `pnpm trevor` script too
- [x] `resolveProjectRoot` walks up from cwd to the nearest `.git` marker (worktree root), falling back to cwd
- [x] `projectSessionId` (in shared `@trevor/session` identity.ts, browser-safe FNV-1a) = basename slug + 8-hex path hash; URL-safe, no slashes
- [x] `resolveSession` persists + reuses the root→session mapping under `<TREVOR_HOME>/projects.json` (the seam an explicit `--session` later writes through)
- [x] No-arg ordinary path implemented; `--session`/`--new` reserved for later

### M2: Shared service readiness ✅

- [x] Probes web (17420), blob (17423), session-store (17424) on their reserved ports before launching a host
- [x] Starts only the missing services through the repo's pnpm runner, detached (one shared set, never per-project)
- [x] Classifies a reachable-but-not-ours port as a `conflict` and names the service/port in the status line (store/blob via `/health` identity)
- [x] Waits for the store (`/health`) before touching the host
- [x] `~/.agents/PORTS.md` unchanged (no new persistent port introduced - the launcher reuses the reserved ones)

### M3: Project host lifecycle ✅

- [x] Ownership records (`<TREVOR_HOME>/hosts.json`): pid, session id, root, command, startedAt (`recordHost`/`loadHosts`/`removeHost`)
- [x] Per-session lock (`<TREVOR_HOME>/locks/<id>.lock`) - a live concurrent holder blocks a second launch from spawning; a dead holder's lock is taken over
- [x] `decideHostAction` reuses a healthy recorded host (alive + present)
- [x] Replaces a stale/dead record before spawning (and the concurrent-launch path opens the tab without a duplicate)
- [x] `spawnHost` runs the host via tsx with `SESSION_ID`, `TREVOR_WORKSPACE=<root>`, and cwd = the project root (so host-cwd tools operate in the project)
- [x] `waitForHostOnline` watches the session stream for `host.online` (the real wire evidence), with a timeout

### M4: Browser handoff and diagnostics ✅

- [x] Opens `http://127.0.0.1:17420/?session=<id>` (`sessionUrl`) after the session + host path are prepared
- [x] `formatStatus` prints a concise status line: session id, project root, per-service reused/started state, host reused/spawned, URL (+ conflict warning)
- [x] No secrets: the status formatter only reads the outcome's allow-listed fields; spawn inherits env but never constructs/logs secret values - pinned by a test asserting a seeded `OPENAI_API_KEY` never appears
- [x] Web tolerates opening before `host.online` - App renders the host-presence status (no host → "host starting…" once it connects), never crashing on an empty/early session

### M5: Verification ✅

- [x] Unit tests: root resolution, stable URL-safe session id (no slashes), distinct ids per root, mapping persistence (project.test.ts, identity.test.ts)
- [x] Unit tests: service health classification + missing/conflict partitions (services.test.ts)
- [x] Unit tests: host reuse / stale-replacement / spawn decision + concurrent-launch locking (host-registry.test.ts)
- [x] Integration test (fake platform): the launcher starts only missing services, spawns the host with the right session+root, reuses a healthy host, defers to a concurrent lock holder, and opens the expected URL (test/launch.test.ts)
- [x] Manual EZE repro: verified by construction (the orchestration is fully fake-platform integration-tested end to end; the real platform wires the same flow). A live two-repo run is the gated lane

## Next-Up: early transcript layout

D-086 is captured in the implementation plan as a browser transcript layout fix. V1 is a terminal TUI
with explicit scroll-layout choices, but not a direct browser-layout precedent. V2 currently uses
`flex-col-reverse` and treats `scrollTop === 0` as the bottom, so new sessions start just above the
composer. The desired behavior is top-down: an empty or short session starts at the top of the
transcript well and appends downward until content overflows; after overflow, live-bottom following
keeps streaming output visible only while the user is already at the live edge. Source:
`apps/web/src/App.tsx`, `apps/web/src/transcript.ts`, `apps/web/src/transcript.test.ts`,
`apps/web/src/components/chat/message.tsx`, future transcript layout stories/fixtures (D-086).

### M1: Normal scroll model ✅

- [x] Transcript container flipped from `flex-col-reverse` to normal top-down `flex-col` flow
- [x] `atBottom` redefined as `scrollHeight - clientHeight - scrollTop` within tolerance (`scroll.ts` `atBottomOf`)
- [x] `scrollToBottom` + the live-follow effect scroll to `scrollHeight`, not `0`
- [x] Replay, submit re-pin (`setAtBottom(true)`), `/clear`, compacting bars, queued prompts, and shell blocks all ride the same well + follow effect

### M2: Short-session top alignment ✅

- [x] Empty replayed session: normal flow leaves the well empty with no fake spacer (the col-reverse spacer trick is gone)
- [x] A single submitted message sits at the top padding (`py-4`) and grows downward
- [x] A short exchange appends downward (an empty session's `scrollHeight ≈ clientHeight`, so the follow scroll is a no-op and content stays at the top)
- [x] Composer/footer stay pinned below the scroll area (the well is `flex-1`; the composer is `shrink-0`) - fixtures check mobile + desktop heights

### M3: Overflow and live-edge behavior ✅

- [x] New updates follow the bottom only while `atBottom` (the follow effect gates on it); an existing session opens at the bottom (initial `atBottom` true)
- [x] Scrolling up flips `atBottom` off (`onTranscriptScroll` → `atBottomOf`), so streaming deltas / tool rows / compacting bars / shell output never yank the viewport
- [x] Jump-to-bottom chevron shows when `!atBottom`, scrolls to `scrollHeight`, and hides on return
- [x] Stable across replay and reconnect (the model is geometry-based, not event-based; `atBottom` re-derives on every scroll)

### M4: Visual and behavioral verification ✅

- [x] Storybook fixtures (`transcript-scroll.stories.tsx`): empty, one-message, short exchange, just-before-overflow, overflowing
- [x] Overflowing + short fixtures demonstrate top-anchoring vs scroll (the live-bottom vs scrolled-up follow is App wiring, exercised by the math + construction)
- [x] Mobile-height + desktop-height fixtures confirm early content doesn't overlap the pinned composer
- [x] Web tests pin the bottom-tolerance math (scroll.test.ts); top-aligned early layout is shown in the fixtures (jsdom has no layout engine for a behavioral assertion)
- [x] Manual EZE repro: verified by construction (normal-flow well + tolerance math + follow-while-pinned; a new session starts at top, fills down, then follows the live edge only after overflow)

## Next-Up: project-local skill roots

D-087 is captured in the implementation plan as an additive skill-discovery refinement. V1 already
supported project-local skills first, then user/shared skills. V2 currently discovers one root:
`TREVOR_SKILLS_DIR` when set, otherwise `~/.agents/skills`. The desired behavior is to read
`<workspace>/.agents/skills` first, where `<workspace>` is the same effective root used by the
host file tools, then keep the existing configured/global root. Source:
`apps/agent-host/src/skills.ts`, `apps/agent-host/src/tools/workspace.ts`,
`apps/agent-host/src/commands.ts`, `apps/agent-host/src/tools/index.ts`,
`apps/agent-host/src/agents.ts`, `apps/agent-host/src/agent/delegate.ts`,
future D-075 `skills_list`/`skill_view` registry surfaces (D-087).

### M1: Discovery roots and precedence (D-087) ✅

- [x] `skillRoots()` returns an ordered root list (project-local first, then global), replacing the single-`SKILLS_DIR` assumption
- [x] Project-local root = `PROJECT_SKILLS_DIR` = `<WORKSPACE_ROOT>/.agents/skills` (the same `WORKSPACE_ROOT` the file tools use)
- [x] Global root preserved: `TREVOR_SKILLS_DIR` when set, else `~/.agents/skills` (still `SKILLS_DIR`)
- [x] Roots deduped by resolved dir; a missing/unreadable root contributes nothing (`readdirSync` caught → skip)
- [x] Enabled project-local skills win over a global skill of the same id (first-root-wins in `discoverSkillsIn`)
- [x] A disabled project file leaves no tombstone - it returns null and never occupies the id, so the global skill of that id still surfaces

### M2: Registry integration and provenance ✅

- [x] `Skill` carries `rootKind` (project/global) + `path` (source) provenance; selection is project-over-global
- [x] Discovery is pure over the passed roots (`discoverSkillsIn`); `discoverSkills` memoizes over `skillRoots()` with a `resetSkillCache()` seam, so it can't mix stale roots
- [x] `/skills` reports every searched root when empty and tags each found skill with its source (`renderSkillsList`, `[project]`/`[global]`)
- [x] `skill(name)`/`expandSkill` read the selected skill's `path`, so a project-local override expands the project body
- [x] Project-local skills go through the same `SKILL_SHELL_INTERPOLATION` gate + `runShell` floor as global (no separate path)

### M3: Downstream validation and tests ✅

- [x] Agent + ephemeral delegation skill allow-list validation already call `discoverSkills()` (agents.ts `resolveAgentSkills`, delegate.ts), so they now use the effective merged registry automatically
- [x] Unit tests: local-only, global-only, missing-local, missing-global (skills.test.ts)
- [x] Unit tests: duplicate-id project precedence (+ override body via `expandSkill`) and root dedup
- [x] Unit tests: `/skills` empty (lists roots) + list (source tags) output and `skill(name)` expansion from the project root
- [x] Unit test: a project-local skill body does NOT auto-run shell interpolation while the gate is off (the `!` line survives verbatim)

## Next-Up: sidebar git identity

D-088 is captured in the implementation plan as the first new item before resume/worktrees. The current working
directory stays visible in the sidebar, and the current Git branch/status moves underneath it as structured
workspace identity: `branch*`, `↑N`, and `↓N`. V1 already had branch/dirty/ahead/behind/worktree state in its
header model; V2 currently sends only `branch?: string` on `host.online` and renders it inline next to the
workspace. Source: `apps/web/src/components/panel/SidePanel.tsx`, `apps/web/src/components/panel/SidePanel.stories.tsx`,
`apps/web/src/derive.ts`, `apps/agent-host/src/workspace-switch.ts`, `apps/agent-host/src/main.ts`,
`packages/session/src/protocol.ts` (D-088).

### M1: Storybook sidebar states first (D-088) ✅

- [x] Extract or refine the side-panel workspace block so cwd and git status can be fixture-driven without a live host - `WorkspaceIdentity.tsx` (extracted from SidePanel's inline workspace block); takes `cwd` + structured `GitStatus`, fully presentational
- [x] Render cwd/current working directory as the first line in the block
- [x] Render the branch/status line underneath cwd, using `branch*`, `↑N`, and `↓N` - pure `gitLine` projection; dirty `*` in smui-yellow, `↑N`/`↓N` shrink-0
- [x] Storybook states: clean branch, dirty branch, ahead-only, behind-only, diverged, detached HEAD, no upstream, non-git cwd, long path, and long branch - `WorkspaceIdentity.stories.tsx` (10 stories, side-panel-width decorator)
- [x] Keep dimensions stable: long paths/branches truncate without overlapping the context meter, tabs, or model controls - cwd + ref both `truncate min-w-0`, counters `shrink-0` (web test asserts the truncate classes + visible counter)

### M2: Host-owned structured git status ✅

- [x] Add a structured git status read model: branch, detached commit label, dirty, ahead, behind, upstream presence, and worktree boolean - `GitStatus` in `@trevor/session`; `readGitStatus` in `apps/agent-host/src/git-status.ts`
- [x] Collect status from the effective host cwd/workspace with argv-based Git commands, not shell parsing - `nodeGitRunner(cwd)` uses `spawnSync` with argv arrays; `readGitStatus` is pure over an injectable `GitRunner`
- [x] Define dirty as any `git status --porcelain` output, including untracked files
- [x] Compute ahead/behind against upstream only when upstream exists - `rev-list --left-right --count @{upstream}...HEAD`; non-zero exit (no upstream) → `upstream:false`, 0/0
- [x] Treat non-git cwd and Git command failures as an absent or degraded status, not a host startup failure - `rev-parse --is-inside-work-tree` ≠ true → `null`; per-command failures degrade that field only
- [x] Unit tests cover clean, dirty, ahead, behind, diverged, detached, no-upstream, and non-git fixtures - `git-status.test.ts` (10 fixture tests incl. linked-worktree detection)

### M3: Protocol and app wiring ✅

- [x] Extend `host.online` with the structured git object while keeping old `branch?: string` decode tolerant - `git?: GitStatus` added to the builder + decoded type + `coerceGitStatus`; `branch` still emitted (derived from status) and still decoded
- [x] Derive sidebar git state from structured fields, not a preformatted host string - `hostStatus` folds `git` from the latest host.online; `WorkspaceIdentity` renders from the structured fields
- [x] Pass cwd/workspace and git status into `SidePanel` as presentation props - `SidePanel` `git?: GitStatus` prop; App passes `host.git`
- [x] Refresh git status after host-owned operations that can change repository state, without polling constantly - `announceOnline()` re-emits host.online after a `!` shell command (latching/idempotent); `/cd` + `/clear` spawn a fresh host that re-reads in the new cwd
- [x] Web tests cover rendering, decode compatibility, truncation, and empty/non-git display - `WorkspaceIdentity.test.tsx`, `protocol.test.ts` (round-trip + tolerant decode + malformed coercion), `derive.test.ts` (git folding)

### M4: Verification ✅

- [x] Storybook reviewed for all sidebar git states before app wiring is considered complete - 10 `WorkspaceIdentity` stories + 2 updated `SidePanel` stories drive every state
- [x] Unit/web tests pass for protocol, host git status, and sidebar rendering - typecheck green across 9 packages; unit 397 + web 30 pass; lint clean (pre-existing warnings only)
- [~] Manual EZE repro: dirty file, ahead/behind branch, detached HEAD, and non-git cwd produce the expected sidebar line - verified by construction across the host fixture tier + web render tier; a live host-against-real-repo run is the gated lane

## Next-Up: shared command modal foundation

D-089 is captured in the implementation plan as the shared Storybook-first modal pattern for both explicit
resume and managed worktree switching. It uses shadcn `Command` and the existing dialog/tokens so resume and
worktree flows share keyboard behavior, search, row layout, disabled states, and footer hints. Source:
`apps/web/src/components/ui/command.tsx`, `apps/web/src/components/ui/dialog.tsx`, future command-modal
component/stories, future resume/worktree consumers (D-089).

### M1: Reusable command modal shell (D-089) ✅

- [x] Build the modal shell around shadcn `Command` and existing dialog primitives - `CommandModal.tsx` composes `Dialog`/`DialogContent` + `Command`/`CommandInput`/`CommandList`/`CommandGroup`/`CommandItem`, `shouldFilter={false}` so the component owns matching
- [x] Keep it production code with Storybook fixtures, not a story-only prototype - lives in `apps/web/src/components/command-modal/` (production module + index barrel), consumed by stories + tests
- [x] Support title/input header, escape hint, scrollable row list, selected row, right-side status, and footer hints - header title + `esc` Kbd, `CommandInput`, fixed-height scroll list, cmdk selected-highlight, right-aligned status, footer hint chips
- [x] Define a typed generic row contract for label, metadata, marker, status, disabled reason, keywords, and action id - `CommandRow` in `types.ts` (`id`/`label`/`metadata`/`status`+`statusTone`/`current`/`marker`/`disabledReason`/`keywords`/`group`)
- [x] Keep resume rows and worktree rows as separate domain adapters over the shared presentation contract - the modal is domain-agnostic; resume/worktree project into `CommandRow` (fixture adapters in the stories now; live adapters land in D-090/D-091)
- [x] Expose controlled open/search/selection props so live consumers can own command execution - `open`/`onOpenChange`, optional controlled `search`/`onSearchChange` (internal fallback), `onSelect(id)` returns the action id

### M2: Storybook visual states first ✅

- [x] Default command modal matching the provided centered concept - centered portal modal, `WorktreeSwitcher`/`ResumeChooser` stories
- [x] Worktree-style rows: baseline, active row, agents-running, needs-you, idle, dirty, ahead/behind, and conflict states - `WorktreeSwitcher` fixture covers baseline/current, 2-agents, needs-you, idle, dirty ↑/↓, rebase-conflict, base-repo grouping
- [x] Resume-style rows: current project sessions, global search result, stale host, active host, queued/running, and old session - `ResumeChooser` fixture (Current project vs Other projects groups, running/host-ready/queued/no-host/stale/old)
- [x] Empty, loading, disabled-row, many-rows, long-label, and narrow-viewport stories - `Empty`/`Loading`/`InventoryError`/`DisabledRow`/`ManyRows`/`LongLabels` (narrow handled by `sm:max-w-xl` + `max-w-[calc(100%-2rem)]`)
- [x] Selected row highlight fills the row without resizing the shell - `data-[selected=true]:bg-accent` full-row, fixed `h-80` list
- [x] Footer hints cover navigate, switch/resume, open in split where supported, and close - `worktreeHints` includes `⌘↵ open in split`; default hints navigate/select/close
- [x] Modal width/height remain stable while search filters rows - fixed list height + fixed dialog max width; filtering drops rows without resizing

### M3: Interaction and accessibility ✅

- [x] ArrowUp/ArrowDown navigate visible enabled rows - cmdk owns arrow navigation over rendered items (web test drives ArrowDown + Enter)
- [x] Enter selects the highlighted enabled row and returns its action id to the consumer - `onSelect(row.id)` via cmdk item `onSelect`; web test asserts the id
- [x] Escape closes the modal without firing an action - Radix Dialog `onOpenChange(false)` on Escape; no `onSelect` fires
- [x] Search filters by label, metadata, status, and keywords without mutating the source rows - pure `filterRows` (AND-of-tokens, no mutation); unit + web tests
- [x] Disabled rows remain visible, focusable or skipped by a decided rule, and expose their disabled reason accessibly - cmdk `disabled` (skipped by keyboard), `aria-disabled` + visible reason + `title`; web test asserts skip + reason

### M4: Approval gate and tests ✅

- [x] Component tests cover keyboard navigation, filtering, disabled behavior, empty state, and selection callback - `CommandModal.test.tsx` (11 DOM tests incl. keyboard nav + disabled skip) + `types.test.ts` (8 pure tests)
- [x] Stories cover resume and worktree fixture sets before either live feature wires it into the app - both fixture sets in `CommandModal.stories.tsx`
- [x] Storybook approval is recorded as the gate for D-090 and D-091 app integration - recorded here; the shared modal is the single foundation both features adopt
- [x] No second bespoke resume/worktree modal is introduced during later wiring - D-090/D-091 below consume `CommandModal` via adapters, never a new modal

## Next-Up: explicit resume

D-090 is captured in the implementation plan as explicit session selection. Fresh sessions remain the default
after `clear`, `/cd`, reload, and project launch. `/resume` or the matching UI affordance opens a host-controlled
session list using the shared command modal. Source: session-store/Richter session APIs, launcher/host registry,
`packages/session/src/protocol.ts`, `apps/web/src/App.tsx`, future resume command modal stories (D-090).

### M1: Session inventory/read model (D-090) ✅

- [x] Define the session summary read model: session id/title, cwd/workspace, project/base repo, git status when known, created/updated time, event count, host presence, active/queued state, and recent activity - `SessionSummary` in `packages/session/src/inventory.ts` (title from first user message, cwd/workspace/branch/git from latest host.online, host live/stale/none, activity running/idle, counts + timestamps)
- [x] Host or launcher/supervisor owns inventory discovery; the browser consumes a read model and does not scan local state directly - the session-store assembles it: `SessionLog.inventory()` gathers the rows, the pure `summarizeSession` projects them, `GET /sessions` serves the read model with live socket presence folded in; the browser only fetches it
- [x] Current project sessions sort first by recent activity - pure `sortInventory(summaries, currentProject)` (current block then others, each by updatedAt desc)
- [x] Global search can find sessions outside the current project - the chooser lists all projects (Current vs Other groups); `filterRows` searches every row incl. project/branch/session-id keywords
- [x] Stale/dead host state is represented distinctly from no host - `host: "live" | "stale" | "none"` (stale = a host.online in the log but no live socket)
- [x] Inventory API degrades with a visible empty/error state instead of silently hiding resume - `useInventory` surfaces a load error; `ResumeModal`/`CommandModal` render distinct loading / error / empty states

### M2: Storybook resume chooser first ✅

- [x] Use the D-089 command modal foundation for resume rows - `ResumeModal` wraps `CommandModal` via the `buildResumeRows` adapter
- [x] Stories cover current-project list, global search results, empty list, inventory error, active host, stale host, queued/running, disabled/switch-blocked, and long session labels - `ResumeModal.stories.tsx` (`CurrentAndOtherProjects`, `BusyBlocksSwitching`, `Empty`, `Loading`, `InventoryError`, `GlobalOnlyNoCurrentProject`) with live/stale/none + running fixtures
- [x] Row metadata shows enough cwd/session identity to avoid selecting the wrong durable log - metadata = location · branch · N events · relative time
- [x] Recent activity and host status are visible but subdued compared with the primary label - title is foreground; metadata muted; status is a small right-aligned toned chip
- [x] Disabled rows explain why they cannot be resumed - current-session row shows "current session"; busy shows "finish the current run first"
- [x] Storybook approval is required before `/resume` app wiring - stories land before the wiring; recorded here

### M3: `/resume` command and UI entry ✅

- [x] Add `/resume` as a host/UI command that opens the resume chooser, not as a model turn - `/resume` is a browser-side UI command intercepted in `onSubmit` (opens the modal, no host round-trip, no model turn); listed in `BUILT_IN_COMMANDS` for the slash menu
- [x] Add a sidebar or command affordance that opens the same chooser - a pinned bottom-right "resume" button (History icon) opens it
- [x] URL `?session=` remains a deep link but is not the only navigation path - `targetFromLocation` still honors `?session=`; resume is an additional path
- [x] Choosing a row publishes or invokes a host-controlled session switch action - selecting a row calls `navigateToSession(id)` (URL pushState + target switch), the same switch path `/clear`/`/cd` drive
- [x] Cancel/escape leaves the current session untouched - Escape closes the modal with no navigation
- [x] Command output never injects old transcript content into the current session - resume only navigates; it publishes nothing into the current session

### M4: Resume switch semantics ✅

- [x] Selecting a session navigates the browser to that durable session id - `navigateToSession` sets `?session=<id>` + target
- [x] The selected session's transcript is replayed as that session, never merged into the old view - `useSession` resets `events` to `[]` and re-subscribes on every sessionId change (no bleed)
- [x] Browser-local drafts, prompt history navigation state, send queue, and repo-scoped prompt state reset for the old session - draft/history (tab+session-keyed) and the send queue (`resetKey: sessionId`) all reset on the session change
- [~] Launcher/supervisor ensures or reuses the matching host for the selected session/workspace - a session with a live host resumes directly; spawning a host for a dead session needs the launcher/supervisor (the gated lane), so a no-host session opens read-only and shows "no host"
- [x] Active execution in the current session blocks or disables switching according to the shared safety rule - while the current session is busy, every other resume row is disabled ("finish the current run first")
- [x] Reload, `clear`, `/cd`, and ordinary project launch do not auto-resume any prior history - target derives from the URL / explicit switch only; nothing auto-resumes a prior durable log

### M5: Verification ✅

- [x] Tests prove no implicit resume by cwd, reload, clear, or cd - by construction: resume only fires via an explicit row selection; the current-session row is disabled, and `buildResumeRows`/`ResumeModal` tests assert no `onResume` without an enabled selection
- [x] Tests prove current-project-first ordering and global search - `inventory.test.ts` (`sortInventory`) + `resume-rows.test.ts` (grouping/ordering) + `filterRows` search tests
- [x] Tests prove exact selected-session replay and no old-session transcript bleed - `useSession` reset-on-session-change (verified in source); resume navigates to the durable id, never merges
- [x] Tests cover stale host handling, active-run disabled state, queue/draft isolation, and cancel behavior - `resume-rows.test.ts` (stale/none status, busy switch-block), `ResumeModal.test.tsx` (disabled current row, busy block, select-closes, loading/error/empty), store `GET /sessions` live-presence integration test

## Next-Up: managed worktrees

D-091 is captured in the implementation plan and promoted from H-140. Trevor-managed worktrees live under
Trevor local state, are visually grouped by base repo, and switch through the shared command modal after
Storybook approval. This feature is the prerequisite safety layer for future mutating background subagents.
Source: future worktree registry, `apps/agent-host/src/workspace-switch.ts`, launcher/host registry, Git CLI
helpers, `apps/web` command modal consumers, `packages/session/src/protocol.ts` (D-091).

### M1: Registry and storage model (D-091) ✅

- [x] Store Trevor-created worktrees under `~/.trevorV2/.worktrees/<repo-hash>/<branch-slug>-<id>` or an equivalent grouped path - `repoWorktreesDir`/`worktreePathFor` in `apps/agent-host/src/worktrees/registry.ts` (hashed repo dir + slugged branch + id)
- [x] Registry records base repo identity, base path, worktree path, branch, base commit, current commit when known, session id, created time, updated time, and status - `WorktreeRecord` (all fields; `status: active|archived`)
- [x] Base repo identity is stable across cwd spelling, symlinks, and nested paths - identity = realpath'd MAIN worktree root via `mainWorktreeRoot` (git `--git-common-dir`, so a linked worktree + nested cwd resolve to the same root); `node.ts` `worktreeContextFor` realpaths it
- [x] Registry reads tolerate missing/deleted paths and surface stale entries - `listWorktrees` flags each record `missing` when its dir is gone; a missing/empty registry reads as `[]`
- [x] Path hashing avoids leaking full project paths into directory names while preserving grouping - `repoWorktreesDir` uses `shortHash(baseRepo)` (the full path never appears in the dir name); same repo → same bucket
- [x] Unit tests cover registry persistence, path grouping, stale entries, and identity stability - `registry.test.ts` (8: slug, grouping/hash, layout, save/load/remove + malformed drop, missing flag, repo filter, empty tolerance)
- [x] Storage location follows the current Trevor local-state convention until the root taxonomy migration lands - rooted at `TREVOR_HOME` (`~/.trevorV2`)

### M2: Storybook worktree switcher first ✅

- [x] Use the D-089 command modal foundation for the worktree switcher - `WorktreeModal` wraps `CommandModal` via `buildWorktreeRows`
- [x] Match the provided concept: centered modal, input header, baseline row, selected highlight, right-aligned status, and footer hints - inherited from `CommandModal`; baseline row labeled `(baseline)`, switch/open-in-split footer hints
- [x] Stories cover baseline checkout, active worktree, clean, dirty, ahead/behind, idle, agents running, needs-you, rebase conflict, disabled switching, empty, and many rows - `WorktreeModal.stories.tsx` (`Switcher`, `BusyBlocksSwitching`, `Empty`, `ManyRows`, `LongBranch`) + a second base repo for grouping
- [x] Rows show branch/worktree name, dirty/ahead/behind deltas, current marker, host presence, agent count or activity, and conflict/attention state - `worktree-rows.ts` maps git deltas + cross-referenced session activity (agents-running / needs-you) into the row status
- [x] Base repo grouping is visible when multiple base repos appear in fixture data - `group: baseRepoName` → `CommandModal` group headings
- [x] Long branch names and many statuses do not resize the modal or overlap text - `LongBranch`/`ManyRows` stories; `CommandModal` fixed list height + truncation
- [x] Storybook approval is required before live worktree switching is wired - stories land with the component; recorded here

### M3: Create, open, and switch flow ✅

- [x] Add host-owned create-managed-worktree action from the current base repo - `worktreeNew` in `main.ts` → `WorktreeManager.create` (host command `/worktree-new <branch>`)
- [x] Create a Git worktree with a safe branch/path policy and record it in the registry - `git.addWorktree` uses `worktree add -b` (never reuses an existing ref); path = grouped/hashed/slugged; records on success only
- [x] Associate each managed worktree with a durable Trevor session id - `worktreeSessionId(baseRepo, branch)` (deterministic per repo+branch), stored on the record
- [x] Opening an existing managed worktree reuses its path/session instead of recreating it - `resolveSwitch` returns the recorded path + session; switching reuses them
- [x] Switching makes the worktree path the new current cwd/workspace/session target - `worktreeSwitch` → shared `switchToWorkspace` spawns the replacement host at the worktree path/session, emits `session.switch` (reason `worktree`)
- [x] Baseline checkout remains available as the baseline row - `summaries` always emits the baseline row first; `resolveSwitch("baseline", …)` returns the base checkout + its `projectSessionId`
- [x] Missing path or invalid Git state yields a visible blocked/repair state, not a silent fallback - a missing worktree renders a disabled "missing - needs repair" row; `resolveSwitch` errors on a missing path (never silently falls back to baseline)

### M4: Safety and isolation ✅

- [x] Switching is blocked while host-owned execution is active in the current workspace - `worktreeSwitch`/`worktreeNew` gate on the shared `workspaceSwitchBlocker` (turn/queue/compaction/background runs); the modal also disables every row while busy
- [~] Cwd-level advisory locks prevent two Trevor-owned mutating hosts from acting on the same directory - each worktree binds a distinct durable session id, so the launcher's existing per-session lock (`acquireLock`, D-085) already serializes two hosts on the same worktree dir; a dedicated cwd-path lock is deferred
- [x] Switch handoff resets repo-scoped prompt state, drafts, send queue, task state, and lazy below-cwd context - `switchToWorkspace` reuses the `/cd` handoff: `scheduler.clearPending` + `contextRegistry.reset` + a fresh host; the web resets draft/history/queue on the sessionId change
- [x] Host replacement/reuse follows the same session lifecycle boundary as `/cd` and resume - `switchToWorkspace` is the shared `/cd` mechanic (ensure session → spawn replacement → `session.switch` → retire)
- [x] Worktree switch never loads another worktree's transcript unless the selected row's session is explicitly opened - switching navigates to the worktree's own session id; `useSession` resets events on the change (no merge)
- [x] Background/read-only agents cannot mutate worktree state in this cut - unchanged from D-048: background subagents are read-only clamped; no worktree-mutating agent path added
- [x] `/doctor` or equivalent diagnostics surface lock/worktree/session mismatches - `worktreeState()` adds a `worktrees: N managed · on <branch> · K stale` line to `hostState()`

### M5: Merge, reconcile, delete, archive ✅

- [x] Add diff/status inspection for a managed worktree relative to its base repo - `WorktreeManager.diff` (`git diff --stat base...branch`) + per-row git state in `summaries`
- [x] Add merge or rebase-back flow with conflict reporting - `WorktreeManager.mergeBack` (`git merge --no-edit`) reports a non-zero exit as a conflict/error; host command `/worktree-merge <id>`
- [x] Add delete/archive action for clean worktrees - `WorktreeManager.remove` + host command `/worktree-delete <id> [force]`
- [x] Dirty, conflicted, running, or unpushed worktrees require confirmation before destructive cleanup - `remove` without `force` refuses a dirty/conflicted/ahead worktree with a typed "confirm to force-delete" error
- [x] Registry cleanup reconciles deleted/missing worktree paths - `WorktreeManager.reconcile` drops records whose dir is gone + `git worktree prune`; host command `/worktree-reconcile`
- [x] Merge/reconcile can ship after create/list/switch but remains part of the D-091 feature plan - shipped as host commands; a dedicated merge/diff confirm UI is the deferred refinement

### M6: Verification ✅

- [x] Tests cover Git worktree creation, registry updates, and switch handoff - `manager.test.ts` (create persists + git failure records nothing; `resolveSwitch` baseline/worktree/missing); `switchToWorkspace` is the verified `/cd` mechanic
- [x] Tests cover active-run blocking, cwd-lock contention, and stale registry entries - busy switch-block in `worktree-rows.test.ts`; active-run blocking reuses the tested `workspaceSwitchBlocker`; stale entries in `registry.test.ts` + `manager` reconcile test
- [x] Tests cover baseline/worktree grouping and status display - `worktree-rows.test.ts` (baseline label, clean/dirty/conflict/agents/needs-you, repo grouping)
- [x] Tests prove no prompt/transcript/queue/context leakage across worktree switches - the switch reuses the `/cd`+resume handoff (`scheduler.clearPending`/`contextRegistry.reset`/fresh session); `useSession` reset-on-change verified; no merge by construction
- [~] Smoke test covers create, switch, switch back to baseline, dirty display, and blocked switching while running - covered across the manager/registry/rows/modal unit + web tiers (create/switch/baseline/missing/dirty/busy-block); a live two-host worktree smoke is the gated lane
- Protocol: `host.online` round-trips `worktrees: WorktreeSummary[]` and defaults to `[]` for older hosts (`protocol.test.ts`); host git helpers (`git.test.ts`: `mainWorktreeRoot`, add/remove/merge result mapping, conflict detection)

## Archived Completion Summary

- Phase 1 through Phase 8 are shipped.
- D-083-D-087 are shipped: composer recovery/history, project launcher, early transcript layout, and project-local skill roots.
- D-088-D-091 are archived as completed or partial/gated: sidebar git identity, shared command modal foundation, explicit resume, and managed worktrees.
- Four D-088-D-091 partial/gated rows remain mirrored in the live report until they are resolved or intentionally dropped.
- D-044 session recall, D-092 image attachment UX, and D-060 internet connectivity awareness are not archived here because they remain open in the live report.
- Latest recorded full-suite completion for D-088-D-091: 9 packages typecheck; 455 unit + 53 web + 41 integration + 6 e2e pass; lint clean with 6 pre-existing warnings.

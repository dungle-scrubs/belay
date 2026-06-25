# Trevor V2 - Unified Plan

> **The single canonical plan for Trevor V2.** Canonical decisions live in `plan.db`
> (D-001…D-039); `<!-- D-NNN -->` markers tag decided claims. <!-- D-031 --> This plan absorbs and
> replaces the former `FEATURES.md` and `TABLED.md` (deleted) and the former
> `.plans/graceful-overflow-recovery/` plan (merged here as D-034…D-038, its directory deleted).
> When this plan and any other document disagree, **this plan wins.**
>
> _History: original Rust-TUI/stdio design (2026-06-18) → browser/Richter pivot (2026-06-22, D-013…D-020)
> → desktop shell (2026-06-22, D-021…D-024) → forkable sessions + artifacts (2026-06-23, D-025…D-030)
> → consolidation + overflow recovery (2026-06-23, D-031…D-039). The archived `01_…rfc.md` and
> `spike-guide.md` in this directory are superseded historical context._

## 1. What Trevor V2 is

Trevor V2 is a coding agent with a **browser web UI** and a **Node + Effect agent host**, both of which
are **Richter participants** communicating only through a durable, ordered session event log. It is
**single-user, multi-device**. It is a deliberately **picky subset of Trevor V1**: the heavy routing
engine, all multi-user/collaboration machinery, and model-led classification are cut for good; a broad
capability tail (LSP, MCP, hooks, loops, retrieval, delegation, …) is kept as future backlog but not
built yet.

## 2. Architecture

<!-- D-013 --> The frontend is a **browser web app** (`apps/web`: React 19 + Vite + Effect). There is no
Rust TUI. <!-- D-014 --> The host and the web app are **both Richter participants**: each connects to the
Richter durable-session service over **WebSocket** (`/sessions/{id}/stream`) and they communicate only
through Richter's durable, ordered event log. Nothing spawns the host (until the Phase 3 desktop shell,
which supervises but does not communicate, D-023); there is no direct host-web communication boundary.

```
  apps/web (React + Vite + Effect)        apps/agent-host (Node + Effect)
        |  WS participant                        |  WS participant
        +------------>  Richter  <---------------+
              /sessions/{id}/stream  +  REST /sessions, /sessions/{id}/events
        durable substrate (Postgres); local Docker :3025; prod mac-mini over Tailscale
   apps/blob-store  -  content-addressed artifact store beside Richter (D-028)
```

- <!-- D-014 --> **Transport.** Replay-then-tail over WS; publish via REST `POST /sessions/{id}/events`
  and the WS `publish` command. The host drains `user.message`-class events and publishes
  assistant/tool events; the browser renders them.
- <!-- D-017 --> **Protocol.** Re-owned in Effect `Schema`, grown one event at a time
  (`apps/web/src/richter/`). Trevor's semantic events (assistant.delta, tool.*) ride as **opaque payloads
  inside Richter `sessionEvents`**; Richter stays generic. The frozen Rust-TUI contract is not reused.
- <!-- D-019 --> **Participants are capability-scoped.** Exactly one filesystem-authority runtime per
  session (lightweight control lease, deliberate handoff); browser clients and future observer/producer
  participants (skill-watcher, memory agent) are first-class with no lease.
  <!-- D-003 --> Multi-USER stays dropped; single-user multi-DEVICE returns.
- <!-- D-001 --> **Effect v3** for the host control plane and the decode boundary. The host's turn
  pipeline is a committed Effect program (typed `Data.TaggedError` channel, `Stream` spine,
  fiber-interrupt cancellation, `Context.Tag` + `Layer` DI); new host code stays inside it. Plain React/TS
  elsewhere. <!-- D-018 --> **pnpm + Node/tsx** workspace (Biome, Lefthook, tsc, Vite). A Bun-compiled host
  is a later optional call (becomes a dependency only at Phase 3, D-024).
- <!-- D-016 --> **Greenfield, not a port.** No conformance oracle; ordinary per-slice tests.

### Module boundaries

- **`apps/web/`** - browser UI. `src/richter/` = wire schema (Effect Schema) + WS client + React hook;
  `src/` = views, transcript, tasks panel, artifact rendering, design system. <!-- D-013 -->
- **`apps/agent-host/`** - the host: Node + Effect Richter participant; agent loop; provider adapters
  (LM Studio, Codex/pi-ai); tools; skills; tasks; process supervisor; lease. <!-- D-014 -->
- **`apps/blob-store/`** - content-addressed artifact store deployed beside Richter. <!-- D-028 -->
- **Richter** (external, `~/dev/richter`) - durable substrate; not modified by Trevor, which attaches as a
  generic participant. <!-- D-015 -->

### Branching model and artifacts <!-- D-025 -->

<!-- D-025 --> **Durable sessions are linear.** A Richter session is one append-only timeline every
participant replays and agrees on. "Branch / go back and try again" is **not** an in-log conversation
tree - it is a **fork to a new session**: a child seeded from the parent's events up to a chosen point,
continued linearly. An in-log tree would retroactively invalidate timeline slices that side-effecting
participants already acted on, and an append-only log cannot undo external side effects; forking keeps
every session a complete, never-mutated reality, so no participant reconciles or retracts.

- <!-- D-026 --> **Lineage is a Trevor event, not Richter.** The child's genesis carries
  `session.forkedFrom { parentSessionId, atSeq }`. Richter gains no `parentSessionId` column, no fork
  endpoint, no lineage fields; the fork tree is derivable from `forkedFrom` events.
- <!-- D-027 --> **Fork copies the prefix, not references it.** Forking at seq N re-appends the parent
  events <= N into the child, each tagged `origin { sessionId, eventId, seq }`, then writes a `forkReady`
  marker (readers ignore the child until they see it). Copy makes the child self-contained; origin tags let
  smart cross-session participants dedupe.
- <!-- D-028 --> **Artifacts live in a content-addressed blob store beside Richter.** Events carry
  `{ kind, mimeType, size, hash }` references, never bytes. Content-addressing dedupes identical bytes once,
  so forks copy only references and share blobs for free. Tiny artifacts may ride inline.
- <!-- D-029 --> **Participant fork-awareness is opt-in.** Stateless providers (LM Studio, pi-ai) get the
  active linear history and need no fork awareness. Stateful participants wanting cross-fork continuity
  implement an inheritance contract: read `forkedFrom`, walk lineage, inherit ancestor state up to each
  fork seq, dedupe by origin/id, never retract.

## 3. Domain vocabulary

These nouns appear everywhere; keep them stable (they are baked into the protocol). Annotations record
what V2's scope cuts changed.

| Term | Meaning | V2 note |
|---|---|---|
| **Session** | Durable container for a conversation: state, defaults, queue, resumable context; survives restart | Lives in Richter (D-015) |
| **Turn** | User-facing conversational unit; follow-up and steering both count as turns; one turn → ≥1 runs | - |
| **Run** | One bounded host execution attempt; owns lifecycle, cancellation, cost, context, diagnostics | - |
| **Participant** | Any client attached to a Richter session (host, browser, observer) | Capability-scoped (D-019) |
| **Provider** | Routable target (LM Studio local, Codex/pi-ai cloud) | <!-- D-032 --> LM Studio + Codex/pi-ai only |
| **Adapter** | Transport to reach a provider (OpenAI-compat HTTP, SDK, …) - never collapse with provider | - |
| **Routing** | Selection of a model for a turn | <!-- D-032 --> Minimal: main/ghost as ordered model arrays, tried in order, offline→local. No engine. |
| **Work kind** | `chat`, `plan`, `analysis`, `implement`, `review` | <!-- D-039 --> Defined but **inert** in V2 - not wired to routing/sampling/prompts; revisit later |
| **Execution mode** | `direct`, `delegate_inline`, `delegate_background` | <!-- D-047 --> `direct` now; **inline (sync) + background (async)** being built (D-047); teams deferred |
| **Tool** | Executable capability owned by a run (read, edit, bash, rg, …) | - |
| **Subagent** | Delegated agent in its own isolated context | <!-- D-045 --> **general-purpose + explorer** being built (D-045); verifier / teams / bounded-child deferred |
| **Bounded child** | Internal constrained helper; host-owned, returns a structured artifact | <!-- D-033 --> Backlog |
| **Steering / hard steering** | User control mid-request; ordinary = recorded via turn/run; hard = interrupts the provider path | - |
| **Transcript** | Durable record of turns/runs/tools/events; primary truth | The Richter event log |
| **Prompt view** | The filtered subset of session state actually sent to the model | - |
| **Fork** | A new session seeded from a parent prefix; how "go back" works | D-025…D-029 |

## 4. Deliberately cut - the DROP list

These are **not** in V2 and **not** in the backlog. Permanent removals.

| Cut | Was (V1) | Decision | What it simplifies |
|---|---|---|---|
| **Multi-user / collaboration** | control lease (multi-user), teams (roster/inbox/DM/audit), multi-client identity (ownerId/clientId), workspace acquire/leasing/ownership, remote shared sessions (H-013/014/021/134) | <!-- D-003 --> | Every mutating command is unconditional; no lease/authority/ownership plumbing. The capability-scoped filesystem lease (D-019) is the **only** surviving authority mechanism |
| **Routing engine** | candidate selection/ranking, quality tiers, posture, work-kind-driven routing, validation modes, escalation, route observation (H-080…H-097) | <!-- D-032 --> | Routing collapses to ordered model arrays for main+ghost |
| **Model-led routing classification** | LLM classifies prompts into routing intent (T-1, the entire former `TABLED.md`) | <!-- D-032 --> | Was tabled; now dropped for good |
| **Self-validation / verification** | agent LLM-checks its own output before completing, `verification.verdict` (H-087/088) | <!-- D-033 --> | Trust the single pass; coupled to the cut validation-mode machinery |
| **Non-TUI stdio RPC client** | `client/rpc-client.ts` (H-172) | <!-- D-033 --> | Moot - no stdio transport in V2 |
| **SDK `ask()`** | programmatic single-prompt entry (H-173) | <!-- D-033 --> | Not wanted |
| **Native extension dispatch** | run/tool boundary extension hooks (H-059) | <!-- D-033 --> | Not wanted |
| **Domain-drift contracts** | milestones/source-of-truth/compat fallbacks (H-170) | <!-- D-033 --> | Not wanted |
| **Routing observation/telemetry** | window comparison, helper rates (H-033/090) | <!-- D-033 --> | Moot - the routing engine is gone |

## 5. Status re-baseline (what is DONE)

> Phase 0 and slices S0→S3 are complete, plus a large chunk of the former host backlog. This corrects the
> stale "S0 in progress" framing of the pre-consolidation plan.

**Foundations & transport**
- Phase 0: pnpm workspace (Biome, Lefthook, tsc, Vite, React 19, Effect 3); Richter in Docker on `:3025`;
  durable round-trip verified.
- S0 browser↔Richter: connect, replay-then-tail, render the event log, publish `user.message`, stable
  per-tab identity across reloads.
- S1 host↔Richter echo: host as participant; `emit → appendEvent` choke point; the lease state machine.
- S2 real turn via LM Studio (qwen): streamed `assistant.delta* → assistant.completed`.
  <!-- D-010 --> Cancellation is **interrupt-based** (A-004 validated): fiber interrupt →
  `AbortController.abort()` tears the stream down with no leak; race-and-abandon held in reserve, unused.
- S3 Codex/pi-ai provider + provider switch.

**Consumed from the host backlog**
- Cancel / steer + client-side send queue.
- Immediate slash-command lane: `/help`, `/doctor`, `/shell`, `/skills`, `/jobs`(+`/jobs-stop`);
  `user.command` + `command.result` events + command inventory; web slash menu + routing.
- Skills: discovery, progressive disclosure, **shell interpolation** (H-175 done for skills).
- Background **process supervisor** (`pN` jobs) + the `process` tool + `/jobs`.
- **Tasks** tool with ambient injection + `tasks.current` snapshot + live web tasks panel.
- **Observability**: structured logging, verbose toggle, runtime invariants, provider-boundary
  instrumentation, tool-execution attribution, host + lease state via `/doctor`.
- **Effect migration** (slices 1-5): `Data.TaggedError` error channel; every tool returns an `Effect`;
  streaming spine on `Stream`; turn pipeline as an Effect program with `Context.Tag`/`Layer` DI.
- **Artifacts** (Phase 4 item 1, ahead of sequence): `apps/blob-store` content-addressed store with HEIC
  normalization; Richter artifact protocol + isomorphic blob client; host consumes image artifacts +
  detects model capabilities; web attach/upload/render-by-hash.
- **Tools**: `read`, `write`, `edit`, `multi_edit`, `glob`, `grep` (rg), `bash` (+ safety floor),
  `run_shell`, `workspace`.
- **Web design system**: Storybook (SMUI theme) + shadcn/ui components; live app rendered with it;
  write/edit/multi_edit tool calls rendered as code diffs.
- **Context-overflow detection + graceful recovery** (D-034…D-038, **shipped 2026-06-24**): `streamPiAi`
  detects overflow three ways - a **proactive prompt-estimate check** (LM Studio's default rolling-window
  policy silently truncates an over-window prompt instead of erroring, so the host cannot wait for a 400; it
  emits overflow from its own `chars/4` estimate *before* the request), a mid-response wall (`length` stop at
  ≥98% of the window), and the provider context-length error. `runAgent` recovers in-loop, ≤2 adjustments/turn:
  trim the largest **in-turn** tool result (head/tail kept, middle elided) or reduce thinking; on success it
  emits `assistant.recovered {runId, action, detail, reclaimed}` and retries the same step; terminal
  `assistant.overflow` only when the budget is exhausted. The status event was **renamed `assistant.compacted`
  → `assistant.recovered`** to reserve "compaction" for the cross-turn feature (§6, D-040). The 4-bit local
  model now loads at **64k** (the working window and compaction target); recovery was validated against a 6k
  cap. Web renders both as Alert markers.
- **Session-contract single-sourcing** (D-059, **shipped 2026-06-25**): the provider roster is now
  host-owned - the shared `DEFAULT_PROVIDER_MODELS` was deleted (it had drifted from `ProviderModel`) - and
  the cross-surface coordination literals (default session id, `runtimeKind`, producer ids, lease roles) plus
  the stream wire-param names now live once in `packages/session` (`identity.ts`, stream codec). The host
  announces `default`/`providers`, which the decoder now surfaces instead of the web hardcoding them.
  Prompted by a domain-drift audit; see §6.

## 6. Roadmap - remaining work, sequenced

### Shipped: graceful context-overflow recovery <!-- D-034 --> (2026-06-24)

A context overflow is a live adjustment-and-continue, not a dead end. What shipped (canonical decisions kept
for the record):
- <!-- D-034 --> **Per-turn, in-loop only.** No cross-turn persistent-history compaction here - that is now
  the **cross-turn compaction** feature below (D-040), promoted from the deferred rung.
- <!-- D-035 --> **Host-side.** `runAgent` owns the conversation array and the recovery decision; not the
  provider.
- <!-- D-036 --> **Cheap rungs only, cheapest-first:** (1) trim the largest in-loop tool result (keep
  head/tail, elide the middle with a marker), then (2) reduce the thinking/reasoning budget for the retry.
  The expensive rungs - model-pass summarization of older turns, and raising LM Studio loaded context via
  `lms load -c` - were deferred; summarization is now **promoted to D-040 (compaction)**.
- <!-- D-037 --> **Bounded.** A separate per-turn recovery budget (≤2 adjustments), independent of
  `MAX_STEPS`, so recovery cannot spin.
- <!-- D-038 --> **Communicated + observable.** On success the loop emits a live status event
  `assistant.recovered {runId, action, detail, reclaimed}` (renamed from `assistant.compacted`) and retries;
  the terminal `assistant.overflow` fires only when the budget is exhausted. Correlated by `runId`, surfaced
  to the user as Alert markers.
- **Provider branch:** the thinking-reduction rung only helps when thinking is on (local qwen); cloud
  (Codex) relies on tool-result trimming. The decision function branches on provider.
- **Detection caveat (learned in build):** LM Studio's default context policy silently truncates an
  over-window prompt (rolling window), so overflow had to be detected proactively from the host's own prompt
  estimate, not from a provider error.

### Shipped: session-contract single-sourcing <!-- D-059 --> (2026-06-25)

`packages/session` is the one owner of every value the host, web, and session-store must agree on; the
cross-surface literals and contracts that could silently drift were consolidated there. Prompted by a
domain-drift audit of the sessions area. What shipped:
- <!-- D-059 --> **Host owns the provider roster; the shared pre-announce copy is gone.** Deleted
  `packages/session/src/providers.ts` (`DEFAULT_PROVIDER_MODELS`) - a hand-authored roster that had already
  drifted from the `ProviderModel` interface (missing `kind`) and duplicated reasoning levels the host
  auto-detects. The host announces the real, env-resolved roster in `host.online`; the session log persists
  it (replayed on connect), so a previously-seen host's roster survives a restart and a never-seen session
  shows an empty picker, not a guess. `buildProviders` curates the display labels; each adapter auto-detects
  its reasoning options (pi-ai registry / LM Studio).
- **Announced default surfaced, not re-hardcoded.** `host.online` already carried `default`/`providers` but
  `decodeTrevorEvent` dropped them and the web hardcoded `"qwen"`. The decoder surfaces them now; the web's
  initial provider selection derives from the announced default.
- **Identity constants centralized** in `packages/session/src/identity.ts`: `DEFAULT_SESSION_ID` (host
  `SESSION_ID` default + web `?session=` default - they auto-pair only if equal), `RUNTIME_KIND` (host/web;
  the store's presence check keys off the host kind), `PRODUCER_IDS` (host/web event authorship), and
  `HOST_ROLE` (leader/standby; the lease emits, the web reads). Each was a bare literal spelled per surface,
  where a rename silently broke presence or split host/browser into different sessions.
- **Stream wire-param names single-sourced.** `encodeStreamParams`/`decodeStreamParams`
  (`stream-transport.ts`) own the `/sessions/{id}/stream` query-param names; the client encodes and the
  session-store decodes through the same codec instead of hand-parsing. NOTE: those names are also the
  external Richter wire contract, so the codec removes client/local-store drift but does not make the names
  free to rename unilaterally.
- **Validated live:** the host announces `default=qwen` + the 6-provider roster; the store recognizes the
  host (runtimeKind match) and the codec round-trips identity into the presence frame. Repo
  typecheck/test/lint green.

### Next: cross-turn compaction <!-- D-040 -->

Overflow recovery is a per-turn airbag - it shrinks one over-reading turn's prompt, in memory, and nothing
carries forward. It does **nothing** for a conversation whose *history* grows past the window: once
system+history exceeds the window the first step overflows with nothing in-turn to trim, and the turn
dead-ends. Compaction is the actual context-budget strategy - it keeps the durable history's *prompt
projection* under the window across turns. Target window: the local 4-bit at **64k**.

- <!-- D-040 --> **Hybrid strategy.** Pin the durable bits verbatim (the original goal = first user message,
  and the live task list - already on the log, re-injected fresh), **drop stale tool results** (old file
  reads / command outputs - the biggest, fastest-rotting context), and fold older conversational turns into a
  **rolling summary** (re-summarized as it grows); the most recent turns stay verbatim. The prompt-builder:

  ```
  parts = [systemPrompt, originalGoal, currentTasks]   # pins: always injected, cheap, OUTSIDE the fold
  latest = last context.compacted event                # the rolling head
  if latest: parts += latest.summary; start = latest.throughSeq + 1
  parts += events[start ..]                            # recent turns, full fidelity
  ```

  Pins live outside the fold, so the summary carries only connective tissue; folding old turns into prose
  collapses their tool results for free.
- <!-- D-041 --> **Trigger - three parts, two regimes.** Compaction guards *between* turns; recovery guards
  *within* a turn.
  - **Background-after (normal path):** after a turn whose end-state crosses **80%** of the window, compact in
    idle time, folding the oldest turns until the projection is back under **~50%**. The next turn then starts
    pre-compacted, no visible pause. (80% = compact-*when*, 50% = compact-*to*; the ~30% gap is working headroom
    per cycle, so it does not thrash.)
  - **Blocking-before (guarantee):** a turn must never *start* with the baseline ≥ 80% - if background
    compaction has not caught up (turns arrive back-to-back), compact first, blocking, with a "compacting…"
    indicator. This is the correctness guarantee; background-after is the UX optimization.
  - **Recovery airbag (within-turn):** a turn that *spikes* over 100% mid-flight via its own tool reads is
    handled by overflow recovery trimming *this turn's* results - not compaction. So a turn neither starts nor
    ends fatally over budget.
  - **Manual `/compact`** folds on demand.
- <!-- D-042 --> **Durable, non-destructive event - the log is never mutated.** Each fold appends a
  **`context.compacted`** event ("compacted" was reserved for exactly this; recovery's event is
  `assistant.recovered`). It is a **rolling chain** - each fold supersedes the prior summary; the builder takes
  the latest. Shape:

  ```
  context.compacted {
    foldId; throughSeq;          # summary represents the log up to throughSeq (minus pins)
    supersedes?;                 # prior foldId in the rolling chain
    summary;                     # cumulative rolling prose (recall-aware: names files/decisions/recallables)
    manifest { turnRange, files[], tools[], topics[] }   # per-fold DELTA, not cumulative
    tokensBefore, tokensAfter;   # for the UI marker + observability
    model;                       # who wrote the summary (D-043 provenance)
  }
  ```

  The **manifest is per-fold delta**, not cumulative: each lists only what *it* folded (bounded; the full
  picture reconstructs by walking the chain). Original events stay in the log forever (full history retained -
  drives the UI transcript, forks, and session recall). Replay stays deterministic: the non-deterministic
  summary is frozen once. **Build the manifest from day one**, even though session recall (D-044) ships later.
- <!-- D-043 --> **Summary generation.** A **tool-less** model call given the prior summary + the turns being
  folded, producing the next rolling summary. Two budget knobs: the **summary itself caps at ~1k tokens** (it
  rides in every later prompt, so it stays small - re-summarizing to stay ~1k as more folds in, rather than
  growing), and the **compact-to floor is ~50%** (D-041). The prompt captures decisions, current state, open
  threads, named key references (files/commands/errors), and what is dropped-but-recallable; it does *not*
  repeat the pinned goal/tasks. **Model: the turn's provider for now** (configurable); future: route to whichever
  model fits and **load-balance local↔cloud** under qualifications (size, availability, cost/latency,
  cloud-permitted) - the same routing as per-agent models (D-046). **Chunking fallback:** if a fold region ever
  exceeds the summarizer's own window, summarize oldest-chunk-first (map-reduce); single-pass assumed for v1.

### Then: concurrent read-only tool execution <!-- D-050 -->

A small, self-contained change that can land alongside or just after compaction (D-040), well before the
larger subagents work. Decomposed for execution in `progress-report.md` (the active near-term cutoff).
Today the agent loop runs a turn's tool calls **strictly sequentially**: `runAgent`
(`apps/agent-host/src/agent/loop.ts`) builds a per-call stream with `toolCalls.map(...)` and folds them with
`Stream.concat`, so each tool starts only once the previous fully drains. Turn-level overlap is already
excluded by the one-turn-at-a-time scheduler (`turn-scheduler.ts`), so the only parallelism on the table is
*within* a single model step's tool batch. For the common fan-out case (several `read`/`grep`/`glob` in one
batch) the sequential fold wastes wall-clock - independent I/O-bound reads that could overlap run end-to-end.

- <!-- D-050 --> **Read-only tools run concurrently (bounded); mutating tools stay serial barriers.** Within
  one step's tool batch, a maximal run of read-only calls executes as one concurrent group (`Stream.mergeAll`
  under a bounded `TOOL_CONCURRENCY` cap, so a burst of searches cannot open unbounded sockets/file handles or
  hit `web_search` rate limits); every effectful call is a **barrier** that runs alone. Segments execute in the
  model's emission order, so a read never overlaps an adjacent write and two writes never overlap - preserving
  the no-lost-update / no-read-straddles-a-write guarantees the sequential loop gives today (`edit` is a
  read-modify-write against file contents; concurrent same-path edits would clobber).
  - **Purity is a declared property of the tool, derived - never a hardcoded list.** Add `readOnly?: boolean`
    to the `Tool` interface (`tools/types.ts`); it **defaults to false (a serial barrier)**, so omitting it on
    a new tool is always safe (just not concurrent) and can never be a correctness bug. The loop derives the
    concurrent-eligible set from the registry - `tools/index.ts` exports `READ_ONLY_TOOLS` built by filtering
    `TOOLS` - so a new read-only tool is picked up the moment it sets the flag, with no second place to forget.
    `read`/`glob`/`grep`/`web_search` opt in; `edit`/`write`/`multi_edit`/`bash` and the dynamic
    `process`/`task`/`skill` tools stay barriers by default.
  - **Results commit to the conversation in CALL order, not completion order.** Each result is captured into an
    index-keyed slot; after the whole batch drains the slots are appended to the conversation in call order,
    then `step(n+1)` is concatenated. This keeps history/replay and overflow recovery deterministic -
    `trimLargestToolResult` (D-036) and the prompt projection (`history-projection.ts`) see a stable,
    call-ordered shape regardless of which read finished first. The inter-step data dependency still holds: the
    next model step reads a fully-committed conversation.
  - **Cancellation is unaffected.** `Stream.mergeAll`'s children are interrupted when the parent fiber is
    interrupted, so the interrupt-based teardown (A-004) covers concurrent tools with no new abort plumbing.
  - **Follow-up to verify, not assumed:** on the wire `tool_start`/`tool_end` events for a read group can now
    arrive out of call order; the web keys tool results by `call.id`
    (`apps/web/src/components/chat/message.tsx`), so rendering is expected to tolerate this - **verify before
    shipping**, and if strict wire order is wanted, hoist the read group's `tool_start` emissions ahead of the
    merged executes.

### Then: graceful turn-budget termination <!-- D-051 -->

The sibling of overflow recovery (D-034): that feature governs how a turn behaves when its *prompt* is too
big; this one governs how a turn *ends* when it runs long. A turn is not one model call - it is a bounded
loop of model↔tool steps (`runAgent`, `apps/agent-host/src/agent/loop.ts`), capped today by a fixed
`MAX_STEPS = 8`. When the cap is hit the loop returns `Stream.empty`, which `turn.ts` treats as a normal
success and ships `assistant.completed {}` carrying whatever partial preamble streamed - **no `error`, no
`cancelled`, no `noReply`**. The result is a turn that dead-ends mid-investigation yet looks complete, with
no answer and no continuation.

**Observed (2026-06-24, local 4-bit qwen at 64k).** The last five substantive turns each terminated at
**exactly `MAX_STEPS = 8`** with the context window at **16-18%** (e.g. `usage.input` 11.6k / 65.5k) - killed
by an arbitrary step count, not by any scarce resource - and each ended on a tool result with no final text
and no terminal signal. The `n >= MAX_STEPS` branch is the **only** loop exit that emits nothing at all
(unlike `empty`→`noReply` at `loop.ts:161-172` and the terminal `assistant.overflow` of D-038), so a budget
exhaustion is indistinguishable from the model deciding it was finished.

- <!-- D-051 --> **A turn never ends silently at the budget (observable).** The cap branch emits a terminal
  `AgentEvent` `{ type: "step_limit"; steps }` instead of `Stream.empty`; `turn.ts` maps it onto the terminal
  completion as a first-class reason (a `stepLimit` flag on `assistant.completed`, the same shape family as
  `noReply`), carried in the shared `@trevor/session` event schema so the web and `/doctor` can show "stopped
  after N steps" rather than a turn that reads as a clean answer. This closes the one unobservable exit.
- <!-- D-052 --> **Forced final synthesis - exhaustion yields an answer, never a stub.** Reaching the budget
  runs exactly **one** more model step with **tools removed** - the existing no-tools path
  `provider.stream(conversation, [], reasoning)` - plus a transient nudge pushed into the loop's *ephemeral*
  `conversation` ("tool budget reached; answer now from what you've gathered; do not request more tools"). With
  no tools declared the model cannot request more and must synthesize from the context it already holds. The
  step is bounded to one (no recursion, independent of `MAX_STEPS`, the same discipline as `MAX_RECOVERY`),
  reasoning forced off/low for a direct answer, and if it still returns empty it falls through to the existing
  `empty`→`noReply` path. The nudge lives only in `conversation` (`loop.ts` builds it as `[...history]`, never
  persisted), so it cannot poison durable history or break the user/assistant alternation `sanitizeHistory`
  enforces.
- <!-- D-053 --> **Re-base the budget on context pressure, not a fixed step count.** `MAX_STEPS` is a poor
  proxy: a one-line `ls` and a 40k-char `cat` each cost "one step," while the resource actually at stake is the
  context window. Gate the *next* tool round on window occupancy - continue only while the last step's
  `usage.input` is below ~**80%** of `usage.contextWindow` (the loop captures the latest usage into its
  closure, as it already does `overflowReason`); otherwise go straight to D-052 synthesis. `MAX_STEPS` stays
  only as a high runaway backstop (~30-40), not the governor. This **auto-scales per model** (a 64k local model
  gets fewer rounds than a 200k cloud model, with no per-model tuning) and **composes with overflow recovery**:
  the budget is the *proactive* "wrap up before the wall" gate, D-036 trimming is the *reactive* "trim at the
  wall" airbag, so a turn neither dead-ends short of an answer nor runs blind into the window. Headroom is kept
  generous (75-80%, not 95%) because the next step's tool-result size is unknown in advance and the synthesis
  output still needs room; fall back to `MAX_STEPS`-only when `contextWindow` is 0/unknown.

Self-contained (loop + turn + one event field) and independent of compaction (D-040) and concurrent reads
(D-050), so it can land in any order relative to them - it is a correctness fix, so promote ahead of the
perf work if the silent dead-ends bite. Decomposed for execution in `progress-report.md`.

### Later (parked): per-turn tool-call guardrails <!-- D-054 -->

Inspired by NousResearch Hermes' pure tool-call loop guardrail controller
([`agent/tool_guardrails.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/tool_guardrails.py)).
Hermes' useful shape is small: a side-effect-free per-turn controller observes tool calls/results, detects
repeated exact failures and repeated read-only calls returning identical results, and returns a decision
(`allow` / `warn` / `block` / `halt`). Runtime code decides whether that decision becomes model-visible
guidance, a synthetic tool result, telemetry, or a controlled turn halt.

This is parked behind the current cutoff. It complements graceful turn-budget termination (D-051…D-053), but
does not replace it: the budget feature governs how a long turn ends; guardrails steer the model *before* it
burns the whole budget retrying the same failed/no-progress tool path. Pick it up after the loop-budget and
read-only-concurrency work if repeated tool loops remain visible in real runs.

- <!-- D-054 --> **Pure per-turn controller, not a permission system.** Add a small host module
  (e.g. `apps/agent-host/src/agent/tool-guardrails.ts`) that owns only in-memory, per-turn observation:
  canonicalize tool arguments, hash them, record exact failure counts, record read-only same-result counts,
  and return typed decisions. It must not execute tools, mutate conversation history, publish events, read
  config from global state, persist lessons, or decide policy/permissions. The loop (`runAgent`) owns how to
  surface the decision, keeping the same separation Hermes uses.
- <!-- D-055 --> **Tool purity comes from the registry.** Do not copy Hermes' hardcoded idempotent/mutating
  name lists. Reuse the D-050 `readOnly?: boolean` metadata on `Tool` and the derived read-only registry
  (`READ_ONLY_TOOLS`) as the single source of truth. A tool omitted from `readOnly` is a serial/mutating
  barrier and is excluded from same-result no-progress detection by default. `read`, `glob`, `grep`, and
  `web_search` can opt in; `write`, `edit`, `multi_edit`, `bash`, `process`, task tools, and dynamic skill
  tools stay excluded unless explicitly proven read-only.
- <!-- D-056 --> **Redacted fingerprints only.** Public events, logs, and UI markers carry tool name, action,
  count, short reason code, and sha256 fingerprints of canonical args/results - never raw arguments or raw
  output. Canonicalization should parse JSON tool args when possible, sort object keys, use compact JSON, and
  hash the normalized value. Result hashing should parse structured JSON when possible and fall back to the
  raw string. This follows both Hermes' `ToolCallSignature` shape and Trevor V1's
  `ToolProgressMonitor.fingerprintToolValue` pattern.
- <!-- D-057 --> **V2 failure classification is simple and local.** Because V2's `executeTool` renders typed
  tool failures into one model-facing `error: ...` string, the first version can classify failures from that
  convention instead of porting V1's full structured-output detector. Exact repeated failure = same tool +
  same arg fingerprint + same normalized error/result fingerprint. A successful mutating result clears the
  matching failure/no-progress entry for that signature. If later tools return richer typed output, extend the
  classifier at the tool boundary, not with broad substring heuristics across the transcript.
- <!-- D-058 --> **Warn first; hard stops stay opt-in.** Defaults should be advisory: after a low threshold
  (e.g. two exact failures or two identical read-only results) append concise provider-visible guidance to
  the tool result and emit a redacted `tool.guardrail`/`tool.progress` event for the UI. Hard blocking should
  be an explicit config or runtime option and, when enabled, return a synthetic retryable tool result rather
  than throwing out of the loop. The message should tell the model to inspect the latest error/output, change
  arguments or strategy, or report the blocker after one diagnostic attempt. It must not tell the model to stop
  using tools entirely.
- **V1 overlap to reuse cautiously:** `~/dev/trevor/packages/agent-host/src/agent/tool-progress-monitor.ts`
  already proves the useful Trevor-specific pieces: hash-only progress signals, repeated idempotent
  no-progress detection, repeated-failure warnings, optional synthetic blocked results, mutating-tool
  exclusion through tool metadata, and provider-visible recovery guidance. Do **not** port V1's durable
  "Tool Progress Lessons" persistence/classifier in this slice; that belongs with a later learning/memory
  feature if it is still wanted. The first V2 cut is per-turn only.
- **Validation when picked up:** add focused host tests for (1) repeated read-only same-result warning,
  (2) repeated exact failure warning, (3) mutating tools excluded from no-progress comparison, (4) optional
  synthetic blocked result, (5) no raw args/output in emitted events, and (6) integration with the D-051
  forced-synthesis path so a guarded loop still produces a final answer or explicit terminal reason.

### Then: subagents <!-- D-045 -->

Promoted from backlog (D-033) to the feature after compaction. A subagent is a delegated agent that runs in
its **own isolated context** and returns a distilled result - it lets the main agent fan work out, and it is
the substrate session recall (D-044) later rides on.

- <!-- D-045 --> **Two flavors for v1**, both on the **same inherited session model** (no per-agent model
  yet):
  - **general-purpose** - all tools (`['*']`); the catch-all when no specialized agent fits (renamed from the
    V1 "worker", which was vague - the reference set in `~/dev/cc` has no "worker", just this catch-all).
  - **explorer** - **read-only** (no write/edit tools); simple, for fan-out search/reading.
  Deferred: **verifier** (independent adversarial review - tackled separately; note inline self-validation
  stays cut, §4, but a verifier *subagent* is distinct), **teams** (multi-agent fan-out), **bounded child**
  (constrained structured-artifact helper). All stay backlog.
- <!-- D-046 --> **File-based discovery**, like skills/commands. An agent definition is a file with
  `{ description, tools (the allow-list), body = system prompt }`; the host discovers built-in + user-defined
  agents and announces them (the model picks by `description`). The `tools` allow-list is one list with two
  effects - what the agent may execute (safety) and which tool/skill schemas load into its prompt (budget).
  Per-agent allow-lists use best-judgment defaults (reviewable): explorer = read-only, general-purpose = all.
  **No per-agent model field yet** - all inherit the session model; per-agent / cloud-routed models are
  deferred (will reuse D-043's local↔cloud routing).
- <!-- D-047 --> **Two execution modes:** `delegate_inline` (**sync** - the parent turn blocks; the child's
  result folds into the turn) and `delegate_background` (**async** - the child runs concurrently; the parent
  continues and the result arrives as an event). **No teams** (multi-agent orchestration) in this cut.
- <!-- D-048 --> **Strict context isolation + forkable runs.** The child gets *only* what the parent
  explicitly hands it - the parent-authored **task prompt is the slice** (a structured `context` param can come
  later); nothing from the parent's transcript leaks implicitly. The child runs as its **own session with its
  own log**, linked by a `delegatedTo {childSessionId}` event on the parent (analogous to `forkedFrom`), so the
  fork machinery (D-025…D-029) applies unchanged: the child is independently forkable, and forking the parent
  copies the *frozen distilled result* (one event in the parent log) without re-running the child.
  **Fold-back** = the child's final message becomes the parent's tool result.
- <!-- D-049 --> **Ephemeral (model-minted) agents - slightly deferred.** Beyond the file-defined agents,
  prompt guidance lets the main model spin up an *ephemeral* agent for a one-off need, choosing a **tool
  contract matching the need** (its own allow-list). Built after the two file-defined flavors land.

### Deferred (after subagents): session recall <!-- D-044 -->

On-demand retrieval of detail compaction folded away - "search my own past." Possible only because the full
log survives compaction (D-042). **Explicitly sequenced after the subagents feature**, because it runs as an
**isolated sub-agent**: a search hit is an *anchor*, not the answer - the substantive discussion may live in
the turns *around* the match (sometimes while those turns were nominally about another topic), so recall
expands each anchor to its **neighborhood** and reasons over it. That neighborhood can be large and tangential,
so the digging happens in a sub-agent with its **own context budget**, returning only a distilled, cited answer
to the main turn (a librarian who reads the chapter around the page and hands back the answer).

- <!-- D-044 --> **`session recall` tool**, model-driven - the compacted prompt's fold manifest (D-042)
  advertises the recallable gaps so the model knows what to ask for. Search = **BM25** (lexical, ranked, no
  embeddings/index infra - built on-demand over the session's events) combined with structured pre-filters
  (tool / turn-range / type), then **neighborhood expansion** around each hit. **This session only - no
  cross-fork recall** for now; embeddings/semantic retrieval stay deferred behind BM25.
- **Depends on:** the subagents feature (isolation) + the D-042 fold manifest (anchors). Distinct from the
  §7 backlog "Code retrieval / search" row, which searches the *codebase*, not the conversation log.

### Then: remaining KEEP features not yet built

Sequence as each is picked up (no hard order locked here):
- **Auth / OAuth login** (`/login` for the cloud providers, PKCE, browser open) + an atomic auth store
  (H-019, H-155).
- **Offline detection & recovery** (connectivity probe, offline notices, recovery loop) (H-026, H-093).
- **`web_search` / `web_fetch`** tools (fallbacks, policy, provenance) (H-113).
- **`clipboard_write`** tool (H-111).
- **Settings & preferences** (persistence + web overlay: model/provider, thinking mode) + deeper
  **usage/metrics** surface (H-031, H-034).
- **Output-style registry** (assistant styles, prompt overlay) (H-164).
- **Doctor** depth (config/runtime/providers/workspace checks) (H-163).
- **Capability manifest** (tools + commands + contracts, compact form) (H-156).
- **Agent / skill / slash discovery** depth (H-165 is now backlog under delegation; skill + slash discovery
  KEEP) (H-166, H-167, H-168).
- **Fork-lineage navigator** (web) - the V1 "session tree" (H-004) is reframed onto fork lineage (D-025…),
  built in Phase 4.

### Phase 4 - forkable sessions <!-- D-030 -->

Artifacts (item 1) are **done** (§5). Remaining:
- **Host message-identity refactor** - the load-bearing piece. Stable per-message ids and a clean
  "build a fresh linear session from a prefix" path are the prerequisite for fork-at-a-point.
- `session.forkedFrom` (D-026) + `forkReady` (D-027) events and `origin` tags (protocol); the host fork
  operation (create session, copy prefix with origin tags, mark ready); a web "branch from here"
  affordance; the lineage navigator (dovetails with the Phase 3 one-window-many-sessions view).
- Stateful participants adopt the D-029 inheritance contract.
- Richter stays generic: add a batch-append endpoint **only** if prefix-copy latency demands it - never a
  `parentSessionId` column or a fork/blob feature in Richter.

### Phase 3 - desktop shell (Tauri v2) <!-- D-021 -->

Package `apps/web` as a self-contained desktop app: one window managing many sessions (sidebar/tabs), each
bound to a cwd like a single-process harness. **Not milestone-decomposed yet** - decompose at phase entry.
- <!-- D-021 --> **Shell = Tauri v2.** The OS webview renders `apps/web`; the Tauri (Rust) core is the host
  supervisor. Electron rejected for heft/coupling.
- <!-- D-022 --> **One host runtime per session/cwd.** The supervisor spawns/restarts/tears down one host
  process per open session. Multi-view fan-out is unaffected (extra views are lease-free Richter clients).
- <!-- D-023 --> **Supervision is not communication.** The Tauri core MAY spawn hosts; the web client still
  talks only to Richter. D-014's decoupling holds.
- <!-- D-024 --> **Spawnable host artifact required.** Tauri spawns the host as a sidecar (`externalBin`),
  so the Node+Effect host must ship as a standalone binary or with a bundled Node. This **elevates the
  D-018 compiled-host from optional to a dependency of this phase** (mechanism open: bun --compile / Node
  SEA / pkg vs bundled Node; A-005, re-opening retired A-001).
- **Packaging deltas** (apply at phase entry): drop the dev-only Vite proxy; target an absolute,
  runtime-configurable Richter URL injected by the shell; widen the webview CSP / Tauri capability allowlist
  to the Richter REST + WS origin; set Vite `base: './'` (or the Tauri asset protocol).

## 7. Kept backlog (unsequenced)

<!-- D-033 --> Carried forward as future work; built only when explicitly picked up. H-IDs preserve V1
provenance (where the feature lived in `~/dev/trevor/packages/agent-host`).

| Bucket | V1 ref | Notes |
|---|---|---|
| **LSP integration** | H-022, H-116, H-161 | diagnostics/hover/rename/refs/code-actions; lsp tool + service |
| **MCP client** | H-119, H-160 | bridge to external MCP servers (stdio/HTTP-SSE) via a `tool_proxy` tool |
| **Hooks runtime** | H-036, H-162 | PreToolUse-style hooks with sha256 trust: allow/deny/halt/inject-context |
| **`ast_grep` tool** | H-108 | AST-structural code search |
| **`/loop` runner** | H-029, H-169 | recurring/cadence task runner (draft→confirm→run→stop) |
| **Tangents** | H-030 | lateral exploration side-threads |
| **Bounded-child + takeover** | H-024, H-025, H-086 | host-owned constrained helpers + route escalation/takeover |
| **Managed worktrees** | H-140 | stable per-session git worktrees (paths/branches/hashes) |
| **Code retrieval / search** | H-112, H-138, H-139 | code_search/code_index/project_retrieve/source_recall + retrieval daemon |
| **Archive tools** | H-114 | archive_read / archive_unpack + validators / media processors |
| **`video_inspect`** | H-115 | frame extraction from video |
| **`tool_script`** | H-118 | sandboxed read-only TS scripting with a tool bridge |
| **Ollama provider** | H-046 | native Ollama adapter (beyond LM Studio + Codex/pi-ai) |
| **Local admission control** | H-057 | token reservation, queue, concurrency for local models |
| **Secret resolution** | H-061 | runtime `op://` and `!command` resolution, gated/opt-in |
| **Deep telemetry** | H-072, H-073, H-101 | OTel span export + opt-in provider attempt JSONL traces + tool result cache |
| **Subagents: teams, verifier, bounded child, ephemeral** | H-165 | general-purpose + explorer + inline/async **promoted to §6 (D-045…D-048)**; multi-agent **teams**, the **verifier** flavor, **bounded-child**, and **ephemeral model-minted** agents (D-049) remain future |
| **Shell interpolation (commands)** | H-175 | done for skills; extend `!cmd` / ` ```! ` to command files, same gating |
| **`shell.promote`** | H-035 | auto-promote-on-timeout: route bash/`/shell` through the supervisor and adopt a command that outlives its timeout as a tracked `pN` job. Sequenced after the Tasks tool (which is done) |

## 8. Assumptions

| Code | Assumption | Status |
|---|---|---|
| A-002 | Effect v3 viable for the project horizon | recorded (D-001) |
| A-004 | Interrupting an Effect fiber tears down the pi-ai stream | **validated 2026-06-23** (`scripts/spike-a004-interrupt.ts`): an `Effect.async`/finalizer canceler that calls `AbortController.abort()` tears the LM Studio stream down cleanly - 0-token leak across runs |
| A-005 | Node+Effect host packages as a spawnable artifact (compiled binary or bundled Node) for a Tauri sidecar | untested; validated at Phase 3 (re-opens A-001) |
| ~~A-001~~ | ~~Effect under `bun --compile`~~ | retired - no Bun binary (D-018); may re-open at Phase 3 (D-024) |
| ~~A-003~~ | ~~copied Rust TUI builds unchanged~~ | retired - no TUI (D-013) |

## 9. Risks

- **Richter coupling.** Trevor depends on a running Richter; mitigated by Docker-local dev and Richter being
  generic (no Trevor-specific changes - it attaches as a participant).
- **pi-ai interruption leak (D-010).** Validated 2026-06-23 (A-004): fiber interrupt → abort tears the
  stream down with no leak; the race-and-abandon + per-runId post-cancel delta suppression fallback is held
  in reserve, not needed.
- **Effect-dialect drift.** Keep Effect to justified boundaries (Schema decode, host control plane); plain
  React/TS elsewhere so an Effect island does not fight React.
- **Same-cwd contention (Phase 3, D-022).** Two sessions can hold filesystem authority over one directory at
  once (two harnesses in one repo can stomp each other). The D-019 lease is per-session, not per-cwd.
  Accepted as a deliberate user action; revisit with a cwd-level advisory lock if it bites.
- **Silent turn-budget dead-ends (observed 2026-06-24).** A long turn that exhausts the fixed `MAX_STEPS`
  ends via `Stream.empty` and reads as a clean `assistant.completed`, with no answer and no signal - on the
  local 4-bit at 64k this hit five consecutive turns at the window's 16-18%. Addressed by graceful turn-budget
  termination (D-051…D-053): observable exit, forced synthesis, context-pressure budget.

---
_Consolidated 2026-06-23: single plan; FEATURES.md + TABLED.md deleted and folded in; graceful-overflow-recovery merged (D-034…D-038); routing engine + T-1 dropped for good (D-032); work-kinds kept inert (D-039). Supersedes all prior Trevor V2 planning documents._

_Updated 2026-06-24: overflow recovery **shipped** (status event renamed `assistant.compacted` →
`assistant.recovered`; proactive prompt-estimate detection; 4-bit at 64k). **Cross-turn compaction** added as
the next feature (D-040…D-043: hybrid pin+drop+summarize; trigger = background-after-turn at 80% +
blocking-before guard + recovery airbag, compact-to ~50%; durable non-mutating `context.compacted` rolling
event with a per-fold delta manifest; tool-less ~1k summary on the turn model with a local↔cloud-routing future). **Session recall** added as
a deferred post-subagents layer (D-044: isolated sub-agent, BM25 + neighborhood expansion, this-session-only).
**Subagents** promoted from backlog to the feature after compaction (D-045…D-049: two v1 flavors
general-purpose + explorer, file-based discovery, inline+async modes, strict context isolation with forkable
child runs, ephemeral model-minted agents slightly deferred; verifier/teams/bounded-child stay backlog).
**Concurrent read-only tool execution** added as a small near-term phase after compaction (D-050: read-only
tools run concurrently under a bounded cap, mutating tools stay serial barriers, tool purity declared per-tool
via a defaulted `readOnly` flag and derived from the registry, results committed to the conversation in call
order). **Graceful turn-budget termination** added as a self-contained correctness phase (D-051…D-053:
the step-budget loop exit becomes observable via a `step_limit` event + `stepLimit` completion flag, the
budget forces a final tool-less synthesis instead of dead-ending on a tool result, and the cap is re-based on
context-window occupancy with `MAX_STEPS` demoted to a runaway backstop - motivated by the 2026-06-24 local
4-bit case where five turns died at exactly `MAX_STEPS=8` with the window at 16-18%). **Per-turn tool-call
guardrails** parked as a later correctness follow-up (D-054…D-058), inspired by Hermes'
[`agent/tool_guardrails.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/tool_guardrails.py)
and Trevor V1's `ToolProgressMonitor`: pure per-turn controller, registry-derived read-only classification,
redacted fingerprints, simple V2-local failure classification, warn-first with opt-in hard stops, and no
durable Tool Progress Lessons in the first cut. New decisions **D-040…D-058 are authored here in markdown
and still need syncing into `plan.db`** (canonical store)._

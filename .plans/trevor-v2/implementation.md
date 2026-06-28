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
| **Model source** | Configured account, runtime, endpoint, or gateway that owns auth and model discovery | <!-- D-065 --> Future chooser/catalog unit: local runtime/manual config, OAuth subscription, large catalog gateway, or direct API-key provider |
| **Model catalog entry** | One selectable runtime model from a source, with detected capabilities and auth/availability state | <!-- D-065 --> Host-owned data; web renders/searches it and sends back a stable model reference plus reasoning choice |
| **Adapter** | Transport to reach a provider (OpenAI-compat HTTP, SDK, …) - never collapse with provider | - |
| **Routing** | Selection of a model for a turn | <!-- D-032 --> Minimal: user-selected model/provider for the turn, with no routing engine. <!-- D-060 --> Internet connectivity is host-observed status only; it does not automatically switch cloud turns to local or local turns to cloud. |
| **Work kind** | `chat`, `plan`, `analysis`, `implement`, `review` | <!-- D-039 --> Defined but **inert** in V2 - not wired to routing/sampling/prompts; revisit later |
| **Execution mode** | `direct`, `delegate_inline`, `delegate_background` | <!-- D-047 --> `direct` now; **inline (sync) + read-only background (async)** being built (D-047); teams deferred |
| **Tool** | Executable capability owned by a run (read, edit, bash, rg, …) | - |
| **Prompt shell lane** | Interactive prompt input beginning with `!`, executed immediately by the host shell path and rendered as a user-owned terminal transcript item | <!-- D-082 --> Not shell interpolation and not a model turn; output is prompt-invisible for now |
| **Prompt composer state** | Browser-tab-local draft text and prompt history used to recover in-progress typing and recall previous prompts | <!-- D-083 --><!-- D-084 --> Draft persistence and Up-arrow history are client UX features; they do not affect durable session history until submitted |
| **Project-local skill root** | Per-project skill library discovered from the active workspace at `.agents/skills` | <!-- D-087 --> Project-local skills are loaded before the existing global/configured skill root so a repo can carry its own reusable workflows |
| **Project launcher** | Terminal command that turns the current project directory into a browser Trevor session with a matching host process | <!-- D-085 --> `trevor` owns session-id derivation, host spawning/reuse, shared-service readiness, and browser tab opening so users never hand-wire `SESSION_ID`/`TREVOR_WORKSPACE` |
| **Early transcript layout** | Browser transcript behavior before the conversation overflows the viewport | <!-- D-086 --> New/short sessions start at the top and grow downward; live-bottom following begins once content can actually scroll |
| **Assistant output style** | Named presentation preference selected through the nested command menu to shape response density and structure | Extracted to `.plans/18-nested-command-menu`; presentation-only, must not change model routing, work kind, execution mode, tool access, agent selection, or validation policy |
| **Doctor snapshot** | Structured host health report with areas, checks, findings, evidence, and next actions | <!-- D-073 --> `/doctor` should render actionable diagnostics, not raw host/debug state dumps |
| **Capability manifest** | Registry-derived self-description of Trevor tools, commands, contracts, agents, skills, runtime surfaces, and the `trevor-expert` explainer skill | Extracted to `.plans/19-capability-manifest-and-trevor-expert`; full/compact export plus built-in expert consumer; never a permission system or giant prompt dump |
| **Subagent** | Delegated agent in its own isolated context | <!-- D-045 --> **general-purpose + explorer + ephemeral definitions** being built (D-045…D-049); verifier / teams / bounded-child deferred |
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
- Skills: discovery, progressive disclosure, **shell interpolation** (H-175 done for skills); project-local
  skill roots are a near-term refinement (D-087).
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
  `run_shell`, `workspace`, `web_search`.
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
- **Adaptive turn termination** (**shipped 2026-06-27**): generic turn stops now carry typed
  `assistant.completed.stop` data. Context pressure, low-context step backstops, loop stalls,
  provider protocol anomalies, overflow, no-reply, cancellation, interruption, errors, and ordinary
  answers are distinct protocol causes; the fixed 32-step ceiling is a pause/backstop, not a normal
  answer signal.

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

### Then: subagents <!-- D-045 -->

Promoted from backlog (D-033) to the feature after compaction. A subagent is a delegated agent that runs in
its **own isolated context** and returns a distilled result - it lets the main agent fan work out, and it is
the substrate session recall (D-044) later rides on.

- <!-- D-045 --> **Two reusable flavors for v1**, both on the **same inherited session model** (no per-agent model
  yet):
  - **general-purpose** - all tools (`['*']`); the catch-all when no specialized agent fits (renamed from the
    V1 "worker", which was vague - the reference set in `~/dev/cc` has no "worker", just this catch-all).
  - **explorer** - **read-only** (no write/edit tools); simple, for fan-out search/reading.
  Deferred: **verifier** (independent adversarial review - tackled separately; note inline self-validation
  stays cut, §4, but a verifier *subagent* is distinct), **teams** (multi-agent fan-out), **bounded child**
  (constrained structured-artifact helper). All stay backlog.
- <!-- D-046 --> **File-based discovery**, like skills/commands. An agent definition is a file with
  `{ description, tools, skills?, body = system prompt }`; the host discovers built-in + user-defined agents
  and announces them (the model picks by `description`). `tools` and `skills` are separate allow-lists:
  `tools` controls what the agent may execute, while `skills` controls which skill names/descriptions load
  into the child prompt and which skill bodies may be loaded if the child decides a skill applies. Per-agent
  allow-lists use best-judgment defaults (reviewable): explorer = read-only tools + no mutating skills;
  general-purpose = all tools + all skills. **No per-agent model field yet** - all inherit the session model;
  per-agent / cloud-routed models are deferred (will reuse D-043's local↔cloud routing).
- <!-- D-047 --> **Two execution modes:** `delegate_inline` (**sync** - the parent turn blocks; the child's
  result folds into the turn) and `delegate_background` (**async** - the child runs concurrently; the parent
  continues and the result arrives as an event). Delegation is **depth-1 only** in this cut: a root session may
  spawn a child, but a child may not spawn another child. The host enforces `MAX_DELEGATION_DEPTH = 1`, strips
  `delegate_inline` / `delegate_background` from every child tool registry/prompt even for `general-purpose`
  or ephemeral `tools: ['*']`, and returns a structured tool error if a child somehow attempts delegation.
  Background children are bounded by `MAX_BACKGROUND_CHILDREN_PER_SESSION = 4` active children; inline
  delegation remains a serial barrier. `delegate_background` is **read-only only** in this cut: discovered
  agents are clamped to the `READ_ONLY_TOOLS` subset, ephemeral `tools: ['*']` means "all read-only tools",
  and any explicit mutating/default-serial tool in an ephemeral background contract is rejected with a
  structured tool error. Mutating background agents are deferred until managed worktrees, cwd-level locks, and
  a merge/reconciliation protocol exist. **No teams** (multi-agent orchestration) in this cut.
- <!-- D-048 --> **Strict context isolation + forkable runs.** The child gets *only* what the parent
  explicitly hands it - the parent-authored **task prompt is the slice** (a structured `context` param can come
  later); nothing from the parent's transcript leaks implicitly. The child runs as its **own session with its
  own log**, linked by a `delegatedTo {childSessionId}` event on the parent (analogous to `forkedFrom`), so the
  fork machinery (D-025…D-029) applies unchanged: the child is independently forkable, and forking the parent
  copies the *frozen distilled result* (one event in the parent log) without re-running the child.
  **Fold-back** = the child's final message becomes the parent's tool result.
- <!-- D-049 --> **Ephemeral (model-minted) agents are in this subagents round**, after the two file-defined
  flavors establish the base path. "Ephemeral" means the **agent definition** is runtime-minted, not that the
  run is temporary or unaudited: the child still runs as an isolated durable session with the same delegation
  link, fork behavior, cancellation, fold-back, and UI surfacing. The parent model may provide a task-local
  contract `{ description, instructions, tools, skills? }`; the host validates tool and skill names against
  the registries, snapshots the definition into the child run for audit/replay, loads only the selected
  schemas/descriptions into the child prompt, and never writes a reusable agent file or global registry entry.

### Then: search-tool upgrade <!-- D-062 -->

Sequenced immediately after Phase 4 subagents and before session recall. This is two coupled but separable
tool-surface fixes: the existing `grep` tool should actually be ripgrep-backed, and H-108 `ast_grep` is
promoted from unsequenced backlog to the next read-only code-search tool.

- <!-- D-062 --> **`grep` keeps its model-facing name but becomes ripgrep-backed.** The current plan already
  lists `grep` as `(rg)` in the shipped tool inventory; the implementation must replace the custom Node
  `fs.promises.glob` + `RegExp` scanner with a real ripgrep backend. Preserve the provider-visible tool name
  (`grep`) so transcripts, usage accounting, prompts, and web rendering do not churn. Use a project-managed
  binary resolver such as `@vscode/ripgrep` (or an equivalent checked dependency) rather than assuming a
  Homebrew/system `rg`. Run it via `execFile`/`spawn` with argv arrays and `cwd: WORKSPACE_ROOT`, not through
  `bash` or `runShell`. Preserve `readOnly: true`, workspace confinement, output caps, typed failures, and
  D-050 concurrent-read behavior. Keep the schema explicit and small: `pattern`, optional `glob`, plus bounded
  options such as `literal`, `ignoreCase`, `hidden`, `noIgnore`, and `maxMatches`; no raw flag passthrough.
- **Add a read-only `ast_grep` structural-search tool.** It wraps the official ast-grep CLI/package in search
  mode only (`ast-grep run`), with no rewrite/update/interactive path in this first cut. The tool schema is
  explicit: `pattern`, optional `lang`, optional `paths`, optional `globs`, optional `strictness`, and optional
  `maxMatches`. Prefer JSON output (`--json=stream`) parsed into compact, capped match rows containing path,
  line/column, and snippet. Use the full binary name `ast-grep`, not `sg`, because `sg` conflicts on Linux.
  The tool declares `readOnly: true` and runs confined to `WORKSPACE_ROOT`.
- **Shared helper boundary.** Add one bounded child-process helper for read-only external search binaries:
  argv-only execution, timeout, max output, cap, cwd, no shell expansion, typed nonzero/no-match handling, and
  interruption cleanup. Both `grep` and `ast_grep` use it; `bash` remains the only free-form shell tool.
- **Validation when picked up:** host tests for `grep` should cover no-match, ignored directories/gitignore
  behavior, literal vs regex mode, invalid regex, match caps, workspace confinement, output truncation, and the
  read-only registry. `ast_grep` tests should cover TS/TSX structural matches, lang inference and explicit
  `lang`, globs/paths, no-match, invalid pattern/lang handling, match caps, workspace confinement, and
  read-only registry inclusion. Prompt guidance and tool inventory tests must say when to use text search vs
  structural search.

### Shipped: nested AGENTS.md context files - Claude Code lazy model <!-- D-080 -->

Trevor now reads project instruction files automatically. Before this shipped,
`buildSystemPrompt` (`apps/agent-host/src/providers/system-prompt.ts`) only *mentioned* `AGENTS.md` as a
discovery hint (REPO_GUARDRAILS); it never ingested one. This added automatic nested context-file ingestion using
**Claude Code's loading model** - eager up-tree at the root, lazy below cwd on file access - but keyed on the
cross-tool **AGENTS.md** standard (agents.md) rather than `CLAUDE.md`. The repo already uses AGENTS.md
(root `AGENTS.md`, `apps/AGENTS.md`) and the prompt already points the model at it. Codex's eager-only
root→cwd model is the comparison point, not the target: it cannot pick up an `AGENTS.md` below cwd (its open
issue #12115 asks for exactly the Claude Code behavior chosen here). Decomposed into milestones (M1 reader,
M2 eager injection, M3 lazy below-cwd loading, M4 surfacing) in the progress report. Source:
`apps/agent-host/src/providers/system-prompt.ts`, a new context-file reader module
(`apps/agent-host/src/context/` proposed), the file tools (`apps/agent-host/src/tools/`), session/loop state,
and `apps/agent-host/src/commands.ts` (`/doctor`).

- <!-- D-080 --> **Eager up-tree scope, concatenated root→cwd.** Walk UP from the host cwd to the workspace
  root (the `.git` marker / `WORKSPACE_ROOT` confinement boundary, never past it), collect every `AGENTS.md` on
  that path, and concatenate them **root-first → cwd-last** so the most-specific directory's instructions land
  last and win on conflict (positional precedence, not field-level override - the model both tools use). Add a
  user-global scope (`~/.trevorV2/AGENTS.md`) loaded first, ahead of the project chain. One file per directory;
  empty/whitespace-only files skipped. This eager scope rides the per-turn prompt, so it survives compaction for
  free: `buildSystemPrompt` already re-renders every turn (that is how the live checklist outlives compaction,
  D-040), so the block is re-read from disk and re-injected each turn instead of living only in the
  (compactable) transcript - the same reason Claude Code re-reads root `CLAUDE.md` after `/compact`.
- <!-- D-081 --> **The `~/.trevorV2` base directory is single-sourced and env-overridable.** Define it as ONE
  exported host constant (proposed `TREVOR_HOME`, in a dedicated paths module), resolved once as
  `resolve(process.env.TREVOR_HOME ?? join(homedir(), ".trevorV2"))` - the same pattern `WORKSPACE_ROOT` already
  uses for `TREVOR_WORKSPACE` in `apps/agent-host/src/tools/workspace.ts`. Every user-global path derives from
  it - the user-scope `AGENTS.md` introduced here, and the existing `.env.op` / future hooks / config - so the
  directory name and its eventual relocation live in exactly one place. The host resolves no `~/.trevorV2` path
  in TS today (only the `dev:op` / `start:op` npm scripts and the Storybook doctor fixtures name it literally),
  so this constant lands with the M1 reader as the first real code use, not as a standalone refactor. Align the
  `dev:op` / `start:op` scripts to honor the same `TREVOR_HOME` override (defaulting to `.trevorV2`) so the one
  override point is shared across the shell and TS surfaces instead of being re-hardcoded per surface.
- **Lazy below-cwd loading on file access - the defining Claude Code behavior.** An `AGENTS.md` in a
  subdirectory *below* cwd is never on the root→cwd path, so the eager pass misses it. When a file tool (`read`,
  and any other file-touching tool) touches a file inside a subtree, lazily load that subtree's `AGENTS.md` plus
  every not-yet-loaded `AGENTS.md` between cwd and that file, and inject it. Track the loaded set in session
  state, dedup so each directory loads once, and re-inject the accumulated lazy set on later turns and after a
  compaction fold (the eager per-turn re-render does not cover below-cwd files).
- **`@path` imports, bounded.** Support Claude Code's `@relative/or/absolute/path` import syntax inside an
  `AGENTS.md`: expand and inline the referenced file, resolve relative paths against the importing file, cap
  recursion (≤ 4 hops, matching Claude Code), detect and break cycles, and skip `@paths` inside fenced or inline
  code spans so literal examples are not mistaken for imports.
- **Bounded, observable, never silent.** Enforce a combined byte budget across all ingested context (Codex caps
  at 32 KiB; pick a Trevor budget) and, unlike Codex's silent truncation (its issue #7138), surface what was
  loaded and what was dropped in `/doctor`: files read, scopes, bytes used vs dropped, and which lazy subtrees
  were pulled in. Keep the read-walk-merge logic a pure, separately-testable module seam, not inlined into
  `buildSystemPrompt`.
- **Reconcile the existing guardrail.** With `AGENTS.md` auto-ingested, the REPO_GUARDRAILS line that tells the
  model to "begin from existing top-level files like README.md or AGENTS.md" is partly redundant for AGENTS.md;
  reword it so the model knows project instructions are already in context.
- **Validation target.** Tests should cover: a root-only repo; a nested chain (root + `apps/` + cwd) merged
  root→cwd with cwd winning on conflict; the walk-up stopping at `WORKSPACE_ROOT`/`.git`; user-global loading
  first; a below-cwd `AGENTS.md` loaded lazily only after a file in that subtree is read, and deduped on a
  second read; `@path` import expansion with the 4-hop cap and cycle detection; code-span `@paths` ignored; the
  byte budget truncating deterministically with the drop surfaced in `/doctor` (not silent); and the eager block
  re-injected after a compaction fold.

### Next: prompt shell lane - leading `!` <!-- D-082 -->

Carry forward the useful Trevor V1 bang-shell behavior into the browser/Richter architecture. V1 recognizes a
top-level `!command` as an immediate host-owned shell command, renders the user input on a distinct shell band,
and never routes it to the model. V2 already has the safer building blocks: `/shell`, the shared `runShell`
primitive, the bash safety floor, timeout, output cap, and command-result rendering. What V2 lacks is the
interactive prompt grammar, composer state, dedicated protocol events, and a transcript surface that reads as
"user ran a shell command" rather than "slash command output" or "agent tool call." This feature is distinct
from D-012/H-175 shell interpolation in skill/command files: nothing is interpolated into a prompt and no model
is called.

- <!-- D-082 --> **Leading `!` is an immediate prompt shell lane, not a model turn.** If the first raw
  character in the composer is `!` and the remaining text is non-empty, submitting runs the command immediately
  on the live host. It bypasses the send queue, provider selection, reasoning controls, assistant turn
  lifecycle, tool-call loop, and prompt projection. It uses the same `runShell` protections as `/shell` and the
  `bash` tool: deny-only destructive-command floor, host cwd/workspace confinement, fixed timeout, output cap,
  and rendered refusal/failure text. `/shell <command>` remains supported for command-menu compatibility; `!`
  is the fast terminal-style spelling.
- **Prompt-invisible by decision.** The shell command and output are durable transcript events for the user, but
  `buildHistory`, compaction, and session recall anchors ignore them in the first cut. The next model turn does
  not see the output unless the user quotes/copies it into a prompt. If this later changes, make it an explicit
  feature with a visible "include shell output in context" affordance, because shell output can be large,
  secret-bearing, or operationally noisy.
- **Storybook first.** Build the prompt-input state in Storybook before host wiring: normal draft, slash-command
  draft, empty bang draft, executable bang command, long bang command, and bang-with-attachments/error state.
  The bang state changes the composer shell color immediately as the first `!` is typed: a compact `Shell` chip
  and a terminal-like border/background distinct from slash-menu styling, context-pressure yellow, and tool
  cards. The story must use the production composer styling path, not a story-only fake that can drift.
- **Protocol and host events.** Add `user.shell {requestId, command}` and `shell.result {requestId, command,
  text, ok}` to `@trevor/session`. The web publishes `user.shell`; the live leader runs `runShell(command)`
  and emits exactly one `shell.result`. Replays never re-execute the command. Unknown/standby hosts ignore the
  action just like current immediate commands. `/clear` resets transcript projection and UI history from that
  point, but does not mutate prior durable shell events.
- **Transcript rendering.** Render a single shell block keyed by `requestId`, showing `$ command` and the capped
  output in monospace. Success uses a quiet frost/green terminal rail; refusal or command failure uses the same
  surface with a red rail and `failed/refused` label. It must not share the assistant bubble, read-only
  concurrent-tool grouping, tool-card chrome, or generic `CommandResult` chrome. The command itself is visible,
  unlike current slash-command results, because the command is the user-owned action.
- **First-cut exclusions.** Do not carry V1 shell promotion or top-level `!timeout` parsing into this cut unless
  they already exist in V2's shared `runShell` path. `shell.promote` remains the separate backlog item, and
  long-running process adoption should stay behind the existing supervisor/jobs design.
- **Validation target.** Tests should cover protocol round-trip, composer classification, Storybook visual
  states, immediate host execution, refusal through the bash safety floor, non-zero command failure, output
  capping, replay not re-running commands, transcript pairing by `requestId`, `/clear` reset behavior, and
  prompt projection ignoring both command and output.

### Then: prompt composer recovery and history <!-- D-083 --><!-- D-084 -->

Two prompt-editor ergonomics items are now captured as the follow-up after the bang shell lane, unless a later
roadmap item is explicitly promoted ahead of them.

- <!-- D-083 --> **Debounced browser-tab draft persistence.** Persist the current prompt draft in tab/session
  storage, scoped by session id and browser tab identity, on a short debounce so reloads, hot restarts, and
  transient web crashes do not lose mid-typed text. Restore only unsubmitted drafts; clear on successful submit,
  `/clear`, or explicit user clearing. Attachments stay out of the first cut unless the blob upload state is
  already durable enough to restore safely. This is browser local state, not a Richter event and not prompt
  context.
- <!-- D-084 --> **Up-arrow prompt history recall.** When the composer is empty, ArrowUp cycles through prior
  submitted prompt texts for that tab/session, terminal-style. ArrowDown moves forward and eventually returns
  to the empty/new draft. Multi-line editing keeps normal cursor movement unless the cursor is at the first
  line and the draft is eligible for history navigation. Recall includes ordinary prompts and bang shell
  commands as typed; it should not include hidden slash-command results or host-generated text. Persist enough
  recent history locally for reload survival, with a small cap.

### Soon: project launcher - `trevor` from any project <!-- D-085 -->

The desired workflow is one terminal word from any project, not a copied env block. From a project directory,
typing `trevor` should open or focus a browser tab on that project's Trevor session and ensure exactly one
matching agent-host process is answering for that session. This is the first implementation slice of the broader
D-061 browser/terminal session-manager direction.

V1 comparison: V1's root package exposes a `trevor` bin that runs the Rust TUI, and the TUI's process launcher
spawns the stdio RPC host from the invocation cwd, records host-process ownership, and reclaims stale
Trevor-owned groups. That proves the useful ergonomic contract: one command, cwd-scoped host, owned process
lifecycle. The browser V2 cut should carry that forward while dropping the TUI, stdio RPC coupling, and V1's
workspace-switch machinery.

V2 comparison: V2 already has the pieces but no launcher. The web app defaults to `?session=trevor-local`; the
host defaults to `SESSION_ID=trevor-local`; the host can be pointed at a target repo with `TREVOR_WORKSPACE`
and by starting from that cwd; `host.online` announces `cwd` and `workspace`; local mode uses the reserved
Trevor services on `127.0.0.1:17420` (web), `17423` (blob), and `17424` (session-store). Today a second project
requires manual `SESSION_ID`, `TREVOR_WORKSPACE`, cwd, and URL wiring. D-085 makes that wiring a product
surface.

- <!-- D-085 --> **One command, one project session.** Add a terminal executable named `trevor`. With no args,
  it resolves the current project root, derives or looks up a stable URL-safe session id for that canonical
  root, ensures the shared Trevor services are reachable, spawns or reuses the one matching agent-host process,
  and opens `http://127.0.0.1:17420/?session=<id>` in a new/focused browser tab. No user should need to type
  `SESSION_ID=...`, `TREVOR_WORKSPACE=...`, or a raw host command for the ordinary path.
- **Project root and session identity.** Default root resolution is nearest Git worktree root from cwd; if none
  exists, use cwd. Store the mapping under Trevor local state so the same project reopens the same session. The
  generated session id is human-readable but collision-resistant, for example `<basename>-<short-hash>`, with no
  slashes and no dependence on the current shell directory name alone. Add explicit overrides later (`trevor .`,
  `trevor --new`, `trevor --session <id>`) only when the base path is reliable.
- **Shared services are singletons; hosts are per project.** Do not start one browser server or session-store per
  project. The launcher ensures the shared local services are up on the reserved Trevor ports, then starts one
  agent-host per project/session. Each host gets `SESSION_ID=<derived-id>`, `TREVOR_WORKSPACE=<project-root>`,
  and `cwd=<project-root>` so read/write/bash and AGENTS.md eager/lazy loading all describe the same project.
- **Idempotent host lifecycle.** A second `trevor` from the same project reuses the existing healthy host and
  opens the same session tab. A stale ownership record or dead process is replaced. Two concurrent launches for
  the same project are serialized with a per-session lock so hosts do not contend for the same lease. Different
  projects may run independent hosts at the same time.
- **Launcher-owned diagnostics.** The command prints a concise status line: session id, project root, whether
  services were reused or started, whether the host was reused or spawned, and the opened URL. Failures are
  actionable: missing Node/pnpm/tsx/opchain, occupied reserved port, session-store unreachable, host failed to
  announce, or browser-open failure. Secrets from `.env.op` or provider auth are never logged.
- **Browser/UI handoff.** The app should tolerate opening before the host is online: it shows the session and a
  clear "starting host" state from absence of live host presence, then switches to the announced workspace once
  `host.online` arrives. The side panel remains the source of truth for the workspace label. A later full
  session switcher can list these project sessions, but the first cut can rely on the direct URL.
- **Validation target.** Tests should cover project-root resolution, stable/collision-safe session id generation,
  state mapping persistence, singleton service health checks, host spawn env/cwd, host reuse, stale-host
  replacement, concurrent launch locking, URL generation/opening, no duplicate host for one session, and manual
  EZE from two different repos proving two browser tabs attach to two sessions with two matching host processes.

### Soon: early transcript top-down growth <!-- D-086 -->

New and short browser sessions should read like a page, not like an empty terminal well. The first user prompt
and early assistant output should appear near the top of the transcript area and append downward. Only once the
content exceeds the available transcript height should the view behave like a live chat log and follow the bottom
while the user is already at the live edge.

V1 comparison: V1 is a terminal TUI, so it is not a direct browser-layout precedent. It does have explicit
scroll-layout concepts (`pinned-bottom` and `unified`) and a fixed prompt/footer area, which proves scroll
position is a product decision rather than incidental rendering. This V2 item should not import a V1 setting
surface; the browser default should simply be the better first-screen behavior.

V2 comparison: Trevor web currently implements the transcript container as `flex-col-reverse` in `App.tsx`, with
`scrollTop === 0` treated as the bottom. That makes the transcript bottom-pinned from the first paint, so a new
session's first message appears just above the composer until enough content fills the page. D-086 replaces that
with normal top-down document flow and explicit live-edge following.

- <!-- D-086 --> **Short sessions start at the top.** Empty replayed sessions render an empty transcript area.
  The first submitted user message appears at the top padding of the transcript well, followed by assistant
  output below it. Additional early messages append downward without vertically bottom-aligning the group above
  the composer.
- **Overflow switches to live-bottom behavior.** When content grows taller than the viewport and the user is at
  the live edge, new transcript updates scroll to the bottom. If the user scrolls upward, streaming and tool
  updates do not yank the viewport; the existing jump-to-bottom affordance remains the way back to live output.
- **Normal scroll math.** Replace the `flex-col-reverse` scroll model with normal column flow. `atBottom` should
  mean `scrollHeight - clientHeight - scrollTop` is within tolerance; `scrollToBottom` should scroll to
  `scrollHeight`, not `0`. Replay, `/clear`, queued prompts, compacting bars, and shell blocks should share the
  same model.
- **No fake spacer.** Do not solve this by adding a filler spacer that pushes early messages around. The
  transcript list owns its natural top-down layout, while the composer/footer stay pinned below the scroll area.
- **Validation target.** Storybook or fixture views should cover empty replayed session, one user message, a
  short user/assistant exchange, just-before-overflow, overflowing transcript at live bottom, overflowing
  transcript while scrolled up, mobile height, and desktop height. Browser tests should pin the scroll math for
  normal top-down flow and prove early content is top-aligned until overflow.

### Soon: project-local skill roots - `<cwd>/.agents/skills` <!-- D-087 -->

Project-local skills should be readable from the project being worked on, in addition to the existing global or
configured skill library. The useful behavior is: clone or open a repo, put reusable workflows under
`.agents/skills`, and Trevor can discover and use those skills without installing them globally.

V1 comparison: V1 documented the local/user/shared discovery pattern for skills. Its priority order started
with project-local `<cwd>/.trevor/skills`, then user-local `~/.trevor/skills`, then shared paths from
`~/.trevor/config.json[c]`. That establishes the important product contract: repo-local skills are valid and
should beat broader defaults when the same skill id appears in more than one place.

V2 comparison: V2 currently has a single skill root in `apps/agent-host/src/skills.ts`:
`TREVOR_SKILLS_DIR` if set, otherwise `~/.agents/skills`. `discoverSkills()` scans only that one directory,
`/skills` reports only that directory when empty, `buildSkillTool` loads one selected body from that list, and
agent/delegate validation checks skill ids against that same discovered set. The current plan's D-075 already
requires source/override provenance for future `skills_list` and `skill_view`, but it does not yet specify the
project-local root.

- <!-- D-087 --> **Read the project-local root first.** Discover skills from `<workspace>/.agents/skills`,
  where `<workspace>` is the same effective root used by file tools (`TREVOR_WORKSPACE` / `WORKSPACE_ROOT`, or
  process cwd when no workspace override exists). For ordinary project launches this is exactly
  `<cwd>/.agents/skills`. This keeps skills, file access, shell cwd, and AGENTS.md loading aligned to one
  project authority.
- **Keep current global/configured roots.** This is additive. After the project-local root, keep the existing
  configured root behavior: `TREVOR_SKILLS_DIR` when set, otherwise `~/.agents/skills`. Deduplicate identical
  resolved roots. Future config files may add more shared roots, but this cut should not invent a new config
  format.
- **Project-local wins by id.** If an enabled project-local skill and a global/configured skill share the same
  id, the project-local skill is the effective one. Preserve enough provenance to show the selected source and
  any shadowed source in `/skills` now and in D-075's future `skills_list`/`skill_view` surfaces. A disabled
  skill file is absent in this cut; it does not create a tombstone that hides a global skill.
- **Progressive disclosure remains.** The compact skill roster, `skill(name)` compatibility tool, future
  `skills_list`, and future `skill_view` all read from the same effective registry. The model should not get
  full project-local skill bodies unless it explicitly loads the matching skill.
- **No new execution bypass.** Project-local skills use the same parser, disabled handling, output caps, and
  optional shell-interpolation gate as global skills. A repo-local skill cannot auto-run `!` interpolation
  merely because it lives inside the project.
- **Validation target.** Tests should cover local-only, global-only, missing-local, duplicate-id precedence,
  disabled local files, root deduplication, `/skills` source display, `skill(name)` expanding the local override,
  agent/delegate allow-list validation against the effective registry, and shell interpolation staying off by
  default for project-local skills.

### Soon: sidebar git identity - branch/ahead/behind/dirty <!-- D-088 -->

The sidebar should show the workspace identity the user needs before choosing a session or worktree. The
current working directory remains the primary line. The current Git branch/status belongs directly underneath
it, not mixed into the same row and not deferred to the worktree switcher.

V1 comparison: V1 already models workspace git state as branch, dirty, ahead, behind, and worktree state. Its
header rendering uses the compact `branch*`, `↑N`, and `↓N` vocabulary. That is the right product shape to
carry forward, while moving it from the terminal header into the browser sidebar.

V2 comparison: V2 already announces `branch?: string` on `host.online` and the side panel can render a branch
string next to the workspace. It does not yet send ahead/behind/dirty status, does not refresh status after
changes, and does not place the branch underneath the current working directory.

- <!-- D-088 --> **Storybook-first sidebar git identity.** Build the side-panel workspace block in Storybook
  first, using production sidebar components and fixture data. Stories must cover clean branch, dirty branch,
  ahead-only, behind-only, diverged, detached HEAD, no upstream, non-git cwd, long path, and long branch names.
- **Display contract.** The cwd/workspace line is first. The branch line is second. Dirty appends `*` to the
  branch name. Ahead and behind render as `↑N` and `↓N`. If there is no branch, show a detached label when a
  commit can be found; if there is no Git repository, omit the branch line or show a subdued non-git state in
  the Storybook-approved layout.
- **Host-owned git status.** The host computes git status for its effective cwd/workspace: branch or detached
  commit, dirty boolean, ahead count, behind count, upstream presence, and whether the cwd is a Git worktree.
  Dirty means `git status --porcelain` has any tracked or untracked changes. Ahead/behind are relative to
  upstream when upstream exists.
- **Protocol shape.** Replace or extend the current `host.online.branch` string with a richer optional git
  object, keeping decode tolerant of old events. The UI should derive the display label from structured fields,
  not parse a preformatted string.
- **Refresh semantics.** Status should be announced on host startup and after host-owned operations that may
  change the repository state. A later file-watcher can improve freshness, but the first cut should avoid
  constant polling and must not block prompt flow on Git commands.
- **Validation target.** Tests should cover protocol round-trip/decode compatibility, git-status collection in
  clean/dirty/ahead/behind/detached/non-git fixtures, sidebar rendering states, long-label truncation, and no
  overlap with the context meter or model controls.

### Soon: shared command modal foundation <!-- D-089 -->

Resume and worktree switching should feel like one interaction family, not two unrelated modals. The common
surface is a Storybook-first shadcn `Command`-based modal that owns search, keyboard navigation, highlighted
selection, disabled rows, empty state, footer hints, and the visual rhythm shown in the worktree concept image.

V1 comparison: V1 has separate resume/session and worktree overlays with rich keyboardable lists. The useful
part is the high-signal modal pattern, not the terminal rendering code.

V2 comparison: V2 already has shadcn UI primitives and Storybook. It does not yet have an app-level command
modal pattern for session/workspace choices, and the resume/worktree features should not each invent one.

- <!-- D-089 --> **One Storybook-first command modal foundation.** Build a reusable command-modal component
  around shadcn `Command`, `Dialog`, and existing Trevor tokens before wiring any live resume or worktree
  behavior. The component must be production code with stories, not a story-only mock.
- **Typed row model, domain-specific consumers.** The shared layer owns presentation and interactions. Resume
  and worktree consumers pass typed rows, status metadata, disabled reasons, and actions. Do not collapse
  resume sessions and worktrees into one overloaded domain model.
- **Concept-matching layout.** The modal is centered, has an input/header row, an escape hint, rows with a
  current/health marker, primary label, subdued metadata, right-aligned status, selected-row highlight, and a
  footer with keyboard hints. Worktree stories should match the provided concept closely before app wiring.
- **Interaction contract.** Arrow keys navigate, Enter selects, Escape closes, search filters rows without
  resizing the shell, disabled rows remain visible with a reason, and the selected row stays visible while the
  list scrolls.
- **Approval gate.** Resume and worktree integration wait until the Storybook command modal states are approved.
  The first live feature using it must not fork the visual or keyboard behavior.
- **Validation target.** Stories and tests should cover default, selected, disabled, empty, loading, long label,
  narrow viewport, many rows, keyboard navigation, search filtering, footer hint rendering, and accessible names.

### Soon: explicit resume command/list <!-- D-090 -->

Fresh sessions are the default. Resume is an explicit user action that selects an existing durable session; it is
not inferred from cwd, clear, or cd.

V1 comparison: V1 supports an explicit `/resume` overlay and startup `--resume` path, and its tests distinguish
choosing a previous session from replaying stale transcript into the current view. V2 should keep the explicit
choice but implement it through the browser/Richter/session-store architecture.

V2 comparison: V2 now has durable session logs, project launch, `/clear` creating a fresh session, `/cd`
switching to a fresh session for another directory, and `session.switch` for host-authored handoff. It lacks a
session inventory/read model, a browser resume chooser, and lifecycle logic to ensure the selected session has
the right host.

- <!-- D-090 --> **Resume is explicit only.** `/resume` and its UI affordance open a session chooser. No cwd
  navigation, project launch, clear, or browser reload auto-loads prior history unless the user selects a
  session to resume.
- **Current project first, global searchable.** The default list is scoped to sessions for the current project
  or cwd when known. Search can find all sessions. Rows show session id/title, cwd/workspace, branch/status
  when known, created/updated time, host presence, active/queued state, and recent activity.
- **Host-controlled inventory.** The host or launcher/supervisor owns session discovery and lifecycle metadata.
  The browser renders a read model and sends a selected session id; it does not scan local state directly.
- **Use the shared command modal.** The resume chooser is a D-089 consumer. Build its fixture states in
  Storybook first: current project rows, global-search results, empty, stale host, active host, queued/running,
  long session names, and disabled/switch-blocked rows.
- **Switch semantics.** Selecting a session navigates the browser to that durable session, resets repo-scoped
  prompt state, clears browser-local drafts/queues for the old session, and ensures or reuses the matching host
  through the launcher/supervisor path. It must never merge transcripts or replay selected history into the old
  session.
- **Validation target.** Tests should cover no implicit resume, inventory ordering/scope, global search,
  selected-session navigation, stale/dead host handling, active-run blocking or disabled state, draft/queue
  isolation, and exact durable log replay for the selected session only.

### Soon: managed worktrees and workspace switcher <!-- D-091 -->

Managed worktrees create isolated workspaces for parallel work under Trevor control. The worktree switcher is a
Storybook-first consumer of the shared command modal, visually grouping the baseline checkout and Trevor-managed
worktrees for one base repo.

V1 comparison: V1 has a worktree overlay, slash commands for worktree switching, workspace git status, and
smoke coverage around worktree behavior. It also carries substantial safety machinery around workspace
switching. V2 should carry forward the safety posture while using browser sessions, host lifecycle, and the
shared command-modal pattern.

V2 comparison: V2 now has fresh-session `/clear`, `/cd` workspace switching, host-announced cwd/workspace, and
sidebar branch status as D-088. It lacks a Trevor-owned worktree registry, managed worktree creation, visual
grouping by base repo, cwd-level advisory locks, and merge/reconcile/delete flows.

- <!-- D-091 --> **Managed worktrees live under Trevor state.** Trevor-created worktrees are recorded in a
  registry under local state and placed under `~/.trevorV2/.worktrees/<repo-hash>/<branch-slug>-<id>` or an
  equivalent grouped path. The registry records base repo identity, base path, worktree path, branch, base
  commit, current commit when known, associated session id, created/updated time, and status.
- **Create/open/switch flow.** From a base repo, Trevor can create a managed worktree and make it the current
  cwd/workspace/session target. Existing managed worktrees can be opened or switched to without recreating
  them. The baseline checkout remains visible as the baseline row.
- **Use the shared command modal.** The worktree switcher is a D-089 consumer. Build the switcher in Storybook
  first using the provided concept: baseline, active worktree, clean, dirty, ahead/behind, idle, agents running,
  needs-you, rebase conflict, disabled switching, empty, and many rows.
- **Visual grouping.** Rows are grouped by base repo and show branch/worktree name, dirty/ahead/behind deltas,
  current marker, host presence, agent count or activity, conflict/needs-user state, and whether the row is the
  baseline checkout.
- **Switch safety.** Switching is blocked while host-owned execution is active in the current workspace. Cwd-level
  advisory locks prevent two Trevor-owned mutating hosts from acting on the same directory. Switching resets
  repo-scoped prompt state, drafts, queues, live task state, and host context so execution cannot leak across
  workspaces.
- **Merge/reconcile/delete.** The first slice may stop at create/list/switch, but the feature plan includes a
  later merge/reconcile/delete milestone: inspect diff, merge or rebase back to the base repo, surface
  conflicts, and require confirmation before deleting dirty or conflicted worktrees.
- **Validation target.** Tests should cover registry persistence, path hashing/grouping, Git worktree creation,
  switch handoff, active-run blocking, cwd-lock contention, dirty/conflict display, baseline/worktree grouping,
  no transcript/prompt leakage across switches, and merge/delete confirmation behavior when that milestone is
  implemented.

### Soon: session recall <!-- D-044 -->

On-demand retrieval of older conversation detail that is no longer in the model's active prompt. The durable
session log survives compaction (D-042), but the active prompt projection intentionally drops or summarizes old
detail. Session recall gives the model a way to search that unavailable-to-context history when the user asks a
question that needs remembered prior discussion.

Despite the name, the intended scope is the **project's session corpus**, not only the currently active durable
session. It searches compacted-away detail inside the current durable session and other durable sessions for the
same project/workspace. It does not search recent visible turns that are already in the active prompt.

Recall runs as an **isolated sub-agent**: a search hit is an *anchor*, not the answer - the substantive
discussion may live in the turns *around* the match, sometimes while those turns were nominally about another
topic. Recall expands each anchor to its **neighborhood** and reasons over those neighborhoods with its own
context budget, returning only distilled, cited findings to the main turn.

- <!-- D-044 --> **`session recall` tool**, model-driven. There is no slash command in the first cut. The model
  decides to call the tool after a user asks something that needs older project/session memory. Search = **BM25**
  (lexical, ranked, no embeddings/index infra) over recallable conversation records, combined with structured
  pre-filters such as session/project, turn range, event type, tool name, and folded-span id.
- **Recallable corpus.** Include compacted-away detail in the current durable session plus other durable
  sessions for the same project/workspace. Exclude recent turns already present in the active prompt. The
  project mapping should use the same root/session identity model as the launcher and resume/session inventory.
- **Citations and traceability.** Results carry stable source pointers: session id/label, workspace/project,
  turn id or event range, timestamp, excerpt, match score, and neighborhood bounds. The final assistant answer
  may cite human-readable session labels/timestamps, while ids remain available for debugging and audit.
- **Visible UI result.** Recall is not hidden reasoning. The transcript shows a visible `Session recall`
  tool/result with a compact summary such as sessions searched, folded spans searched, and neighborhoods found,
  plus collapsed or compact source rows/snippets. Design this result state Storybook-first before app wiring.
- **Deferred ambient memory.** Automatic/ambient remembering or proactive injection stays deferred. The first
  cut only recalls when the model explicitly calls the tool in response to the user's current task.
- **Depends on:** subagent isolation, D-042 compaction fold metadata, session inventory/project mapping from the
  session-manager work, and a visible tool-result rendering path. Distinct from the §7 backlog "Code retrieval /
  search" row, which searches the *codebase*, not the conversation log.

### Soon: image attachment UX - inline tokens, transcript images, carousel <!-- D-092 -->

Trevor already has blob-backed image artifacts (D-028), but the browser image experience is still too coarse.
Images are attached as a side list, user transcript rendering uses generic thumbnails, and queued prompts do not
show the precise position where an image was inserted. The desired UX is closer to V1's `[Image #N]` token
model, adapted to V2's content-addressed blob store and browser UI.

V1 comparison: V1 inserted `[Image #N]` tokens at the cursor for pasted image paths or clipboard images,
preserved those token positions in the transcript, stripped the tokens from provider text, and sent the images
as hidden attachments. It also had extensive clipboard-image paste handling for terminal limitations. That
token model carries forward; the terminal-specific clipboard machinery does not.

V2 comparison: V2 already uploads picked, pasted, or dropped files to the blob store as `ArtifactRef`s; `user.message`
carries `artifacts`; the send queue preserves attached artifacts; the host resolves image blobs for vision
providers; and transcript replay keeps artifact refs. What is missing is inline attachment placement, token
highlighting, hover preview, responsive natural transcript image layout, and a same-message image carousel.

- <!-- D-092 --> **Storybook-first image attachment UX.** Build the composer token states, queued prompt states,
  transcript image layout, hover preview, and carousel dialog in Storybook before live wiring. Use production
  components and fixture `ArtifactRef`s; do not create a story-only image renderer that can drift from replay.
- **Inline `[Image #N]` text tokens, not rich embedded editor nodes.** Keep the normal text composer behavior,
  but render an overlay or mirror layer that syntax-highlights `[Image #N]` ranges and provides hover/focus
  affordances. The visible token text remains part of the draft and transcript so placement is explicit.
- **Insertion and deletion contract.** Pasting with Cmd+V, dropping, or picking an image uploads it, inserts
  `[Image #N]` at the cursor, and adds spacing so the token does not stick to adjacent words. Backspace/Delete
  next to a token removes the whole token and its artifact ref in one step. Removing a token keeps text and
  attachment refs in sync; token numbers should stay deterministic in reading order.
- **Hover preview.** Hovering or focusing a token shows a small image preview popover sourced from the blob
  store. The preview is bounded to 300px wide and 300px tall, preserves aspect ratio, and degrades to a broken
  or unavailable state without hiding the token.
- **Queue preservation.** A queued prompt must render the same inline token text and carry the same artifacts
  while waiting. Hard steer keeps queued image tokens and attached artifacts together instead of flattening the
  image placement into a side list.
- **Transcript natural image layout.** Submitted user messages preserve token positions in text and render the
  attached images at their natural dimensions, constrained by responsive max width and max height per image.
  Images must not be cropped by default; use contained sizing with original aspect ratio. Multiple images in one
  user message belong to one image set.
- **Same-message carousel.** Clicking any transcript image opens a centered dialog carousel for the images in
  that same user message. The carousel is not full screen, but large enough for inspection; it supports previous
  and next controls, keyboard navigation, Escape close, image count, and responsive sizing.
- **Provider projection.** The model-facing text should not include literal `[Image #N]` tokens unless a
  provider requires a textual marker. For providers that support image blocks, preserve the user-visible order as
  much as the adapter allows by interleaving text and image blocks or, where the provider API only supports a
  text block plus images, stripping tokens from text while sending images in token order. Non-vision providers
  receive a clear attachment note.
- **Validation target.** Tests should cover token insertion at cursor, auto spacing, Cmd+V image paste, multi-image
  paste/drop, one-step token deletion, token/ref synchronization, queued prompt rendering, hard-steer preservation,
  transcript natural sizing, same-message carousel navigation, broken/unavailable image states, and provider
  projection stripping or converting tokens while preserving image order.

### Soon: internet connectivity awareness <!-- D-060 -->

This is the narrowed version of the old "offline detection & recovery" backlog item. It is **not shipped yet**:
today the app can observe local session transport status, live host presence, and provider-stream failures, but it
does not proactively know whether the host can reach the public internet beyond the LAN.

- <!-- D-060 --> **Host-owned internet status, not browser-owned.** The host decides whether the host machine
  appears connected to the public internet. Browser `navigator.onLine` is at most a UI hint: it can report a
  network interface while DNS/WAN/captive portal is broken, and in remote/multi-device setups it describes the
  browser machine, not necessarily the host machine.
- **Separate local transport from internet reachability.** A closed browser/session WebSocket, a missing host, and
  public-internet outage are different states with different fixes. Do not infer "internet offline" from local
  session-store or Richter disconnect alone. Keep host presence/status UI separate from internet-connectivity notices.
- **One check, one meaning.** Add a host-side connectivity service with a small WAN probe (DNS + HTTPS to
  configured public endpoints, cached briefly, about 30s). It reports `online`, `offline`, or `unknown`, plus a
  transient `checking` flag while a probe is in flight, last checked time, staleness, and last sanitized probe
  error. It does not classify provider health, provider auth, provider overload, rate limits, or model availability.
- **Refresh and protocol shape.** Probe on host start, reuse the cached snapshot for ordinary UI reads, allow an
  explicit UI refresh, and optionally kick an async refresh before a cloud turn when the snapshot is stale. Refresh
  must not block the turn. The latest snapshot is included on `host.online`; later changes or refresh completions
  emit a small `host.internet` status event. These events are live status, not conversation memory.
- **No automatic model switching.** If the user selected a local model, the turn uses that local model. If the
  user selected a cloud model, the turn uses that cloud model. Cloud failures never trigger a local turn, and
  offline status never silently rewrites the user's selected model. Do not add pre-turn cloud-to-local fallback,
  reactive local retry, or an `assistant.providerFallback` event for this item.
- **User-visible advisory only.** Internet status can appear near the model/source area, in the model-source
  chooser, logs, Storybook states, and `/doctor`. If the selected model is cloud and the host is currently offline,
  the UI may warn, but it must not substitute a local model or route the turn elsewhere without explicit user
  action. Local-model turns are unaffected by offline status.
- **Doctor/debug surface.** `/doctor` should show host internet status, last probe time, last probe error, and
  probe target class without dumping credentials or full request payloads. It should also show staleness/checking
  state and sanitized DNS/HTTPS failure class. It should not report a fallback target because this feature has no
  fallback behavior.
- **Validation target.** Tests should cover LAN-up/WAN-down status, browser `navigator.onLine` disagreeing with
  the host probe, local session-store disconnect not implying internet offline, cloud request failure not causing
  a local retry, local-selected turns unaffected by offline status, cloud-selected UI warnings while offline,
  `checking`/stale rendering, and UI rendering of the advisory status.

### Later: browser/terminal session manager <!-- D-061 -->

Trevor should support the browser workflow without losing the old terminal ergonomics. D-085 is the first
concrete slice: `trevor` from a project root opens the browser session and starts/reuses the matching host.
The remaining D-061 work is the richer session-management layer around that launcher. It is **not shipped yet**
and does not change the current manual `SESSION_ID` + `TREVOR_WORKSPACE` behavior until D-085 lands.

- <!-- D-061 --> **Cwd-targeted launch is now specified by D-085.** The terminal entrypoint is named `trevor`;
  it resolves a canonical project root, derives or looks up the session id, ensures shared services, starts or
  reuses the matching host runtime, and opens the web UI directly to that session. The cwd/workspace must be
  recorded as session/host metadata, not inferred from whatever directory the monorepo dev script happened to use.
- **Browser-created sessions.** The web UI gains a create-session flow that accepts a target folder, creates a new
  durable session for that folder, starts the corresponding host runtime through the available supervisor/launcher,
  and navigates into the session once the host announces `host.online`.
- **Session navigation sidebar is now specified by D-093.** The UI needs a first-class left-sidebar
  session list showing current-project sessions, live activity, and recency. URL `?session=` remains a deep-link
  mechanism, but not the only way to move between sessions.
- **Explicit resume is now specified by D-090.** Resuming a durable session is a user-selected command/list flow,
  not an implicit cwd lookup or default browser reload behavior. D-061 keeps the broader session manager
  lifecycle, while D-090 is the near-term resume slice.
- **Session lifecycle controls are now specified by D-094.** Cancel remains the ordinary UI action for active
  work. Stop, kill, archive, unarchive, list, and open are lifecycle/management controls, exposed first through
  CLI and debug-mode UI rather than normal chat/sidebar controls. Lifecycle operations must not delete durable
  session logs unless an explicit future archive-browser delete action does so with confirmation.
- **Relationship to Phase 3.** This dovetails with the desktop shell's one-host-per-session/cwd model (D-021-D-024),
  but now ships through the browser-era launcher/supervisor path in D-085. It must preserve D-014: browser and host
  still communicate only through the session log; any launcher/supervisor owns lifecycle only.

### Soon: session navigation sidebar - current project only <!-- D-093 -->

This is the first concrete remaining slice of D-061 after the shipped launcher (D-085), shared command modal
(D-089), explicit resume (D-090), and managed worktree switcher (D-091). It makes session switching a normal
browser navigation surface instead of treating every session change as a resume action.

- <!-- D-093 --> **Left-sidebar session navigator, Storybook-first.** Build the sidebar surface in Storybook
  before app wiring. Use a dashboard-style icon in the upper-left as the entry point for focusing or opening the
  session navigator. This is not a landing page and not a separate global dashboard.
- **Current project only.** The sidebar lists sessions for the current project/root only. It must not show other
  projects in the current working directory context, and it must not inherit any global-session search behavior
  from resume unless the user explicitly asks for that later.
- **Recency order, no grouping.** Sort sessions by most recent activity in the current project. Do not add project
  grouping for this cut. Rows should show enough identity to distinguish sessions: title or first prompt, branch
  or worktree when known, live/running/queued/settled state, and last activity.
- **Live activity across sessions.** A session that is running, queued, or recently settled remains visible while
  the user is viewing another session. The row should show that work is happening or when it last settled.
- **Relative time policy.** Use relative time in seconds, minutes, hours, days, and weeks. Never render months.
  Render week-based labels through 10 weeks; older than that uses a specific date.
- **Stale/inactive host state.** Avoid exposing "no-host session" as user-facing vocabulary. If a durable session
  has history but no currently attached host, show it as stale or inactive and make its runnable limitations clear.
- **Switch semantics.** Selecting a session uses the same safe switch path as D-090: no transcript merge, reset
  draft/queue/session-scoped state, keep URL deep-linking, and block or disable switching while the current session
  has active execution.
- **Resume relationship.** `/resume` can remain the keyboard/search command view over the same current-project
  inventory and switch action. The sidebar is the everyday visual navigation surface; resume is the explicit
  command/search entry point.
- **Validation target.** Tests and stories should cover empty, current session, many sessions, long titles,
  running, queued, settled, stale/inactive, recent seconds/minutes/hours/days/weeks, date fallback, active-run
  switch blocking, no cross-project rows, and no transcript/draft/queue leakage on switch.

### Soon: session lifecycle controls - stop, kill, archive <!-- D-094 -->

This is the D-061 lifecycle-management slice that sits beside the D-093 sidebar navigator. It defines what it
means to cancel active work, stop a session host, force-kill a wedged host, and hide a durable session from normal
lists without deleting its history.

- <!-- D-094 --> **Cancel stays the normal UI action.** Escape or the existing cancel affordance cancels the
  active turn/work item and leaves the host attached to the session, ready for the next prompt. Cancel is not
  session shutdown.
- **Stop is graceful session-level shutdown.** Stop cancels active work, clears queued work for that session, asks
  the host to shut down cleanly, releases its runtime/lease/ownership record, and keeps the durable Richter log.
  A passive browser disconnect is not stop.
- **Kill is forceful host termination.** Kill is the escalation path for a wedged or unresponsive host. It keeps
  the durable session log but may leave an in-flight turn with an aborted or unknown terminal state if the host
  cannot write a clean cancellation event.
- **Archive is metadata hiding, not deletion.** Archive sets an `archived` flag on durable session metadata.
  Archived sessions disappear from the normal sidebar, current-project navigation, and default resume/list views.
  They remain in Richter and require explicit unarchive before normal opening/use.
- **Archive browser/delete deferred.** Archived sessions can be viewed through an explicit archive browser/filter
  or CLI archived list. Permanent delete is only allowed from an archive browser later, with strong confirmation,
  and deletes the durable session log from Richter.
- **Primary UI boundary.** Normal UI should not expose stop, kill, or archive as ordinary row/chat actions in the
  first cut; debug-mode UI may expose them. D-093 only needs to respect archived filtering.
- **CLI surface.** Provide `trevor list`, `trevor list --archived`, `trevor open <session>`,
  `trevor archive <session>`, `trevor unarchive <session>`, `trevor stop <session>`, and
  `trevor kill <session>`. `open` is resume-like: it opens the browser and starts or attaches the matching host
  when possible.
- **Validation target.** Tests should cover cancel vs stop, stop canceling active and queued work without deleting
  history, kill preserving logs while terminating a host, archive/unarchive filtering, CLI list/open/archive/
  unarchive/stop/kill behavior, debug-only UI exposure, and D-093 excluding archived rows by default.

### Deferred: provider auth/catalog + full model chooser <!-- D-065 -->

The current web selector is intentionally simple: it renders the host-announced provider roster from D-059.
That does not scale to OAuth subscriptions, single-endpoint gateways with hundreds or thousands of models,
manual local entries, direct API-key providers, and per-model reasoning controls. When picked up, build a
host-owned model-source/catalog layer and a chooser surface that can browse large dynamic catalogs without
turning the chat input into a giant dropdown.

- <!-- D-065 --> **Model sources are the product unit above providers.** A source is one configured runtime,
  account, endpoint, or gateway. First-class source types are `local` (LM Studio, local Ollama, manually
  defined local endpoints/models), `oauth_subscription` (OpenAI Codex/ChatGPT subscription, Anthropic Claude
  subscription, GitHub Copilot, and future allowed first-party subscriptions), `gateway_catalog` (OpenRouter,
  OpenCode Zen/Go, Ollama Cloud, or another approved model gateway with a large catalog), and
  `direct_api_key` (OpenAI API, Anthropic API, Google Gemini/Vertex, DeepSeek, ZAI, MiniMax, Mistral, xAI,
  Groq, Together, Fireworks, Bedrock, Azure OpenAI, and similar direct-billing providers).
- **Source state is explicit.** Local sources report runtime reachable/unreachable, discovered/manual,
  loaded/loading/available when known, and local context/capability metadata. OAuth sources report needs
  sign-in, connected, expired, refresh failed, and subscription/catalog unavailable. Gateway and direct-key
  sources report needs key, configured by host auth JSON, key rejected, catalog fetch failed, stale catalog,
  and catalog refresh in progress.
- **Host owns source status and catalog freshness.** The browser must not hardcode model lists or infer auth
  truth locally. The host announces source summaries and serves model catalog queries. Refresh triggers:
  host start, login/logout/key changes, manual refresh, and provider-specific TTL expiry. Catalog refresh is
  non-blocking for ordinary turns; stale catalog data stays visible with a freshness marker and a retry action.
- **Catalog entries use stable model references.** A selected model is identified by `{sourceId, modelId}`
  plus enough resolved provider/api metadata for the host to execute it. Each catalog entry should include
  display name, provider/source label, source type, local/cloud kind, auth state, availability, detected
  capabilities (`tools`, `vision`, `reasoning`, context window, max output when known), optional pricing/cost
  tier, optional latency/quality labels, aliases/family tags, and catalog freshness/source.
- **Large catalogs need queryable APIs.** The protocol must support search text, source filters, capability
  filters, provider/family filters, configured-only, recent/pinned/recommended subsets, pagination or cursoring,
  and result caps. The UI may virtualize rows, but the host/session protocol should not require sending every
  gateway model to the browser on every `host.online` event.
- **Reasoning is selected per model, not globally guessed.** Each catalog entry exposes its detected reasoning
  surface: unavailable, off-only, off plus levels, auto/adaptive plus levels, or provider-specific mapped
  levels. The chooser and sidebar may only present supported choices. If a model supports disabling reasoning,
  `off` is a valid explicit value. Persist the selected/default reasoning per model reference where possible,
  with a source/model default value when no explicit per-model value exists.
- **Sidebar entry is a split control.** The sidebar keeps showing the active model name, and the thinking
  level/toggle/switcher remains underneath that model name. The larger left side of the active-model control
  opens the full chooser by replacing the transcript/prompt area with the responsive source overview/detail
  surface. The right-side chevron keeps the existing small popup behavior, but narrows it to a quick
  categorized picker of recently used models only; it must not become the large catalog browser. Both clickable
  regions should use `cursor-pointer`, and a visible vertical divider separates the chevron quick-popup region
  from the larger full-chooser region.
- **Chooser actions are source-aware.** Depending on source/auth state, actions include sign in, re-login,
  provider-code/device-code flow steps, refresh catalog, open local runtime/setup instructions, use model, set
  default, pin/unpin, and remove/disable a manual source. Auth/setup failures are visible for that source without
  blocking browsing other configured sources.
- **No key entry in the chooser.** API keys, env-derived credentials, and direct-provider secrets live in the
  host-owned auth JSON store, not in the model chooser UI. The chooser may show missing/rejected/stale auth
  states, provide OAuth or provider-code links, accept non-key flow codes when the provider protocol requires
  them, refresh host auth state, and point to setup instructions, but it must not render an API-key paste form.
- **Preferences and wire events must carry both model and reasoning.** Keep backward compatibility with the
  current `provider` string during migration, but move toward a stable selected-model contract:
  `{sourceId, modelId, reasoning}` on user turns and host preferences. The host resolves that to the actual
  provider adapter and request options. Persist the active model, default model, recent models, pinned models,
  and per-model reasoning selection in the session/user preference layer.
- **First cut is one active chat model.** This chooser selects the single active model source for normal chat
  turns. Future role-specific model assignment - autocomplete ghost text, compaction, summarization, subagents,
  or background helpers - is deferred and must not expand this first-cut chooser into a routing or policy engine.
- **Use pi-ai where it owns the problem, wrap where Trevor owns product behavior.** After the SDK migration to
  `@earendil-works/pi-ai`, use its provider factories, auth resolution, OAuth refresh, credential-store
  contract, generated model metadata, dynamic-provider hooks, and reasoning capability helpers where they fit.
  Trevor still owns the shared `~/.pi/auth.json` integration, UI actions, source grouping, local LM Studio
  readiness/loading, session preference persistence, catalog query protocol, and any provider not officially
  supported by pi-ai.
- **Explicit exclusions for this item.** Do not reintroduce the dropped routing engine or model-led routing
  classification. Do not auto-switch models based on prompt intent, connectivity status, or provider failure.
  Do not assume Google Antigravity support until there is an official allowed integration. Do not make gateway
  catalog refresh a turn-start blocker. Do not render every gateway model in a single popup.
- **Validation required.** Tests/evals must cover: thousands of gateway models without rendering/sending all
  rows eagerly; search and filters across source types; OAuth signed-in/signed-out/expired states; direct-key
  configured/missing/rejected states from the host auth JSON store; no API-key paste form in the chooser; local
  runtime offline/online states; reasoning choices constrained to
  each model's detected capabilities; persistence of active/default/recent/pinned models; backward-compatible
  provider selection during migration; and no turn blockage when a catalog refresh is slow or failed.

### Then: provider-outage auto-reconnect recovery <!-- D-076 --> (Phase 4 M3)

Sequenced as **Phase 4 M3** - right after the `@earendil-works/pi-ai` SDK migration (Phase 4 M1/M2),
built on the maintained SDK's error surface. A provider connection that drops mid-turn is a transient
fault to retry, not an instant dead end. Today a Codex WebSocket drop (or any non-auth, non-overflow
stream failure) surfaces terminally as `${provider} unavailable: …` (`providers/errors.ts`) and the user
must resend; this lets Trevor ride out a transient blip on its own. Sibling to the shipped graceful
overflow recovery (D-034…D-038): same "adjust-and-continue, communicated, bounded" posture, applied to
transport faults instead of context pressure.

- <!-- D-076 --> **Scope - auto-retry the current step, bounded.** On a retryable provider outage the
  agent loop re-runs the current step with bounded exponential backoff (3 attempts, ~300ms·900ms +
  jitter), then surfaces terminal once the budget is spent. The retry budget is per-step and independent
  of `MAX_STEPS` and the overflow recovery budget, so recovery cannot spin.
- <!-- D-077 --> **Classification at the provider boundary.** A single retryable verdict is decided where
  provider errors are built (the `ProviderErrorClassifier` seam): transient transport faults (WebSocket
  drop, connection reset, timeout, HTTP 429/5xx) are `retryable`; auth and context-overflow keep their
  existing dedicated handling (re-auth message / overflow recovery); every other outage stays terminal.
  The classifier owns the retryable/terminal decision; the loop reads a boolean.
- <!-- D-078 --> **Safety gate - only retry before output starts.** Auto-retry fires only when the failed
  attempt emitted no tokens yet (`emitted == 0`). Once any text/thinking/tool-call has streamed, the turn
  goes terminal and the user resends - a partial stream cannot be transparently resumed, only restarted,
  which would duplicate output. Interrupts (ESC/cancel) ride the interrupt channel, not the error channel,
  so they are never retried and cancel stays instant, even during a backoff wait.
- <!-- D-079 --> **Communicated + observable.** Each retry emits a live `assistant.reconnecting {runId,
  attempt, detail}` status (sibling to `assistant.recovered`), surfaced in Trevor web as a
  "reconnecting… (attempt k/3)" marker; the terminal error block is unchanged and appears only when the
  budget is exhausted or the failure is non-retryable. Correlated by `runId`.
- **Unknown-shape observation capture.** Provider failure shapes that are unknown or low-confidence are stored as
  redacted, deduped observations under Trevor home (`TREVOR_HOME`, default `~/.trevorV2`) so the classifier can
  improve over time. The record keeps provider/source/model, phase, status/code fields, sanitized message,
  top-level shape/field names, output-started flag, classifier verdict, retry decision, and a fingerprint. It
  never stores prompts, API keys, auth headers, raw response bodies, or raw tool outputs by default.
- **Validation.** Deterministic with `@effect/vitest` + `TestClock` (no real waits) and a fake provider
  that fails N times then succeeds: a transient drop before the first token recovers transparently; a drop
  after output goes terminal; an interrupt during backoff cancels cleanly; auth/overflow paths unchanged.

### Then: remaining KEEP features not yet built

Sequence as each is picked up (no hard order locked here):
- **Auth / OAuth login** is specified as part of D-065: source-aware sign-in/re-login actions, OAuth refresh,
  shared auth-store integration, and provider catalog status (H-019, H-155).
- **Internet connectivity awareness** is specified above as D-060: host-owned public-internet status only, with
  no automatic local/cloud switching or retry behavior (H-026, H-093).
- **Settings & preferences** for model/provider/thinking mode are specified as part of D-065; deeper
  **usage/metrics** surface remains separate (H-031, H-034).
- **Browser/terminal session manager** is specified above as D-061: cwd-targeted terminal launch, browser-created
  folder sessions, session navigation, and kill/stop from terminal and UI.
- **Session navigation sidebar** is specified above as D-093: current-project-only left-sidebar session
  navigation, upper-left dashboard icon, recency ordering, live activity rows, relative time policy, and shared
  switch semantics with resume.
- **Session lifecycle controls** are specified above as D-094: cancel vs stop vs kill semantics, archive/unarchive
  metadata, CLI list/open/archive/unarchive/stop/kill, debug-only lifecycle UI, and normal UI archive filtering.
- **Headless CLI / TypeScript SDK / harness** is deferred below as D-095: Trevor is already headless-capable at
  the transport/runtime layer, but a first-class CLI, TypeScript SDK, and code-harness API need later discussion
  before decomposition.
- **Local observation corpus / classifier learning** is deferred below as D-096: provider failure observations
  are the first concrete use, with later expansion to tool-result patterns, repeated calls, attempts-to-goal
  signals, prompt/harness guidance, and possible future task classification.
- **Vim motions in UI/UX** is deferred below as D-097: evaluate `vimeejs/vimee` and start small with prompt input
  motions before broader UI adoption.
- **Prompt composer recovery/history** is specified above as D-083/D-084: debounced tab-local draft
  persistence plus terminal-style Up-arrow/Down-arrow prompt recall for submitted prompts and bang shell
  commands.
- **Project launcher** is specified above as D-085: type `trevor` from any project to open the browser session,
  start/reuse the matching host, and avoid manual `SESSION_ID`/`TREVOR_WORKSPACE` wiring.
- **Early transcript layout** is specified above as D-086: new/short browser sessions start at the top and grow
  downward until content overflows, then live-bottom following takes over.
- **Sidebar git identity** is specified above as D-088: Storybook-first cwd/branch display in the sidebar,
  with branch, dirty `*`, ahead/behind deltas, detached/non-git states, and host-owned structured git status.
- **Shared command modal foundation** is specified above as D-089: a reusable shadcn `Command` modal pattern
  for resume and worktree switching, built and approved in Storybook before live integration.
- **Explicit resume** is specified above as D-090: `/resume` and UI session selection are explicit only, current
  project first with global search, and never inferred from cwd, clear, cd, or reload.
- **Managed worktrees** is specified above as D-091: Trevor-owned worktree registry, Storybook-first switcher,
  create/list/switch flow, cwd locks, safety boundaries, and later merge/reconcile/delete.
- **Image attachment UX** is specified above as D-092: Storybook-first inline `[Image #N]` composer tokens,
  Cmd+V image paste, hover previews, queue preservation, natural transcript image layout, same-message carousel,
  and provider projection over existing blob-backed artifacts.
- **Nested command menu / `/style`** is extracted to `.plans/18-nested-command-menu`: a reusable hierarchical
  command-menu pattern with `/style` as the first consumer. Output styles are command choices, not prompt
  overlays, and remain presentation-only without task/routing semantics (formerly D-072 / H-164).
- **Doctor health surface** is specified below as D-073: V1-compatible structured diagnostics, rendered in
  Trevor web through Storybook-first responsive UI before app wiring (H-163).
- **Capability manifest + `trevor-expert`** is extracted to
  `.plans/19-capability-manifest-and-trevor-expert`: registry-derived full/compact self-description,
  `trevor-export`, and the built-in `trevor-expert` consumer, with general command/skill interpolation kept
  separately gated and disabled by default (formerly D-074 / H-156).
- **Agent / skill / slash discovery** depth (H-165 is now backlog under delegation; skill + slash discovery
  KEEP) is specified below as D-075: host-owned discovery registry, hybrid ambient skill roster, and explicit
  `skills_list` / `skill_view` drill-in (H-166, H-167, H-168).
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
| **Tangents** | H-030 | lateral exploration side-threads |
| **Bounded-child + takeover** | H-024, H-025, H-086 | host-owned constrained helpers + route escalation/takeover |
| **Managed worktrees + cwd locks + merge protocol** | H-140 | <!-- D-091 --> promoted to §6. Stable per-session git worktrees (paths/branches/hashes), cwd-level advisory locks, and a merge/reconciliation protocol remain prerequisite for mutating background subagents |
| **Code retrieval / search** | H-112, H-138, H-139 | code_search/code_index/project_retrieve/source_recall + retrieval daemon |
| **Archive tools** | H-114 | archive_read / archive_unpack + validators / media processors |
| **`video_inspect`** | H-115 | frame extraction from video |
| **`tool_script`** | H-118 | sandboxed read-only TS scripting with a tool bridge |
| **Ollama provider** | H-046 | native Ollama adapter (beyond LM Studio + Codex/pi-ai) |
| **Provider auth/catalog + model chooser** | H-019, H-031, H-034, H-046, H-155 | <!-- D-065 --> deferred. Host-owned model sources and catalog entries for local/manual models, OAuth subscriptions, large gateway catalogs, and direct API-key providers. Includes source-aware auth/setup actions, queryable large catalogs, per-model reasoning capability/selection, stable `{sourceId, modelId, reasoning}` preference/wire contract, and a full chat-area chooser opened from the sidebar model name |
| **Local admission control** | H-057 | token reservation, queue, concurrency for local models |
| **Secret resolution** | H-061 | runtime `op://` and `!command` resolution, gated/opt-in |
| **Deep telemetry** | H-072, H-073, H-101 | OTel span export + opt-in provider attempt JSONL traces + tool result cache |
| **Discovery registry + skill drill-in** | H-166, H-167, H-168 | <!-- D-075 --> deferred. Host-owned, UI-agnostic discovery for skills, slash commands, command families, and later agents. Preserve ambient skill awareness through a compact prompt roster, but move search/detail/full bodies behind `skills_list(query?, limit?)` and `skill_view(skillId)` |
| **Subagents: teams, verifier, bounded child, mutating background agents** | H-165 | general-purpose + explorer + ephemeral definitions + inline/async read-only background **promoted to §6 (D-045…D-049)**; multi-agent **teams**, the **verifier** flavor, **bounded-child**, and mutating background agents remain future. Mutating background agents depend on managed worktrees + cwd locks + merge protocol |
| **Shell interpolation (commands)** | H-175 | done for skills; extend `!cmd` / ` ```! ` to command files, same gating |
| **`shell.promote`** | H-035 | auto-promote-on-timeout: route bash/`/shell` through the supervisor and adopt a command that outlives its timeout as a tracked `pN` job. Sequenced after the Tasks tool (which is done) |
| **Headless CLI / TypeScript SDK / harness** | new | <!-- D-095 --> deferred discussion. V2 is currently headless-capable at the session transport and host-runtime layer, but the productized access surface is not designed yet. Later discussion must cover CLI commands, TypeScript package boundaries, launch/attach semantics, prompt streaming, session inventory/lifecycle, artifact upload, cancellation, safety, and test-harness ergonomics. This is separate from the dropped single-prompt `SDK ask()` shortcut and does not reintroduce that API by default |
| **Local observation corpus / classifier learning** | new | <!-- D-096 --> deferred pattern. Store redacted, deduped unclassified observations under Trevor home (`TREVOR_HOME`, default `~/.trevorV2`) so Trevor can improve classifiers and harness guidance over time. Provider failure observations from D-076 are the first use; later candidates include tool-result patterns, repeated tool calls, number of attempts to reach a goal, prompt/harness guidance signals, and possible model task classification. Observations are inspectable on demand and never automatically injected into prompts |
| **Vim motions in UI/UX** | new | <!-- D-097 --> deferred discussion. Evaluate https://github.com/vimeejs/vimee for adding Vim-style motions to Trevor UI/UX, starting small with the prompt input before considering broader navigation or editing surfaces |

**Nested command menu / `/style` (extracted).** The former D-072 output-style registry item has been moved to
`.plans/18-nested-command-menu`. The extracted plan reframes the work as a reusable nested command-menu pattern
with `/style` as its first consumer. Output styles are selected through command choices, not prompt overlays,
and remain presentation-only: they must never change provider/model, reasoning level, work kind, execution mode,
agent/subagent selection, tool access, validation policy, or whether a command/tool is allowed.

**Doctor health surface (deferred).** <!-- D-073 --> Replace the current V2 `/doctor` debug-style text dump
with a V1-inspired structured health surface. `/doctor` should answer: what is healthy, what is degraded or
broken, what evidence supports that, and what should the user do next. Raw host internals stay available
through debug/detail surfaces; they are not the default doctor experience.

The first V2 doctor implementation should include:

- **V1 behavior to carry forward.** `/doctor` is a host-owned immediate command with no model turn. The host
  builds a structured snapshot and emits an event such as `doctor.current`. The snapshot has a summary plus
  areas; checks/findings carry stable ids, status/severity, human labels, concise messages, evidence,
  source paths when relevant, timestamps, and next actions. Keep `/doctor` distinct from `host.debugInfo`:
  doctor is health and repair guidance; debug info is sanitized runtime internals.
- **Actionable areas.** The initial area set should cover Core, Session/Run, Providers/Models/Auth, Internet,
  Tools/Search, Web/Docs, MCP, LSP, Hooks, Storage/Roots, Workspace, and Updates/Version. Each area has a
  short verdict and bounded key facts. Examples: provider auth missing, cloud unreachable, local runtime
  unavailable, internet disconnected, `rg` available, `ast_grep` missing, Firecrawl unconfigured, docs cache
  stale, MCP server auth needed, LSP command missing, hook script missing/slow, state root not writable,
  workspace not a Git worktree, or active run stuck/turn ended without a clear reason.
- **Default output is not raw internals.** The default `/doctor` result should not show low-level fields like
  internal token caps, reload flags, lease timestamps, or raw provider structs unless they are directly needed
  to explain a finding. Raw evidence belongs in expandable detail, `/doctor full`, `/doctor json`, copied
  report output, or `host.debugInfo`.
- **Fresh but bounded checks.** `/doctor` may run explicit probes because the user asked for diagnostics, but
  every probe must be bounded by short per-check timeouts and an overall budget. Slow or unavailable checks
  degrade to `not_checked` or `timeout` with a next action instead of blocking the command. Reuse cached state
  where it is the authoritative source; do not run repairs or mutate config.
- **Storybook-first gate.** Build the Trevor web diagnostic dashboard in Storybook before wiring it to live
  app state. Use fixture `doctor.current` payloads to design and verify the responsive layout, density,
  severity styling, empty states, long paths, and next-action affordances. App wiring starts only after the
  stories cover the required states and look correct.
- **Responsive web layout.** Trevor web should render `/doctor` as a dashboard, not terminal-shaped text:
  summary strip, severity filters, responsive category grid, repeated diagnostic cards/items, clear status
  icons, short verdicts, key-value rows, next-action buttons/links, and expandable evidence/details. Mobile is
  one column; desktop uses a clean multi-column grid. The layout must avoid nested cards and oversized hero
  treatment.
- **Required Storybook states.** Stories must cover all-ok, mixed warnings/errors, many findings, all
  not-checked, loading/refreshing, stale snapshot, provider auth missing, local runtime unreachable, cloud
  unreachable, internet disconnected, MCP unconfigured/auth-needed/error, LSP missing/unavailable/diagnostic
  warning, hooks missing script/slow/trust changed, web fetch unavailable, Firecrawl key absent, docs stale,
  storage root invalid, workspace not Git, long paths/wrapping, mobile width, tablet width, and desktop
  two/three-column widths.
- **Command variants and actions.** Support refresh and inspection affordances without making the default noisy:
  refresh diagnostics, copy report, view JSON, and open relevant settings/details. If slash variants are added,
  prefer explicit forms such as `/doctor refresh`, `/doctor full`, and `/doctor json`.
- **Prompt and model guidance.** The model should treat `/doctor` output as host diagnostics when the user asks
  about Trevor health, setup, provider readiness, tool availability, or why a turn failed. It should not call
  `/doctor` as routine context gathering for normal coding work.
- **Validation required.** Tests/evals must cover snapshot schema stability, severity aggregation,
  next-action rendering, redaction, bounded probe timeouts, no model turn for `/doctor`, default output without
  raw debug dumps, `/doctor full` or JSON detail when implemented, Storybook coverage for every required
  state, responsive visual checks for desktop/mobile, and regressions proving style/layout does not hide
  errors, warnings, or next actions.

**Capability manifest + `trevor-expert` (extracted).** The former D-074 capability manifest item has been moved
to `.plans/19-capability-manifest-and-trevor-expert`. The extracted plan owns the registry-derived full/compact
manifest, `trevor-export`, and the built-in `trevor-expert` consumer. General command/skill interpolation is
kept as a separate configurable feature, disabled by default unless explicitly enabled through an env/trust
gate; built-in `trevor-expert` may use direct bounded host exports without depending on that global gate.

**Discovery registry + progressive skill drill-in (deferred).** <!-- D-075 --> Carry forward Trevor V1's
registry shape while preserving the useful current V2 behavior where the model knows that skills exist from
the start of a turn. This is a host-owned discovery protocol, not a Trevor web-only command palette.

The first V2 discovery implementation should include:

- **V1 and current V2 baseline.** V1 used a compact ambient skill roster plus `skills_list(query?, limit?)`
  and `skill_view(skillId)`. Current V2 uses a single `skill(name)` tool whose description carries skill ids
  and blurbs, then loads one full body. The target keeps the ambient awareness advantage, but replaces the
  single-tool-description roster with structured prompt context plus list/view tools. D-087 defines the
  project-local plus global/configured root order that this registry must read from.
- **First implementation slice is skills only.** The first cut should build the host-owned skill registry,
  ambient skill roster, `skills_list`, and `skill_view` before broadening to slash-command, command-family, or
  agent discovery. The registry data model should still be shaped so those later resource types can join
  without a rewrite.
- **Hybrid skill awareness contract.** Tool-enabled turns should receive a compact `Available skills` roster:
  skill id, short description, and optional trigger summary, capped and explicitly marked when truncated. The
  model must not be left in a state where it has to guess that skills exist before it can ask for them.
- **Explicit skill drill-in tools.** Add `skills_list(query?, limit?)` for compact searchable metadata and
  `skill_view(skillId)` for one full skill body. `skills_list` returns ids, descriptions, source/provenance,
  status, truncation, and match counts; it does not return full bodies. `skill_view` loads one selected skill,
  including body and source chain/override information when available.
- **Tool-schema and prompt budget posture.** Keep tool descriptions short. Do not stuff the entire skill roster
  into a tool schema. The compact prompt roster is the level-1 awareness surface; `skills_list` is level-1
  search/detail; `skill_view` is level-2 body loading. Large or dynamic inventories are summarized and queried,
  not dumped.
- **Source-of-truth registry.** The host owns discovery for skills, slash commands, command families, and later
  agents. Trevor web renders the structured registry/read models but does not independently scan the
  filesystem or invent slash/skill/agent inventories. Non-web clients can still use the same protocol. Skill
  rows include root kind, source path, selected/shadowed status, and disabled/truncated status where relevant.
- **Slash and command-family metadata.** Extend the command inventory beyond current `{name, summary, usage}`
  toward V1-style descriptors: owner, visibility, artifact type, argument metadata, routing mode, immediate
  host action, and command-family contract pointers. Rich helper UIs are optional renderers over that shared
  contract.
- **Agent discovery alignment.** Agent/subagent discovery stays separate from skill discovery but uses the same
  pattern: compact list/read model first, explicit body/detail view only when chosen, and no ambient dump of
  every agent definition. H-165 mutating/background agent behavior remains governed by the subagent backlog.
- **Prompt guidance.** Tell the model: if a visible skill matches the user's request, call `skill_view` before
  acting; if the compact roster is missing, truncated, too broad, or insufficient, call `skills_list(query)`;
  load only the specific skill intended for use; do not call `skill_view` for every listed skill; do not treat
  skills as mandatory when ordinary tools and repository context are enough.
- **Migration posture.** The current `skill(name)` tool may be kept temporarily as an alias or compatibility
  shim, but the planned public contract is `skills_list` plus `skill_view` with ambient compact roster context.
  Existing shell interpolation and skill parsing behavior should be preserved unless superseded by the
  discovery registry implementation.
- **Validation required.** Tests/evals must cover ambient skill awareness without full-body prompt bloat,
  truncated roster behavior, `skills_list` search and limits, `skill_view` loading exactly one body, unknown or
  disabled skill handling, source/override provenance, prompt guidance that prevents speculative all-skill
  loading, UI rendering from host read models, non-web client usability, and a model-behavior eval where the
  agent notices a relevant listed skill and opens only that skill.

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
  Accepted as a deliberate user action; revisit with a cwd-level advisory lock if it bites. Phase 4 keeps
  background subagents read-only for the same reason; mutating background agents wait for managed worktrees,
  cwd-level locks, and a merge/reconciliation protocol.
- **Silent turn-budget dead-ends (observed 2026-06-24).** A long turn that exhausts the fixed `MAX_STEPS`
  ends via `Stream.empty` and reads as a clean `assistant.completed`, with no answer and no signal - on the
  local 4-bit at 64k this hit five consecutive turns at the window's 16-18%. Addressed by graceful turn-budget
  termination (D-051…D-053): observable exit, forced synthesis, context-pressure budget.
- **Output styles can become hidden work modes.** If styles influence routing, tools, execution mode,
  or validation, they recreate a weaker version of the dropped work-kind/routing system and make transcripts
  harder to reproduce. Mitigation: styles are presentation-only command choices from
  `.plans/18-nested-command-menu`, with explicit source attribution, run metadata, prompt tests, and evals that
  prove tool/routing/execution surfaces do not change when the style changes.
- **Doctor can become either noise or a blocking health check (D-073).** A raw debug dump is hard to act on,
  while unbounded live probes can make diagnostics slow or flaky. Mitigation: `/doctor` returns structured
  health areas with status, evidence, and next actions; raw internals stay in detail/debug surfaces; probes are
  explicit, time-bounded, non-mutating, and degrade to `not_checked`/`timeout`; Storybook fixtures prove the
  web layout before runtime wiring.
- **Capability manifests and `trevor-expert` can bloat prompts or become stale docs.** A manifest or
  explainer skill that is handwritten or injected whole into normal turns becomes stale and expensive; a
  manifest treated as authorization blurs the tool boundary. Mitigation: derive it from registries, version
  it, expose full/export forms separately from compact scoped model context, summarize huge dynamic catalogs,
  make `trevor-expert` read deterministic host exports through bounded read-only calls, keep general
  interpolation separately gated and disabled by default, and keep execution authority at the existing
  tool/command/agent boundaries.

---
_Consolidated 2026-06-23: single plan; FEATURES.md + TABLED.md deleted and folded in; graceful-overflow-recovery merged (D-034…D-038); routing engine + T-1 dropped for good (D-032); work-kinds kept inert (D-039). Supersedes all prior Trevor V2 planning documents._

_Updated 2026-06-24: overflow recovery **shipped** (status event renamed `assistant.compacted` →
`assistant.recovered`; proactive prompt-estimate detection; 4-bit at 64k). **Cross-turn compaction** added as
the next feature (D-040…D-043: hybrid pin+drop+summarize; trigger = background-after-turn at 80% +
blocking-before guard + recovery airbag, compact-to ~50%; durable non-mutating `context.compacted` rolling
event with a per-fold delta manifest; tool-less ~1k summary on the turn model with a local↔cloud-routing future). **Session recall** added as
a post-subagents layer (D-044: isolated sub-agent, BM25 + neighborhood expansion over compacted-away current-session detail plus other durable sessions for the same project).
**Subagents** promoted from backlog to the feature after compaction (D-045…D-049: reusable
general-purpose + explorer agents, file-based discovery, inline + read-only background modes, strict context
isolation with forkable child runs, and runtime-minted ephemeral definitions; verifier/teams/bounded-child stay
backlog).
**Concurrent read-only tool execution** added as a small near-term phase after compaction (D-050: read-only
tools run concurrently under a bounded cap, mutating tools stay serial barriers, tool purity declared per-tool
via a defaulted `readOnly` flag and derived from the registry, results committed to the conversation in call
order). **Graceful turn-budget termination** added as a self-contained correctness phase (D-051…D-053:
the step-budget loop exit becomes observable via a `step_limit` event + `stepLimit` completion flag, the
budget forces a final tool-less synthesis instead of dead-ending on a tool result, and the cap is re-based on
context-window occupancy with `MAX_STEPS` demoted to a runaway backstop - motivated by the 2026-06-24 local
4-bit case where five turns died at exactly `MAX_STEPS=8` with the window at 16-18%). New decisions
**D-040…D-053 are authored here in markdown and still need syncing into `plan.db`** (canonical store)._

_Updated 2026-06-25: **Internet connectivity awareness** narrowed D-060. "Offline" now means only
host-observed public-internet connectivity status, not browser `navigator.onLine`, local session WebSocket
closure, host presence loss, provider health, auth failure, overload, or model availability. The deferred
feature covers a host-side WAN probe, advisory UI/status, `/doctor` diagnostics, and validation against
LAN-up/WAN-down scenarios. It explicitly rejects automatic cloud-to-local fallback, reactive local retry, and
`assistant.providerFallback` behavior. D-060 is authored here in markdown and still needs syncing into
`plan.db`._

_Updated 2026-06-25: **Browser/terminal session manager** added as D-061. This later feature covers
cwd-targeted launch from any terminal directory, browser-created sessions for a specific folder, session
navigation/switching, and explicit kill/stop controls from both terminal and UI. D-061 is authored here in
markdown and still needs syncing into `plan.db` alongside D-040-D-060._

_Updated 2026-06-25: **Search-tool upgrade** added as D-062, sequenced immediately after Phase 4 subagents
and before session recall. It keeps the model-facing `grep` tool name but replaces the implementation with a
ripgrep-backed backend, and promotes H-108 `ast_grep` into a read-only structural-search tool. D-062 is
authored here in markdown and still needs syncing into `plan.db` alongside D-040-D-061._

_Updated 2026-06-25: **Provider auth/catalog + full model chooser** added as D-065. The future chooser is a
host-owned model-source and model-catalog layer covering local/manual models, OAuth subscriptions, large
gateway catalogs, and direct API-key providers. It captures source auth/status, queryable large catalogs,
stable `{sourceId, modelId, reasoning}` selection, per-model detected reasoning controls, source-aware
setup actions, sidebar model/reasoning constraints, and tests for huge catalogs, auth states, local
availability, reasoning capability, persistence, and non-blocking refresh. D-065 is authored here in markdown
and still needs syncing into `plan.db`._

_Updated 2026-06-27: **Nested command menu / `/style`** extracted to `.plans/18-nested-command-menu`. The old
D-072 output-style registry framing is superseded: styles are selected through reusable nested command-menu
choices, not prompt overlays. `/style` is the first consumer of the shared pattern, with local-state persistence
and run attribution. Styles remain presentation-only and must not affect routing, work kind, execution mode,
tool access, agent selection, or validation._

_Updated 2026-06-25: **Doctor health surface** added as D-073. The deferred V2 feature replaces the current
debug-dump `/doctor` output with a V1-inspired structured health report: host-owned immediate command,
`doctor.current`-style snapshot, areas/checks/findings, severity aggregation, evidence, redaction, and next
actions. Trevor web must build the diagnostic dashboard in Storybook first using fixture snapshots, covering
responsive grid layouts and healthy/warning/error/not-checked states before live app wiring. Fresh probes are
allowed only when bounded and non-mutating; raw internals belong in detail/full/json/debug surfaces, not the
default doctor view. D-073 is authored here in markdown and still needs syncing into `plan.db` alongside the
remaining markdown-authored decisions._

_Updated 2026-06-27: **Capability manifest + `trevor-expert`** extracted to
`.plans/19-capability-manifest-and-trevor-expert`. The plan owns registry-derived full/compact manifests,
`trevor-export`, built-in `trevor-expert`, and the explicit boundary that general interpolation inside
skills/commands is a separate configurable feature, disabled by default unless enabled through an env/trust
gate. Built-in `trevor-expert` can use direct bounded host exports either way._

_Updated 2026-06-25: **Discovery registry + progressive skill drill-in** added as D-075. The deferred V2
feature carries forward Trevor V1's useful discovery shape while preserving current V2's ambient skill
awareness: every tool-enabled turn gets a compact skill roster, but searchable skill metadata and full bodies
move behind `skills_list(query?, limit?)` and `skill_view(skillId)`. The host owns discovery for skills, slash
commands, command families, and later agents; Trevor web renders structured read models instead of scanning or
duplicating inventories. D-075 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-073 and the extracted numbered plans._

_Updated 2026-06-26: **Discovery registry + progressive skill drill-in** clarified for first-cut scope. The
first implementation slice is skills only: host-owned skill registry, compact ambient roster, `skills_list`,
and `skill_view`. Slash-command, command-family, and agent discovery remain later extensions over the same
registry shape rather than first-cut scope._

_Updated 2026-06-26: **Prompt shell lane** added and promoted as D-082. Leading `!` in the prompt composer
runs immediately through the protected host shell path and renders as a dedicated user-visible shell transcript
block, without calling a model and without including command output in prompt context for the first cut.
**Prompt composer recovery/history** is captured as D-083/D-084: debounced tab/session draft persistence and
terminal-style Up-arrow/Down-arrow prompt recall. D-082-D-084 are authored here in markdown and still need
syncing into `plan.db` alongside D-040-D-081._

_Updated 2026-06-26: **Project launcher** added as D-085. The near-term browser workflow is `trevor` from any
project directory: derive the project session, ensure shared services, spawn/reuse the matching agent-host, and
open the browser tab without manual `SESSION_ID` or `TREVOR_WORKSPACE` setup. **Early transcript layout** added
as D-086: new/short browser sessions should start at the top of the transcript and grow downward until overflow,
then use live-bottom following. D-085-D-086 are authored here in markdown and still need syncing into `plan.db`
alongside D-040-D-084._

_Updated 2026-06-26: **Project-local skill roots** added as D-087. V2 should discover
`<workspace>/.agents/skills` before the existing configured/global skill root so projects can carry their own
skills without global installation. Project-local skills override broader skills by id, while `/skills` and the
future D-075 `skills_list`/`skill_view` surfaces retain source and shadowing provenance. D-087 is authored here
in markdown and still needs syncing into `plan.db` alongside D-040-D-086._

_Updated 2026-06-26: **Sidebar git identity** added as D-088, showing cwd plus structured branch, dirty,
ahead, and behind state in the sidebar after Storybook approval. **Shared command modal foundation** added as
D-089, using shadcn `Command` as the approved Storybook-first pattern for both resume and worktree switching.
**Explicit resume** added as D-090: session history is selected explicitly through `/resume` or UI,
current-project first with global search, and never loaded implicitly by cwd, clear, cd, or reload. **Managed
worktrees** added and promoted from H-140 as D-091: Trevor-managed worktrees under local state, a
Storybook-first switcher, create/list/switch flow, cwd locks, safety boundaries, and later
merge/reconcile/delete. D-088-D-091 are authored here in markdown and still need syncing into `plan.db`
alongside D-040-D-087._

_Updated 2026-06-26: **Session recall** (D-044) clarified before progress-report decomposition. The feature
keeps the name "session recall," but its scope is the current project's durable session corpus: compacted-away
detail in the current durable session plus other durable sessions for the same project/workspace. It is a
model-facing tool only, with no slash command in the first cut; it searches only material outside the active
prompt, returns cited neighborhoods through an isolated recall subagent, renders a visible Storybook-first
`Session recall` transcript result, and defers ambient/proactive remembering. D-044 still needs syncing into
`plan.db` alongside D-040-D-091._

_Updated 2026-06-26: **Image attachment UX** added as D-092. V2 keeps the existing blob-backed `ArtifactRef`
transport, but adds the user-facing image experience: inline `[Image #N]` text tokens in the composer,
syntax-highlighted through an overlay/mirror layer, Cmd+V image paste, one-step token deletion, hover previews
bounded to 300px, queued prompt preservation, natural transcript image sizing, same-message carousel, and
provider projection that strips or converts tokens while preserving image order. D-092 is authored here in
markdown and still needs syncing into `plan.db` alongside D-040-D-091._

_Updated 2026-06-26: **Internet connectivity awareness** (D-060) clarified for decomposition. The feature is
host-owned public-internet status only: `online`/`offline`/`unknown` plus transient checking, DNS plus HTTPS
public probes cached around 30 seconds, latest snapshot on `host.online`, refresh updates on `host.internet`,
advisory UI near model/source selection, `/doctor` diagnostics, and no automatic local/cloud fallback or routing.
D-060 still needs syncing into `plan.db` alongside D-040-D-092._

_Updated 2026-06-26: **Session navigation sidebar** added as D-093, a concrete remaining D-061 slice. It is a
Storybook-first left-sidebar session navigator opened or focused from an upper-left dashboard icon, scoped to the
current project only, ordered by recency without grouping, showing live running/queued/settled activity across
sessions, using seconds/minutes/hours/days/weeks relative time with no months and date fallback after 10 weeks,
and sharing safe switch semantics with resume. D-093 is authored here in markdown and still needs syncing into
`plan.db` alongside D-040-D-092._

_Updated 2026-06-26: **Session lifecycle controls** added as D-094, another concrete D-061 slice. Cancel remains
the normal UI action for active work; stop gracefully cancels active work, clears queued work, shuts down the host,
and keeps the durable log; kill force-terminates a wedged host while preserving history; archive/unarchive are
metadata hiding/restoring actions, not deletion; permanent delete is deferred to a future archive browser. The
first control surface is CLI plus debug-mode UI, with normal UI limited to filtering archived sessions out of the
main sidebar/resume views. D-094 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-093._

_Updated 2026-06-26: **Headless CLI / TypeScript SDK / harness** added to the unsequenced backlog as D-095.
Trevor is already headless-capable at the transport/runtime layer, but the first-class CLI, TypeScript SDK, and
code-harness API remain a later discussion before decomposition. This is explicitly separate from the dropped
single-prompt `SDK ask()` shortcut. D-095 is authored here in markdown and still needs syncing into `plan.db`
alongside D-040-D-094._

_Updated 2026-06-26: **Provider auth/catalog + full model chooser** (D-065) clarified before decomposition.
The chooser is source/model selection for one active chat model, not routing. The UI replaces the transcript and
prompt area while sidebars may remain visible, supports source-overview and source-detail views, and can show
OAuth/provider-code flow actions. API keys, env-derived credentials, and direct-provider secrets live in the
host-owned auth JSON store and are never pasted into the chooser. The sidebar model control is split: the
larger left side opens the full chooser, while the right chevron keeps a small categorized popup limited to
recently used models. Both hit targets should use `cursor-pointer`, with a visible vertical divider between
the quick-popup chevron and full-chooser regions._

_Updated 2026-06-26: **Provider-outage auto-reconnect recovery** (D-076-D-079) clarified before decomposition.
Provider adapters normalize inconsistent OAuth, SDK, gateway, direct API, and local-runtime failures into
Trevor's typed failure taxonomy; unknown or low-confidence provider failure shapes are captured as redacted,
deduped observations under Trevor home (`TREVOR_HOME`, default `~/.trevorV2`) so classifier rules can be improved
from real evidence without storing prompts, secrets, auth headers, raw response bodies, or raw tool outputs._

_Updated 2026-06-26: **Local observation corpus / classifier learning** added to the unsequenced backlog as
D-096. Provider failure observations are the first concrete use, but the broader deferred pattern also covers
tool-result patterns, repeated tool calls, attempts-to-goal signals, prompt/harness guidance, and possible future
task classification. **Vim motions in UI/UX** added to the unsequenced backlog as D-097, starting later with
prompt input motions and evaluating `vimeejs/vimee` before broader UI adoption._

_Updated 2026-06-28 (plan-db decision, `--decided-by human`): two items pulled OUT of
`progress-report.md`'s active checklist into this unsequenced backlog, since both were written
defensively for surfaces not in the current slice. **Skill-discovery web UI** added as D-098 - a
Storybook-first roster/list/detail browser over the host's `skills_list`/`skill_view` read models,
with web tests for read-model rendering (no filesystem scans). Neither V1 (`~/dev/trevor`) nor V2 has
a skill-discovery web surface today; skills are host-owned model tools, so this is build-only-if a web
skill-browser is decided on. **Doctor session-lifecycle area** added as D-099 - surface
archived/stale/inactive session states (from D-093/D-094) in `/doctor`; low value while the session
you run `/doctor` in is never archived, so build it only if an archive browser needs it._

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
| **Command family** | UI-neutral command contract: names, grammar, tokenization, diagnostics, protocol actions, examples, and preview metadata | <!-- D-067 --> Host owns authoritative command handling; clients render helpers from structured contract data, not from host-rendered UI |
| **Assistant output style** | Named presentation overlay for response shape, density, and structure | <!-- D-072 --> Additive prompt overlay only; must not change model routing, work kind, execution mode, tool access, agent selection, or validation policy |
| **Doctor snapshot** | Structured host health report with areas, checks, findings, evidence, and next actions | <!-- D-073 --> `/doctor` should render actionable diagnostics, not raw host/debug state dumps |
| **Capability manifest** | Registry-derived self-description of Trevor tools, commands, contracts, agents, skills, and runtime surfaces | <!-- D-074 --> Full manifest for humans/clients/export; compact scoped manifest for model/subagent context; never a permission system or giant prompt dump |
| **Loop** | Recurring/cadence work spec with bounds, lifecycle, runner, controls, and confirmation | <!-- D-067 --> A host feature that works headlessly through commands/session protocol; Trevor web owns the rich helper UI |
| **Web fetch** | Host-owned read-only URL content fetcher that turns an explicit public URL into bounded attributable content | <!-- D-068 --> `web_search` already exists; deferred work is `web_fetch`, with static-first fetching, direct Jina Reader fallback for JS-blocked/thin pages, and Firecrawl only as the configured last resort |
| **Filesystem root** | One of Trevor's host-local roots for config, state, cache, share, or external auth | <!-- D-069 --> New work must use the clarified root taxonomy instead of inventing ad hoc dotdirs |
| **Docs corpus** | Cached, normalized documentation pages fetched for a product/service/library/SaaS/work task | <!-- D-070 --> Stored under Trevor local state with source metadata and 24-hour staleness; fetched through `web_fetch` |
| **MCP server** | Named external context/tool server configured in the host MCP registry | <!-- D-066 --> Tool proxy, if configured, is only one MCP server entry; it is not the MCP abstraction, bridge, or special case |
| **MCP capability** | A tool, resource, prompt, elicitation request, or sampling request exposed by a named MCP server | <!-- D-066 --> Keep tools/resources/prompts distinct; resources are attributable context, prompts are imported prompt artifacts, and tools are executable external capabilities |
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

### Deferred (after Phase 5 search-tool upgrade): session recall <!-- D-044 -->

On-demand retrieval of detail compaction folded away - "search my own past." Possible only because the full
log survives compaction (D-042). **Explicitly sequenced after Phase 4 subagents and Phase 5 search-tool
upgrade.** It depends on subagent isolation, not on the code-search tools, but the search-tool upgrade is now
the immediately-after-Phase-4 slot. Recall runs as an **isolated sub-agent**: a search hit is an *anchor*, not
the answer - the substantive discussion may live in the turns *around* the match (sometimes while those turns
were nominally about another topic), so recall expands each anchor to its **neighborhood** and reasons over it.
That neighborhood can be large and tangential, so the digging happens in a sub-agent with its **own context
budget**, returning only a distilled, cited answer to the main turn (a librarian who reads the chapter around
the page and hands back the answer).

- <!-- D-044 --> **`session recall` tool**, model-driven - the compacted prompt's fold manifest (D-042)
  advertises the recallable gaps so the model knows what to ask for. Search = **BM25** (lexical, ranked, no
  embeddings/index infra - built on-demand over the session's events) combined with structured pre-filters
  (tool / turn-range / type), then **neighborhood expansion** around each hit. **This session only - no
  cross-fork recall** for now; embeddings/semantic retrieval stay deferred behind BM25.
- **Depends on:** the subagents feature (isolation) + the D-042 fold manifest (anchors). Distinct from the
  §7 backlog "Code retrieval / search" row, which searches the *codebase*, not the conversation log.

### Deferred: internet connectivity awareness <!-- D-060 -->

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
  configured public endpoints, cached briefly, e.g. 10-30s). It reports `online`, `offline`, or `unknown` plus
  last checked time and last probe error. It does not classify provider health, provider auth, provider overload,
  rate limits, or model availability.
- **No automatic model switching.** If the user selected a local model, the turn uses that local model. If the
  user selected a cloud model, the turn uses that cloud model. Cloud failures never trigger a local turn, and
  offline status never silently rewrites the user's selected model. Do not add pre-turn cloud-to-local fallback,
  reactive local retry, or an `assistant.providerFallback` event for this item.
- **User-visible advisory only.** Internet status can appear in the UI, the model-source chooser, logs, and
  `/doctor`. If the selected model is cloud and the host is currently offline, the UI may warn, but it must not
  substitute a local model or route the turn elsewhere without explicit user action.
- **Doctor/debug surface.** `/doctor` should show host internet status, last probe time, last probe error, and
  probe target class without dumping credentials or full request payloads. It should not report a fallback target
  because this feature has no fallback behavior.
- **Validation target.** Tests should cover LAN-up/WAN-down status, browser `navigator.onLine` disagreeing with
  the host probe, local session-store disconnect not implying internet offline, cloud request failure not causing
  a local retry, local-selected turns unaffected by offline status, and UI rendering of the advisory status.

### Later: browser/terminal session manager <!-- D-061 -->

Trevor should support the browser workflow without losing the old terminal ergonomics: from any project directory,
the user can launch or attach Trevor and land in a browser session whose host is rooted at that directory. This is
**not shipped yet** and does not change the current `SESSION_ID` + `TREVOR_WORKSPACE` behavior.

- <!-- D-061 --> **Cwd-targeted launch from any terminal directory.** Add a terminal entrypoint (name TBD) that
  resolves the invoking shell's cwd, creates or reuses a session bound to that absolute directory, starts or attaches
  the matching host runtime, and opens the web UI directly to that session. The cwd must be recorded as session
  metadata, not inferred from whatever directory the monorepo dev script happened to use.
- **Browser-created sessions.** The web UI gains a create-session flow that accepts a target folder, creates a new
  durable session for that folder, starts the corresponding host runtime through the available supervisor/launcher,
  and navigates into the session once the host announces `host.online`.
- **Session navigation.** The UI needs a first-class session list/switcher showing session id, cwd/workspace,
  host presence, active/queued state, and recent activity. URL `?session=` remains a deep-link mechanism, but not the
  only way to move between sessions.
- **Kill/stop from terminal and UI.** Add explicit session termination controls in both surfaces: terminal command(s)
  to list/open/kill sessions, and UI actions to stop a session's host runtime and mark or archive the browser-visible
  session. Killing a host is lifecycle management; it must not mutate or delete the durable session log by accident.
- **Relationship to Phase 3.** This dovetails with the desktop shell's one-host-per-session/cwd model (D-021-D-024),
  but may ship earlier as a browser-era local launcher/supervisor if that becomes the cleaner bridge. Either way, it
  must preserve D-014: browser and host still communicate only through the session log; any launcher/supervisor owns
  lifecycle only.

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
  sources report needs key, configured by env, configured by stored key, key rejected, catalog fetch failed,
  stale catalog, and catalog refresh in progress.
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
- **Current sidebar behavior remains.** The sidebar keeps showing the active model name, and the thinking
  level/toggle/switcher remains underneath that model name. Clicking the model name opens the richer model
  chooser by replacing the chat area on the left with a responsive chooser surface. This plan does not encode
  further visual design.
- **Chooser actions are source-aware.** Depending on source/auth state, actions include sign in, re-login,
  add/update API key, refresh catalog, open local runtime/setup instructions, use model, set default, pin/unpin,
  and remove/disable a manual source. Auth/setup failures are visible for that source without blocking browsing
  other configured sources.
- **Preferences and wire events must carry both model and reasoning.** Keep backward compatibility with the
  current `provider` string during migration, but move toward a stable selected-model contract:
  `{sourceId, modelId, reasoning}` on user turns and host preferences. The host resolves that to the actual
  provider adapter and request options. Persist the active model, default model, recent models, pinned models,
  and per-model reasoning selection in the session/user preference layer.
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
  configured/missing/rejected states; local runtime offline/online states; reasoning choices constrained to
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
- **Validation.** Deterministic with `@effect/vitest` + `TestClock` (no real waits) and a fake provider
  that fails N times then succeeds: a transient drop before the first token recovers transparently; a drop
  after output goes terminal; an interrupt during backoff cancels cleanly; auth/overflow paths unchanged.

### Then: remaining KEEP features not yet built

Sequence as each is picked up (no hard order locked here):
- **Auth / OAuth login** is specified as part of D-065: source-aware sign-in/re-login actions, OAuth refresh,
  shared auth-store integration, and provider catalog status (H-019, H-155).
- **Internet connectivity awareness** is specified above as D-060: host-owned public-internet status only, with
  no automatic local/cloud switching or retry behavior (H-026, H-093).
- **MCP client runtime** is specified below as D-066: generalized host-owned MCP server registry and client,
  not a tool-proxy-centered bridge (H-119, H-160).
- **`/loop` command surface** is specified below as D-067: host-owned recurring/cadence work, explicit slash
  grammar, shared preview contract, rich Trevor web helper UI, controls, lifecycle, and separately deferred
  natural-language loop drafting (H-029, H-169).
- **`web_fetch`** is specified below as D-068: explicit public-URL content fetch, static first, direct Jina
  Reader fallback for JS-blocked/thin pages, Firecrawl only after Jina cannot produce usable content and
  `FIRECRAWL_API_KEY` is configured, graceful disabled state when not configured (H-113).
- **Filesystem root taxonomy** is specified below as D-069: config in `~/.trevorV2` for now, disposable cache
  in `~/.cache/trevor`, local state in `~/.local/state/trevor`, shareable local data in
  `~/.local/share/trevor`, pi-ai auth in `~/.pi`, shared agent assets in `~/.agents`, and optional
  `~/.config/trevor` only when an explicit config-dir export points there.
- **`docs` tool** is specified below as D-070: documentation-set lookup and caching over `web_fetch`, stored
  in `~/.local/state/trevor/docs`, stale after 24 hours, with bounded crawling and provenance.
- **`/clip` + `clipboard_write`** is specified below as D-071: V1-compatible clipboard write surface with a
  bare host command and a restricted prompt form (H-111).
- **Settings & preferences** for model/provider/thinking mode are specified as part of D-065; deeper
  **usage/metrics** surface remains separate (H-031, H-034).
- **Browser/terminal session manager** is specified above as D-061: cwd-targeted terminal launch, browser-created
  folder sessions, session navigation, and kill/stop from terminal and UI.
- **Output-style registry** is specified below as D-072: V1-compatible assistant styles as additive
  presentation prompt overlays, exposed through settings and `/style` without task/routing semantics (H-164).
- **Doctor health surface** is specified below as D-073: V1-compatible structured diagnostics, rendered in
  Trevor web through Storybook-first responsive UI before app wiring (H-163).
- **Capability manifest** is specified below as D-074: registry-derived full and compact Trevor self-description
  for humans, clients, subagents, and exports without prompt bloat (H-156).
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
| **LSP integration** | H-022, H-116, H-161 | <!-- D-063 --> deferred. First cut is read-only and pull-based, carrying forward the useful Trevor V1 shape plus one explicit V2 addition: list/status, diagnostics, hover, document symbols, workspace symbols, and code actions as proposals. No ambient diagnostic stream and no prompt injection except as an explicit tool result. Mutating LSP behavior - `applyWorkspaceEdit`, applying code actions, rename edits, and any future workspace edit surface - stays deferred behind a separate implementation phase |
| **MCP client runtime** | H-119, H-160 | <!-- D-066 --> deferred. Generalized host-owned MCP server registry and client for tools, resources, prompts, elicitation, sampling mediation, auth, lifecycle, discovery, diagnostics, prompt guidance, and evals. Tool proxy is not a bridge or special path; if configured, it is one named MCP server like any other |
| **Hooks runtime** | H-036, H-162 | <!-- D-064 --> deferred. First cut is narrow command hooks for `PreToolUse` and `Stop`, not a general plugin bus. Preserve the useful V1 shape: sha256 trust, local/user/shared discovery, explicit decisions, visible events, `/doctor` diagnostics, and non-blocking failures unless a hook explicitly returns a blocking decision |
| **`/loop` command surface** | H-029, H-169 | <!-- D-067 --> deferred. Host-owned recurring/cadence work feature with a UI-neutral command-family contract. Core loop creation/control works headlessly through explicit commands and structured session protocol; Trevor web adds the rich live helper, syntax highlighting, used/available keyword guide, and confirmation UI. Natural-language loop drafting is a later layer |
| **`web_fetch` tool** | H-113 | <!-- D-068 --> deferred. Add the missing companion to shipped `web_search`: fetch an explicit public URL into bounded attributable markdown/text. Static fetch/extraction is the default. Direct Jina Reader is the first JS-blocked/thin-page fallback. Firecrawl is the final rendered-page fallback only when Jina cannot produce usable content and `FIRECRAWL_API_KEY` is configured; missing Firecrawl config disables that path gracefully |
| **Filesystem root taxonomy** | new | <!-- D-069 --> deferred cleanup/standard. New stateful features use the clarified roots immediately; existing `~/.trevor` service-data defaults are migration debt |
| **`docs` tool** | new | <!-- D-070 --> deferred. Higher-level documentation lookup/cache tool over `web_fetch`; stores normalized docs corpora in `~/.local/state/trevor/docs`, treats entries as stale after 24 hours, and refreshes intentionally |
| **Tangents** | H-030 | lateral exploration side-threads |
| **Bounded-child + takeover** | H-024, H-025, H-086 | host-owned constrained helpers + route escalation/takeover |
| **Managed worktrees + cwd locks + merge protocol** | H-140 | stable per-session git worktrees (paths/branches/hashes), cwd-level advisory locks, and a merge/reconciliation protocol; prerequisite for mutating background subagents |
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

**LSP posture (deferred).** <!-- D-063 --> LSP remains unsequenced. When picked up, it should be an
intentional navigation and problem-solving aid, not a real-time side channel. The host may keep language
servers warm and cache lifecycle state, but LSP findings enter the model context only when the agent chooses
an `lsp` tool call. Slow, missing, unsupported, or stale servers return bounded `lsp-unavailable` /
`lsp-error` results so the agent can continue with `rg`, `ast_grep`, file reads, tests, compiler output, and
ordinary reasoning. Code actions are read-only proposals in the first cut; applying edits is a later mutating
phase with explicit user-visible tool semantics.

Prompt guidance is part of the feature, not polish:

- **Use LSP proactively at chosen moments** when the task is about program structure or typed facts:
  `documentSymbols` to understand one file's real outline; `workspaceSymbols(query)` to find named
  definitions/entities across the project instead of grepping mentions; `hover` for inferred types,
  signatures, overloads, and doc facts at a position; targeted `diagnostics` after localized edits or when
  type errors are blocking; `codeActions` as read-only repair/import/refactor proposals; and compact LSP
  results to avoid dumping broad file context when one symbol/type fact is enough.
- **Do not use LSP as the default search engine or truth source** for literal text, docs, config, tests,
  route strings, environment keys, broad content search, structural pattern search, unsupported languages, or
  build/test correctness. Keep `rg` for text, `ast_grep` for structural code patterns, direct file reads for
  source truth, and tests/typecheck/compiler output as the final correctness signal.
- **Invocation discipline:** no full-project symbol dump, no automatic background diagnostic feed, no
  pre-edit gate that waits on a language server, and no automatic application of code actions. Calls must be
  query-driven, capped, time-bounded, and represented as explicit tool results. If LSP is unavailable, stale,
  noisy, or slow, continue through normal read/edit/test work.
- **Evals required when implemented:** include navigation tasks where `workspaceSymbols` should beat grep,
  file-orientation tasks where `documentSymbols` should reduce context, typed-code repair tasks where
  `hover`/`diagnostics` should reduce churn, code-action proposal tasks that must not mutate files, and
  distraction regressions proving unavailable/noisy/slow LSP does not block progress or make the model chase
  unrelated findings.

**MCP posture (deferred).** <!-- D-066 --> MCP remains unsequenced. When picked up, preserve the useful
Trevor V1 generalized MCP client shape, but make MCP itself the product abstraction. Do not model this feature
as "tool proxy integration." Tool proxy is just one possible configured MCP server, no different in the MCP
runtime from a GitHub server, docs server, browser server, design server, or any other named MCP endpoint.

The first V2 MCP implementation should include:

- **Named server registry.** Host-owned config defines named servers with `enabled`, transport, endpoint or
  command/args, per-server exposure flags for tools/resources/prompts, request timeout, auth config, and
  redacted debug representation. Carry forward V1's transports: `stdio`, `streamable_http`, and `sse`.
- **Lifecycle and transport behavior.** The host initializes servers with the MCP handshake, preserves
  `mcp-session-id` for HTTP transports, closes transports on host/session shutdown, and rejects pending
  requests on timeout, JSON-RPC error, child crash, connection close, or malformed response. Stdio framing must
  handle partial frames, multiple frames in one buffer, case-insensitive `Content-Length`, and byte-counted
  multibyte bodies.
- **Secret and auth boundary.** Stdio children inherit only an allowlisted environment plus explicit server
  env, never the host's full provider/API-key environment. HTTP servers support bearer auth and OAuth-needed
  state through a credential-store boundary. Logs, `/doctor`, debug info, and tool results redact auth headers,
  bearer tokens, configured env values, and sensitive URL material.
- **Capabilities stay separate.** MCP tools, resources, and prompts are different host concepts. Tool calls are
  executable external actions. Resources are attributable context records and must not be logged as tool
  execution. Prompts are imported/expanded prompt artifacts and must not be collapsed into Trevor slash
  commands. Elicitation and sampling are server-originated requests that cross back into the host only through
  explicit host-owned mediation.
- **Qualified identity and provenance.** Every discovered item carries `serverName`, transport, original MCP
  name, qualified name, input/argument schema when available, and source provenance. Same-named tools or
  prompts on different servers are normal and must be selected by qualified identity, not by last-wins merging.
- **Model-facing surface.** V2 should expose MCP as MCP, not as a `tool_proxy` tool. The model-facing schema may
  be a single `mcp` tool with typed actions or a small `mcp_*` family, but it must support capability
  discovery/search, tool calls, resource list/read, prompt list/get, server status, and bounded result output
  without dumping every configured server's full catalog into the prompt. Tool proxy-specific names must not
  leak into the generic MCP prompt guidance.
- **Discovery and cache strategy.** The host can keep server transports warm and maintain capability caches, but
  model context receives MCP data only through explicit tool results. Support `refreshCapabilities(serverName)`
  and `searchTools(query)`-style access so large dynamic catalogs are searched, capped, and attributed instead
  of injected wholesale.
- **Tool metadata and safety.** MCP calls flow through the normal Trevor tool boundary: tool events, redaction,
  truncation, hooks when hooks exist, cancellation, and concurrency classification. Unknown MCP tools default to
  external/network, identity-dependent, variable-idempotence behavior and are not considered read-only for
  concurrent-read scheduling unless the server/tool is explicitly classified as read-only. Workspace mutation
  and external-service mutation are separate risks and should be surfaced separately.
- **Server-originated requests.** Elicitation uses a host-owned answer callback and can decline/cancel when no
  UI/agent path is available. Sampling is off by default unless explicitly enabled with budget limits and a
  sampling handler; accepted sampling returns only handler output and sanitized usage, not private model
  preferences or provider secrets.
- **Diagnostics.** `/doctor`, debug info, and UI status should report per-server configured/ready/auth_needed/
  failed/closed state, transport, redacted endpoint/command, exposure flags, capability-count/cache freshness,
  last checked time, and sanitized last error. Service-specific health for a tool-proxy daemon, if any, belongs
  to the service launcher/diagnostic layer; it is not a special MCP runtime category.
- **Prompt guidance.** The agent should discover/search MCP when the user asks for an external integration,
  account-backed service, configured external tool, remote resource, imported prompt, or server-specific
  capability. It should call known qualified MCP tools directly when already discovered. It should read MCP
  resources for context, get MCP prompts when the user asks to apply an imported prompt, and avoid broad
  discovery when built-in Trevor tools (`rg`, `ast_grep`, file reads, LSP, web tools, or shell) are the clearer
  fit. It must not assume a configured tool-proxy server exists or privilege it over other MCP servers.
- **Validation required.** Tests/evals must cover config normalization/redaction, stdio and HTTP transports,
  SSE compatibility, HTTP auth/session headers, OAuth-needed state, no full env inheritance, stdio framing,
  request timeout/crash/error draining, same-named qualified tools, resources as context, prompts as prompt
  artifacts, elicitation decline/accept, sampling budget rejection/acceptance, capability refresh/search
  without full-catalog prompt dumps, per-server diagnostics, and a configured tool-proxy server behaving exactly
  like any other MCP server.

**Hooks posture (deferred).** <!-- D-064 --> Hooks are future work and should enter as a local policy/context
mechanism at explicit lifecycle boundaries, not as an open-ended extension platform. The first cut has exactly
two event types:

- **`PreToolUse`** fires before a tool executes. Its payload includes session/run/turn IDs, cwd, tool name,
  tool input, tool metadata, and caller kind. It can return `allow`, `deny`, `halt`, bounded `context`, and
  narrowly scoped `updatedInput`. `updatedInput` is allowed only for explicit tool-input fields the host
  chooses to support; it must never rewrite hidden state or bypass tool validation.
- **`Stop`** fires when a run is about to finalize a terminal assistant result. Its payload includes
  session/run/turn IDs, cwd, terminal reason, final assistant text, and a compact tool/change summary when
  available. It can `allow` completion, `halt` completion with a user-visible reason, or return bounded
  `context` that asks the agent for at most one continuation/synthesis pass before finalizing. It cannot
  mutate files, rewrite prior events, or apply tools directly.

The V2 first cut should keep V1's useful constraints and tighten the risky parts: command handlers only;
explicit `args` arrays with no shell splitting by default; low default timeouts; bounded stdout/stderr;
secret redaction; trust hashes over normalized config plus referenced local script contents; approval required
before executing project/user hooks; `/doctor` findings for missing handler IDs, missing local scripts,
changed trust hashes, slow handlers, repeated timeouts, and legacy executable `HOOK.md` migration. Hook
command failures, invalid JSON, and timeouts are observable but non-blocking unless the hook returns an
explicit `deny`, `halt`, or `Stop` continuation decision. Do not include PostToolUse hooks, native extension
dispatch, model-routing hooks, long-running hook daemons, or arbitrary plugin APIs in the first cut.

**Filesystem root taxonomy (target).** <!-- D-069 --> Trevor needs one explicit host-local filesystem policy.
Current code still has legacy/default service data under `~/.trevor` (`sessions.db`, blob-store root), while
local package scripts use `~/.trevorV2/.env.op` for config. Treat that as current implementation state plus
migration debt, not as permission to keep adding ad hoc dotdirs. New stateful features should use the target
taxonomy immediately.

Target roots:

- **Config root:** `~/.trevorV2` for now, eventually renamed/migrated to `~/.trevor`. This is for Trevor
  config, env/opchain files, local preferences, and non-pi model/provider configuration that belongs to
  Trevor. `~/.config/trevor` is allowed only when an explicit export variable points the config root there;
  do not create or prefer it by default.
- **Disposable cache root:** `~/.cache/trevor`. Use for rebuildable data that can be deleted without losing
  meaningful user state: HTTP cache fragments, derived indexes, temporary extraction products, and other
  performance caches.
- **Local state root:** `~/.local/state/trevor`. Use for durable local machine state that is not just config:
  session databases, local service state, normalized docs corpora, durable local indexes, and state that should
  survive cache cleanup but is not portable share content.
- **Local share root:** `~/.local/share/trevor`. Use only for shareable, portable local data if Trevor gains
  such assets. Do not put machine-local service state here.
- **External ownership:** model auth stays in `~/.pi` because pi-ai owns that auth store; shared agent assets
  stay in `~/.agents`. Trevor may read or integrate with those locations, but it must not re-home them.
- **Environment overrides.** Every root should have a deliberate override path once implemented, with the
  config-root override enabling `~/.config/trevor` for users who export it. Overrides must be visible in
  `/doctor`, and logs should show redacted/abbreviated paths.
- **Migration posture.** Do not move existing `~/.trevor` data opportunistically in unrelated work. When the
  state-layout cleanup is picked up, add a compatibility/migration pass for current `~/.trevor/sessions.db`
  and `~/.trevor/blobs` defaults into the target local-state layout, with explicit backup/rollback behavior.

**Web fetch posture (deferred).** <!-- D-068 --> `web_search` is already shipped; the missing feature is
`web_fetch`, a host-owned read-only tool that fetches one explicit public URL and returns bounded,
attributable content for source verification. It is the source-reading companion to search, not a replacement
for search, not an authenticated browser, and not a general browsing automation surface.

The first V2 `web_fetch` implementation should include:

- **Explicit URL only.** The tool accepts a single URL and optional mode/cap settings. It does not search,
  click around, follow user browser cookies, reuse logged-in sessions, or fetch authenticated/private pages.
  It should reject unsupported schemes, userinfo URLs, loopback/private/link-local/cloud-metadata targets, and
  unsafe redirect hops through a Trevor-owned URL safety guard before any fetch backend runs.
- **Static-first fetch path.** Default behavior is ordinary static HTTP fetch plus deterministic extraction:
  HTML to readable markdown/text, text/plain and JSON as bounded text, and PDF support only if a safe parser is
  chosen during implementation. Return metadata such as original URL, final URL, title when known, content
  type, status, fetched time, byte count, text length, truncation info, and backend. Static fetch must be tried
  first for `mode: "auto"` and is the only path for `mode: "static"`.
- **Jina Reader is the first rendered/thin-page fallback, called directly.** Do not route through Dendrite or
  any Python scraper. When static extraction fails or is clearly a JS shell, try Jina Reader directly
  (`https://r.jina.ai/<target-url>`) as the first third-party recovery path. Treat it as external egress:
  apply Trevor's URL safety guard before sending the target URL, cap bytes/time/text, record provenance, and
  support an optional Jina API key only if implementation needs higher limits. If Jina returns empty/thin
  content, an error, a blocker page, or unusable markdown, continue to the Firecrawl decision.
- **Firecrawl is the last rendered-page fallback, and disabled gracefully when absent.** Use the official
  Firecrawl Node SDK (`firecrawl`) with `FIRECRAWL_API_KEY` when Firecrawl rendering is configured. If the key
  is absent, do not advertise or call the Firecrawl backend; return a structured `rendered_fetch_unavailable`
  result only when static extraction and Jina cannot produce usable content or when the caller explicitly
  requested rendered content.
- **Do not accidentally spend Firecrawl calls.** Firecrawl must never be the default for every fetch. In
  `mode: "auto"`, the ladder is static fetch, then Jina only when static content is empty/thin or
  render-blocked, then Firecrawl only if Jina cannot get usable content and `FIRECRAWL_API_KEY` is present. In
  `mode: "rendered"`, skip static if necessary but still try Jina before Firecrawl unless implementation adds
  an explicit Firecrawl-only override. Prompt guidance must tell the model that Firecrawl is a scarce final
  fallback, not a routine source-reading step.
- **Bounded Firecrawl request shape.** Ask Firecrawl for markdown/main content only in the first cut. Do not
  use Firecrawl search, crawl, map, extract/JSON, screenshots, interact/actions, persistent profiles,
  customer headers/cookies, enhanced proxy, or broad site crawling in this feature. Apply Trevor result caps
  after Firecrawl returns, and surface Firecrawl metadata/provenance without exposing secrets.
- **Graceful degradation.** Jina errors, Jina rate limits, missing `FIRECRAWL_API_KEY`, Firecrawl rate limit,
  timeout, provider error, or unavailable SDK must not fail the whole agent turn. The tool returns a typed
  result explaining whether static content was returned, Jina was attempted, Firecrawl was unavailable, or all
  allowed paths failed. `/doctor` should report Jina reachability/status and Firecrawl configured/unconfigured
  plus last sanitized errors.
- **Prompt guidance.** Use `web_search` to discover candidate sources, then `web_fetch` to read a selected URL
  when source detail matters. Use static fetch by default. Use Jina only when static fetch is unusable or the
  user/model explicitly needs rendered/thin-page recovery. Use Firecrawl only when Jina cannot get usable
  content and Firecrawl is configured. Prefer local repo files, LSP, `rg`, and `ast_grep` for workspace truth;
  do not browse or fetch when the answer should come from local code.
- **Validation required.** Tests/evals must cover static HTML extraction, plain text/JSON, redirects,
  blocked internal/private targets, byte/time/text caps, truncation metadata, `web_search` result followed by
  `web_fetch`, Jina attempted only after static failure/thinness, Firecrawl absent but static/Jina success,
  Firecrawl absent plus render-required page returning a graceful unavailable result, Firecrawl present only
  after Jina cannot produce usable content, explicit rendered mode, rate limit/provider error handling,
  `/doctor` status, and prompt regressions proving the model does not call Firecrawl for ordinary pages.

**Docs tool (deferred).** <!-- D-070 --> Add a model-facing `docs` tool for documentation lookup and local
docs-corpus caching across anything relevant to work: coding libraries, services, SaaS products, APIs,
platforms, internal tools with public docs, and operational references. It is not a new fetch stack. It is a
higher-level documentation workflow built on `web_search` for discovery and `web_fetch` for source reading.

The first V2 `docs` implementation should include:

- **Tool purpose.** `docs` answers "get/use the docs for X" by resolving a documentation root or a supplied
  URL, fetching a bounded docs set, storing normalized pages plus metadata, and returning a concise index or
  relevant excerpts to the model. The model should use it proactively when it needs current docs rather than
  relying on memory.
- **Storage root and shape.** Store under `~/.local/state/trevor/docs` per D-069. Each corpus has a stable key
  derived from source identity, root URL, and optional version. Store page markdown/text, source URL, final URL,
  fetched time, stale-after time, title, content type, fetch backend/provenance, content hash, and any
  crawl/discovery metadata needed to refresh predictably.
- **Freshness.** Docs entries go stale after 24 hours. A fresh corpus is reused without re-fetching by default.
  A stale corpus may be refreshed on the next `docs` call before use, or returned with stale metadata only if
  the caller explicitly allows stale use. Manual refresh should be supported.
- **Bounded discovery.** "All docs" means all docs inside a deliberate bounded scope, not an unlimited website
  crawl. Prefer official docs roots, `llms.txt`/`llms-full.txt`, sitemap/docs index pages, and same-origin or
  same-path documentation links. Enforce max pages, max bytes, max depth, same-domain/path scope, robots or
  site policy where applicable, and visible truncation when a corpus is partial.
- **Fetch backend.** Use `web_fetch` for page reads so the existing static/Jina/Firecrawl ladder, URL safety
  guard, caps, and provenance are reused. `docs` must not call Firecrawl directly or create a parallel web
  scraper. Any Firecrawl usage happens only inside `web_fetch` under D-068's restrictions.
- **Corpus query behavior.** The tool should support at least: resolve/fetch docs for a subject, refresh a
  corpus, search within an existing corpus, read a specific cached page, list cached corpora, and report
  freshness/provenance. Large corpora should return compact ranked excerpts plus citations, not dump every page
  into the prompt.
- **Prompt guidance.** Use `docs` when the task needs product/API/service/library documentation, especially
  current syntax, provider setup, limits, pricing rules, SDK behavior, SaaS admin workflows, or external
  platform docs. Do not use `docs` for source-code truth inside the current workspace; use repo files, LSP,
  `rg`, `ast_grep`, tests, or compiler output. Do not fetch enormous docs sets when one specific page or
  `web_fetch` URL is enough.
- **Validation required.** Tests/evals must cover corpus keying, 24-hour staleness, fresh cache reuse,
  stale refresh, manual refresh, bounded docs discovery, `llms.txt`/sitemap/index handling, partial-corpus
  metadata, source citations, search within cached docs, no direct Firecrawl calls from `docs`, no workspace
  truth substitution, and graceful behavior when network fetches fail after a stale corpus exists.

**Clipboard write surface (deferred).** <!-- D-071 --> Add a V1-compatible `clipboard_write` host tool and
`/clip` slash command. This is a plain-text clipboard write feature, not a clipboard-reading feature, not an
OS automation surface, and not a shell escape hatch for `pbcopy` / `clip` / `wl-copy` commands.

The first V2 clipboard implementation should include:

- **Tool shape.** `clipboard_write` accepts exactly the text to place on the host system clipboard and returns
  a bounded structured result such as `{ copied: true, charCount }`. The tool owns platform clipboard writes
  behind the host boundary and supports test capture without touching the real system clipboard.
- **Bare `/clip`.** Submitting `/clip` with no prompt is a host-owned immediate command. It copies the last
  copyable transcript item and emits a visible command/result event. It does not start a model turn. If no
  transcript item is copyable, return a clear "nothing to copy" result.
- **Prompt `/clip <request>`.** Submitting `/clip` with a prompt starts a restricted clipboard-only model turn.
  The model receives only the clipboard-write surface and the relevant conversation context needed to resolve
  the request, then calls `clipboard_write` with the exact text that should be copied.
- **Purpose of the prompt form.** The prompt form exists for cases where the user wants Trevor to select,
  transform, or compose clipboard text from the conversation: copy the last command only, summarize the last
  answer for Slack, extract a config snippet, rewrite a message, produce a commit title, or copy the exact
  patch explanation. It is not for running tools, browsing files, executing shell commands, or copying an
  answer that should simply be shown in chat.
- **Restricted tool surface.** The prompt form must not expose shell, file mutation, process, MCP, web, docs,
  or other general tools. Prompt guidance must say: resolve the clipboard request from context; call
  `clipboard_write` with exactly the desired text; do not describe clipboard commands; do not call shell
  clipboard commands.
- **Plain-text first.** The first implementation copies text only. Images, rich text, multiple clipboard
  formats, clipboard read/paste, and "deliver assistant output directly to clipboard while hiding it from the
  transcript" are separate features and must not be folded into H-111 by accident.
- **Visibility and safety.** Clipboard writes are external mutations, even when small. Emit normal Trevor tool
  or command events with redacted/bounded previews, result metadata, and clear failure states. `/doctor`
  should report platform clipboard availability and the active test-capture mode when relevant.
- **Validation required.** Tests/evals must cover bare `/clip` copying the last copyable transcript item,
  empty-history behavior, prompt `/clip <request>` exposing only `clipboard_write`, rejection/absence of shell
  clipboard commands, exact copied text capture, platform command selection through a host abstraction,
  failure reporting, transcript visibility, and prompt regressions showing the model uses `/clip <request>` for
  selection/transformation but not for ordinary chat answers.

**Output-style registry (deferred).** <!-- D-072 --> Carry forward Trevor V1's useful assistant output-style
system as a host-owned presentation layer: named styles add compact prompt overlays that shape the form of the
assistant's answer. Output styles are not work kinds, not modes, not agents, not model routes, and not tool
permission profiles.

The first V2 output-style implementation should include:

- **Shared style metadata.** Define a single host/protocol metadata boundary with stable style id, label,
  picker/list description, optional prompt overlay lines, and optional suggestion eligibility. Clients render
  pickers/lists from this metadata instead of hardcoding their own style rows.
- **Initial built-ins.** Carry forward V1's built-in ids unless renamed deliberately during implementation:
  `default`, `visual`, `concise`, `explanatory`, `diagnostic`, `architect`, `reviewer`, `operational`, and
  `spec`. `default` has no overlay.
- **Presentation-only invariant.** A style may influence response shape, ordering, density, diagrams/tables,
  findings-first posture, requirements language, or operational status formatting. It must never choose or
  change provider/model, reasoning level, work kind, execution mode, agent/subagent selection, tool access,
  validation policy, or whether a command/tool is allowed.
- **Prompt composition.** The active style overlay is appended as a compact additive prompt fragment alongside
  ordinary host/project/tool guidance. It must not replace project instructions, user instructions, safety
  guidance, tool guidance, or command-specific prompt context. Unknown or retired persisted style ids fall
  back to `default` without crashing, with a diagnostic visible through settings or `/doctor`.
- **Selection precedence.** Explicit user selection wins, then explicit project/global config if supported,
  then `default`. Carry forward `outputStyleSource` or an equivalent source marker with values such as
  `user`, `config`, `suggestion`, and `default`, so the UI and route/run diagnostics explain why a style is
  active.
- **No V1 routing-engine carryover.** V1 let the old router suggest output styles. V2 must not revive the
  dropped model-led routing engine just for style selection. If automatic style suggestions are added later,
  they should be a small presentation-only classifier or host heuristic, disabled by explicit user/config
  style, and recorded as `suggestion` source. This automatic suggestion path is deferred from the first cut.
- **Command surface.** Support `/style` as the command family. `/style <style>` validates and persists the
  user-selected style as an immediate host command with no model turn. Bare `/style` exposes a UI-neutral
  style-list/chooser contract: Trevor web may render a picker, while headless clients can receive a structured
  list and usage result.
- **Settings and persistence.** Surface `outputStyle`, `outputStyleSource`, and available style metadata in
  settings/read-model output. Persist explicit user preference under the D-069 local-state root, not in
  disposable cache. If project/global config defaults are supported, keep them distinct from user local state
  and avoid rewriting config when the user changes a local preference.
- **Run attribution.** Each run records the active output style and source at turn start for reproducibility,
  debugging, and transcript inspection. Changing style mid-session affects later turns, not already-started
  provider calls.
- **Prompt guidance and evals.** Guidance should tell the model how each style affects answer shape while
  preserving higher-priority instructions and task requirements. Evals must prove: overlays are additive;
  styles do not alter tool inventory/routing/execution mode; `/style <style>` is host-owned and no-route;
  bare `/style` can render or return a chooser/list; user/config precedence beats suggestions; unknown styles
  fall back safely; and style-specific behavior appears only when it helps the answer.

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

**Capability manifest (deferred).** <!-- D-074 --> Carry forward Trevor V1's useful capability manifest as
the host's registry-derived self-description. This feature answers "what can this Trevor host do?" for humans,
clients, subagents, and export/debug surfaces without relying on stale documentation or dumping every possible
capability into every model prompt.

The first V2 capability manifest implementation should include:

- **V1 behavior to carry forward.** Preserve the useful V1 shape: a full manifest rendered by a host-owned
  export command, a machine-readable JSON payload, and a compact capability context for delegated/subagent
  prompts. The manifest is derived from live registries such as tools, slash commands, command families,
  domain contracts, agents, skills, and runtime surfaces; it is not maintained as handwritten prose.
- **Full vs compact forms.** Full manifest is for UI/debug/export and may include structured detail. Compact
  manifest is for model/subagent context and must stay short, scoped, and budgeted. The compact form should
  list only the capabilities relevant to the receiving context, with summaries and pointers for discovery
  rather than exhaustive schemas or huge dynamic catalogs.
- **Not a permission system.** The manifest describes available capabilities; it does not grant tool access,
  bypass command authority, override per-run allow-lists, or replace normal tool schemas. Authorization and
  execution still live at the ordinary tool/command/agent boundaries.
- **Inputs and related read models.** Build from existing source-of-truth registries: core tool metadata,
  read-only/mutating classification, slash command descriptors, command-family contracts, output-style
  metadata, agent/skill discovery summaries, MCP server/capability summaries, LSP feature availability,
  web/docs status, hooks, Doctor areas, and runtime surfaces. Keep `contract.current` for protocol hash/skew
  detection and tool identity read models for client presentation; the capability manifest may reference or
  compose them, but must not blur their meanings.
- **Dynamic capability handling.** MCP servers, model catalogs, docs corpora, and provider/model lists can be
  huge and dynamic. The manifest should expose counts, names, status, search/discovery affordances, and
  qualified identifiers, not inline every entry. Use explicit refresh/search/read operations for detail.
- **Export and command surface.** Preserve a host-owned export command, renaming only if the V2 command naming
  pass decides to change `/trevor-export`. The export should provide a human-readable summary plus JSON. Future
  command variants can include compact, full, json, and per-scope export.
- **Subagent and prompt guidance.** Subagents should receive a compact capability context only when useful,
  especially when they need to know Trevor-native tools/commands/contracts. The model should prefer manifest
  guidance for understanding Trevor surfaces, not for ordinary coding context. Do not inject the full manifest
  into normal turns.
- **Client/UI usage.** Trevor web may use the full structured manifest to power capability/help surfaces,
  command discovery, tool lists, agent/skill listings, and debug/export screens. UI should render from the
  structured data rather than scraping prompt text or duplicating hardcoded lists.
- **Versioning and provenance.** Include manifest version, generated time, host build/version when known,
  workspace/cwd when relevant, source registries/provenance, and truncation/scope metadata. Unknown or
  unavailable registry sections should be represented explicitly instead of omitted silently.
- **Validation required.** Tests/evals must cover registry-derived tool and command inclusion, debug-only or
  hidden capability filtering, compact token budget, no full-catalog prompt dumps, dynamic MCP/provider/docs
  summarization, JSON export stability, subagent prompt inclusion only when scoped, client rendering from the
  structured payload, and drift tests proving the manifest changes when source registries change.

**Discovery registry + progressive skill drill-in (deferred).** <!-- D-075 --> Carry forward Trevor V1's
registry shape while preserving the useful current V2 behavior where the model knows that skills exist from
the start of a turn. This is a host-owned discovery protocol, not a Trevor web-only command palette.

The first V2 discovery implementation should include:

- **V1 and current V2 baseline.** V1 used a compact ambient skill roster plus `skills_list(query?, limit?)`
  and `skill_view(skillId)`. Current V2 uses a single `skill(name)` tool whose description carries skill ids
  and blurbs, then loads one full body. The target keeps the ambient awareness advantage, but replaces the
  single-tool-description roster with structured prompt context plus list/view tools.
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
  filesystem or invent slash/skill/agent inventories. Non-web clients can still use the same protocol.
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

**Loop command surface (deferred).** <!-- D-067 --> `/loop` is a host feature with a UI-neutral command
contract, not a Trevor web-only macro. The authoritative loop domain lives in the host: parse/validate,
draft, confirm, run, schedule, pause, resume, stop, delete, persist durable loops, emit status, and enforce
bounds, timeouts, cancellation, and permissions. The rich helper belongs to Trevor web, but the core command
and control surface must still work from any client that can send command/session-protocol events.

The first V2 loop implementation should carry forward V1's explicit command surface:

- **Command family contract.** Define `/loop` and `/loops` as a shared command family with names, aliases,
  grammar keywords, control verbs, tokenization, diagnostics, examples, and preview metadata. The web can
  import the shared parser for per-keystroke preview; the host must re-parse authoritatively on submit.
  Other clients may ignore the rich preview and still submit explicit commands and receive ordinary command
  results/status events.
- **Explicit slash grammar.** Support creation with optional `new`, runner aliases `current`, `session`,
  `background`, and `process`, optional `durable`, and the grammar keywords `max`, `every`, `until`,
  `timeout`, and `do`. Support controls through `/loop list`, `/loops`, `/loop stop <id>`,
  `/loop pause <id>`, `/loop resume <id>`, `/loop delete <id>`, `/loop run-now <id>`, and `/loop clear`
  if clear remains wanted at implementation time.
- **Quote and duration rules.** Double-quoted spans are single values; unquoted `do` and `until` values are
  single-token only. The helper and diagnostics must make this visible so multi-word actions and conditions
  are quoted. Durations accept compact units such as `ms`, `s`, `sec`, `m`, `min`, `h`, and `hr`; bare
  numeric durations default to seconds if that V1 behavior is retained.
- **Validation diagnostics.** Creation requires both an action via `do` and at least one deterministic
  bound/cadence: `max`, `until`, `every`, or `timeout`. Diagnostics should distinguish missing action,
  missing bound, invalid `max`, invalid duration, empty `until`, empty action, and unknown tokens. Explicit
  `/loop` text is parsed deterministically; no model is involved in the slash-command path.
- **Shared preview model.** The parser returns command mode, tokens with `command`/`keyword`/`value` kinds,
  parsed fields, used keywords, available keywords, missing requirements, diagnostics, and `ready`. This is
  the UI bridge. The host does not render rows, chips, colors, or layouts.
- **Trevor web helper.** The web UI should provide the rich V1-style experience: `/loop` discovery through
  the slash menu, a live committed helper after `/loop `, syntax highlighting, a used/available keyword
  legend, rows for runner/max/every/until/timeout/action/durability, missing-field hints, ready state, and
  loop inventory controls. This helper is the first-class Trevor experience, but not a requirement for other
  clients.
- **Runtime semantics.** Carry forward the runner categories: current-session prompt, background-agent
  prompt, and process command. Bodies are prompt text or shell command text. Lifecycle is explicit:
  draft/pending confirmation, running, paused, stopped, completed, failed, and deleted. Stop reasons include
  max-iterations, until-satisfied, timeout, cancelled/stopped, and error. Cadence loops have one active timer
  per loop and can be run immediately through `run-now`.
- **Safety and observability.** Process loops run through the same command/process safety boundary, timeout,
  cancellation, redaction, status events, and diagnostics as other host command execution. Recurring work must
  never become unbounded by default: every loop needs a stop/cadence bound, visible status, and explicit user
  controls. Durable loops must survive restart without losing their last-known status or next-run time.
- **Natural-language drafting is deferred.** Do not include natural-language loop creation in the first
  `/loop` command-surface implementation. Later, add an agent tool that knows when a user is asking for
  repeated work and returns a structured semantic loop draft. That tool should infer only fields the user
  stated, never start execution directly, compile through the same validator, ask for clarification when the
  action or bound is missing, and require confirm/edit/cancel before activation.
- **Prompt guidance and evals.** The model prompt should say to use explicit `/loop` commands when the user
  types or asks for the command surface, and not to invent hidden recurring work. When the deferred
  natural-language tool exists, guidance should cover when to call it and when to ask for a plain one-off
  turn instead. Evals must cover grammar parsing, quote requirements, duration parsing, diagnostics, helper
  preview metadata, headless command/control operation, process/current/background runner behavior,
  persistence, cancellation, and the later natural-language draft tool's confirmation gate.

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
- **Ambient LSP feedback can degrade agent work (D-063).** A constant diagnostic feed, automatic prompt
  injection, or edit-gating language-server wait would compete with the normal read/edit/test loop and can
  make the agent chase stale or low-priority findings. Mitigation: LSP is pull-only, bounded, and optional.
  It never blocks ordinary tool use; unavailable or slow servers degrade to `lsp-unavailable` / `lsp-error`,
  and the agent falls back to `rg`, `ast_grep`, direct file reads, tests, and compiler output.
- **MCP can become prompt/tool noise or an unsafe external mutation path (D-066).** Dumping all server
  catalogs into the prompt, treating tool proxy as a special bridge, or assuming every MCP tool is read-only
  would make agent behavior worse and blur external-service risk. Mitigation: MCP is explicit, qualified,
  searched/capped, redacted, and routed through normal Trevor tool events, metadata, hooks, diagnostics, and
  evals.
- **Web fetch can leak URLs to third parties or spend Firecrawl calls too freely (D-068).** `web_fetch` reads
  arbitrary public URLs, and Jina/Firecrawl are external services. Mitigation: Trevor applies its own URL
  safety guard before every backend, uses static fetch first, calls Jina only for unusable/thin static content,
  calls Firecrawl only after Jina fails and `FIRECRAWL_API_KEY` is configured, reports third-party provenance,
  caps outputs/time/bytes, and keeps Firecrawl prompt guidance/evals focused on avoiding routine use.
- **Filesystem roots can drift into hard-to-clean dotdir sprawl (D-069).** Current code already mixes
  `~/.trevor` service data, `~/.trevorV2` config, `~/.pi` auth, and `~/.agents` shared assets. Mitigation:
  new features follow the explicit root taxonomy, `/doctor` reports resolved roots, and existing `~/.trevor`
  service data is migrated only through a deliberate state-layout cleanup with compatibility/rollback.
- **Docs caching can become stale, huge, or substitute for local source truth (D-070).** A `docs` tool that
  eagerly scrapes broad sites can waste network calls and context, while stale docs can mislead coding work.
  Mitigation: docs corpora are scoped, capped, cited, stale after 24 hours, refreshed intentionally through
  `web_fetch`, and prompt guidance keeps workspace truth on local code/search/LSP/tests instead of cached docs.
- **Clipboard prompt turns can become a hidden general-purpose agent path (D-071).** If `/clip <request>` gets
  the full tool surface, it can run unrelated work just to populate the clipboard, or hide useful output from
  the transcript. Mitigation: prompt `/clip` is clipboard-only, visible, plain-text first, and limited to
  selecting, transforming, or composing text from existing context before one `clipboard_write`.
- **Output styles can become hidden work modes (D-072).** If styles influence routing, tools, execution mode,
  or validation, they recreate a weaker version of the dropped work-kind/routing system and make transcripts
  harder to reproduce. Mitigation: styles are additive presentation overlays only, with explicit source
  attribution, run metadata, prompt tests, and evals that prove tool/routing/execution surfaces do not change
  when the style changes.
- **Doctor can become either noise or a blocking health check (D-073).** A raw debug dump is hard to act on,
  while unbounded live probes can make diagnostics slow or flaky. Mitigation: `/doctor` returns structured
  health areas with status, evidence, and next actions; raw internals stay in detail/debug surfaces; probes are
  explicit, time-bounded, non-mutating, and degrade to `not_checked`/`timeout`; Storybook fixtures prove the
  web layout before runtime wiring.
- **Capability manifests can bloat prompts or become stale docs (D-074).** A manifest that is handwritten or
  injected whole into normal turns becomes stale and expensive; a manifest treated as authorization blurs the
  tool boundary. Mitigation: derive it from registries, version it, expose full/export forms separately from
  compact scoped model context, summarize huge dynamic catalogs, and keep execution authority at the existing
  tool/command/agent boundaries.
- **Loop can become UI-coupled or unbounded recurring work (D-067).** If `/loop` exists only as a rich web
  helper, it becomes a UI macro instead of a host feature; if loops can start from prose without confirmation
  or without explicit bounds, they can create surprising repeated work. Mitigation: the host owns the
  authoritative loop domain and deterministic slash parser, the rich helper is rendered from a shared
  contract, every loop requires an action plus a bound/cadence, controls are visible, and natural-language
  drafting is deferred behind a confirmation-gated agent tool.

---
_Consolidated 2026-06-23: single plan; FEATURES.md + TABLED.md deleted and folded in; graceful-overflow-recovery merged (D-034…D-038); routing engine + T-1 dropped for good (D-032); work-kinds kept inert (D-039). Supersedes all prior Trevor V2 planning documents._

_Updated 2026-06-24: overflow recovery **shipped** (status event renamed `assistant.compacted` →
`assistant.recovered`; proactive prompt-estimate detection; 4-bit at 64k). **Cross-turn compaction** added as
the next feature (D-040…D-043: hybrid pin+drop+summarize; trigger = background-after-turn at 80% +
blocking-before guard + recovery airbag, compact-to ~50%; durable non-mutating `context.compacted` rolling
event with a per-fold delta manifest; tool-less ~1k summary on the turn model with a local↔cloud-routing future). **Session recall** added as
a deferred post-subagents layer (D-044: isolated sub-agent, BM25 + neighborhood expansion, this-session-only).
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
4-bit case where five turns died at exactly `MAX_STEPS=8` with the window at 16-18%). **Per-turn tool-call
guardrails** parked as a later correctness follow-up (D-054…D-058), inspired by Hermes'
[`agent/tool_guardrails.py`](https://github.com/NousResearch/hermes-agent/blob/main/agent/tool_guardrails.py)
and Trevor V1's `ToolProgressMonitor`: pure per-turn controller, registry-derived read-only classification,
redacted fingerprints, simple V2-local failure classification, warn-first with opt-in hard stops, and no
durable Tool Progress Lessons in the first cut. New decisions **D-040…D-058 are authored here in markdown
and still need syncing into `plan.db`** (canonical store)._

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

_Updated 2026-06-25: **LSP integration posture** clarified as D-063. LSP remains deferred and unsequenced;
the first implementation is read-only, pull-only, and based on Trevor V1's useful non-mutating surface, with
workspace symbols added as an explicit V2 read-only navigation primitive. Required prompt guidance must tell
the model when to use document symbols, workspace symbols, hover, diagnostics, and code-action proposals
and when not to use LSP in favor of `rg`, `ast_grep`, direct reads, tests, typecheck, or compiler output.
Evals must cover navigation benefit, typed-repair benefit, read-only code-action behavior, and distraction
regressions. Ambient real-time diagnostics and automatic prompt injection are explicitly rejected; mutating
LSP actions are deferred to a separate phase. D-063 is authored here in markdown and still needs syncing into
`plan.db` alongside D-040-D-062._

_Updated 2026-06-25: **Hooks runtime posture** clarified as D-064. Hooks remain deferred and unsequenced; the
first cut is command hooks for `PreToolUse` plus a `Stop` hook, with V1's trust-hash, explicit decision,
visible event, and `/doctor` model retained. The first cut explicitly rejects a broad plugin bus,
PostToolUse, native extension dispatch, model-routing hooks, long-running hook daemons, and shell-splitting by
default. D-064 is authored here in markdown and still needs syncing into `plan.db` alongside D-040-D-063._

_Updated 2026-06-25: **Provider auth/catalog + full model chooser** added as D-065. The future chooser is a
host-owned model-source and model-catalog layer covering local/manual models, OAuth subscriptions, large
gateway catalogs, and direct API-key providers. It captures source auth/status, queryable large catalogs,
stable `{sourceId, modelId, reasoning}` selection, per-model detected reasoning controls, source-aware
setup actions, sidebar model/reasoning constraints, and tests for huge catalogs, auth states, local
availability, reasoning capability, persistence, and non-blocking refresh. D-065 is authored here in markdown
and still needs syncing into `plan.db` alongside D-040-D-064._

_Updated 2026-06-25: **MCP client runtime posture** clarified as D-066. MCP is now specified as a generalized
host-owned MCP server registry and client, carrying forward Trevor V1's useful shape: named servers,
stdio/Streamable HTTP/SSE transports, separate tools/resources/prompts, elicitation, sampling mediation, auth,
credential-store boundaries, redaction, lifecycle, diagnostics, prompt guidance, and evals. Tool proxy is
explicitly not the MCP abstraction or bridge; if configured, it is one named MCP server like any other. D-066
is authored here in markdown and still needs syncing into `plan.db` alongside D-040-D-065._

_Updated 2026-06-25: **Loop command surface posture** clarified as D-067. `/loop` is specified as a
host-owned recurring/cadence work feature with a UI-neutral command-family contract and rich Trevor web helper
rendered from structured preview data. The first implementation carries forward explicit slash grammar,
quote/duration rules, diagnostics, controls, lifecycle, runners, persistence, safety, and evals. Natural-language
loop drafting is deferred as a later confirmation-gated agent tool that structures a loop draft but never starts
execution directly. D-067 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-066._

_Updated 2026-06-25: **Web fetch posture** added as D-068. `web_search` is treated as already shipped; the
remaining feature is `web_fetch`, an explicit public-URL fetch tool with static extraction first, direct Jina
Reader as the first JS-blocked/thin-page fallback, and Firecrawl as the final configured fallback only after
Jina cannot produce usable content. Firecrawl uses the official Node SDK and `FIRECRAWL_API_KEY`, is disabled
gracefully when the key is missing, and must not be called for ordinary pages. No Dendrite/Python scraper
integration is planned. D-068 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-067._

_Updated 2026-06-25: **Filesystem root taxonomy** added as D-069. `~/.trevorV2` is the current Trevor config
root and eventually migrates/renames to `~/.trevor`; `~/.config/trevor` is used only when an explicit
config-root export points there. Disposable cache goes in `~/.cache/trevor`, durable local state goes in
`~/.local/state/trevor`, shareable local data goes in `~/.local/share/trevor`, model auth remains in `~/.pi`,
and shared agent assets remain in `~/.agents`. Existing `~/.trevor` service-data defaults are migration debt,
not a pattern for new state. D-069 is authored here in markdown and still needs syncing into `plan.db`
alongside D-040-D-068._

_Updated 2026-06-25: **Docs tool** added as D-070. The future model-facing `docs` tool uses `web_search` for
discovery and `web_fetch` for page reads, stores normalized documentation corpora under
`~/.local/state/trevor/docs`, marks pages/corpora stale after 24 hours, and refreshes intentionally. It is
bounded by docs roots, same-domain/path scope, page/byte/depth caps, provenance, and prompt guidance that keeps
workspace truth on local files/LSP/search/tests rather than cached external docs. D-070 is authored here in
markdown and still needs syncing into `plan.db` alongside D-040-D-069._

_Updated 2026-06-25: **Clipboard write surface** added as D-071. The future `/clip` command carries forward
Trevor V1's useful behavior under the new command name: bare `/clip` is a host-owned copy-last-item command,
while `/clip <request>` is a restricted clipboard-only model turn that selects, transforms, or composes the
exact text to copy and calls `clipboard_write`. The first cut is plain text only, visible in command/tool
events, and explicitly excludes shell clipboard commands, clipboard reads, rich clipboard formats, and hidden
assistant-output delivery. D-071 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-070._

_Updated 2026-06-25: **Output-style registry** added as D-072. The deferred V2 feature carries forward Trevor
V1's useful assistant output-style model: shared style metadata, built-in style ids, additive prompt overlays,
`/style` selection, settings visibility, local-state persistence, and run attribution. Styles are explicitly
presentation-only and must not affect routing, work kind, execution mode, tool access, agent selection, or
validation. V1's router-suggested styles are not carried forward through the dropped routing engine; any later
automatic style suggestion path must be presentation-only, source-attributed, and disabled by explicit
user/config style. D-072 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-071._

_Updated 2026-06-25: **Doctor health surface** added as D-073. The deferred V2 feature replaces the current
debug-dump `/doctor` output with a V1-inspired structured health report: host-owned immediate command,
`doctor.current`-style snapshot, areas/checks/findings, severity aggregation, evidence, redaction, and next
actions. Trevor web must build the diagnostic dashboard in Storybook first using fixture snapshots, covering
responsive grid layouts and healthy/warning/error/not-checked states before live app wiring. Fresh probes are
allowed only when bounded and non-mutating; raw internals belong in detail/full/json/debug surfaces, not the
default doctor view. D-073 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-072._

_Updated 2026-06-25: **Capability manifest** added as D-074. The deferred V2 feature carries forward Trevor
V1's registry-derived manifest shape: a full human/JSON export plus compact scoped capability context for
subagents and other non-TUI consumers. It should describe tools, commands, command families, domain contracts,
agents, skills, MCP summaries, LSP/web/docs status, hooks, and runtime surfaces without becoming a permission
system or giant prompt dump. Dynamic catalogs are summarized and queried explicitly. D-074 is authored here in
markdown and still needs syncing into `plan.db` alongside D-040-D-073._

_Updated 2026-06-25: **Discovery registry + progressive skill drill-in** added as D-075. The deferred V2
feature carries forward Trevor V1's useful discovery shape while preserving current V2's ambient skill
awareness: every tool-enabled turn gets a compact skill roster, but searchable skill metadata and full bodies
move behind `skills_list(query?, limit?)` and `skill_view(skillId)`. The host owns discovery for skills, slash
commands, command families, and later agents; Trevor web renders structured read models instead of scanning or
duplicating inventories. D-075 is authored here in markdown and still needs syncing into `plan.db` alongside
D-040-D-074._

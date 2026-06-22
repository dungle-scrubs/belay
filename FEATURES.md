# Trevor V2 — Feature Inventory & Rebuild Burndown

> **SUPERSEDED IN PART (2026-06-22 pivot to browser/Richter).** Sections 0 (prime directive), 1 (host-TUI
> stdio contract), 5 (TUI inventory), 6 (TUI protocol appendix), and 7 (TUI slice order) are superseded:
> there is no Rust TUI, the transport is Richter-participant WebSocket, and the slice order is browser-first
> (S0 browser-Richter, S1 host echo, S2 local model, S3 pi-ai). The section 4 host feature inventory
> (H-001 through H-174) remains valid as the backlog. Canonical decisions: `plan.db` D-013 through D-020.
> Current plan: `.plans/host-rebuild/implementation.md`.

> Living inventory of **100% of features** across the existing Trevor host (TypeScript)
> and TUI (Rust), where each lives, and how the two connect. This is the source of
> truth for rebuilding the **host** from scratch on [Effect](https://effect.website/docs),
> **one feature at a time**, while reusing the existing Rust TUI **unchanged**.

---

## 0. How to use this document

**Prime directive.** The Rust TUI is reused as-is. The seam between TUI and host is a
**JSONL wire protocol over stdio** — a true language boundary, pinned by golden fixtures
and a runtime hash handshake. As long as the new host reproduces that byte stream, the
TUI cannot tell it was rewritten. **The protocol is the immutable contract; everything
else is an implementation choice.**

**Columns.**
- **Decision** — `KEEP` (port to V2), `DROP` (do not port — see §3), `DEFER` (port late), `TABLE` (set aside — see [TABLED.md](./TABLED.md)).
- **Status** — `todo` (not built in V2), `wip`, `done`; TUI rows are `reuse` (already exist, unchanged).

**Workflow.** Each KEEP feature is rebuilt as a **vertical slice**: its protocol event(s)
+ host logic + a test that proves the exact wire output, landing green before the next
slice starts. Flip the row's Status here as you go. The §7 build order sequences the slices
so the TUI visibly comes alive feature by feature.

**Source.** Old host: `~/dev/trevor/packages/agent-host` (~90K LOC, 25 subsystems).
Old TUI: `~/dev/trevor/tui` (Rust, ratatui/crossterm, ~333 files). Contract:
`~/dev/trevor/packages/protocol`.

**Decisions locked (2026-06-18).** Effect **v3 stable**. TUI + `packages/protocol`
**copied into `trevorV2/`** (reused unchanged). Routing classification **tabled**
([TABLED.md](./TABLED.md)). Runtime: **Bun**, compiled binary. Routing: fixed posture,
roles **main + ghost** (background ≡ main), each an ordered model array (offline → local
fallback).

**TUI compile-time coupling (important).** The Rust TUI embeds host-owned JSON artifacts
via `include_str!`. To keep it literally unchanged, V2 must keep these files at these exact
relative paths: `packages/protocol/schema/*`, `packages/protocol/src/output-style-metadata.json`,
`packages/agent-host/src/provider/login-provider-metadata.json`,
`packages/agent-host/src/prompt-production/slash-command-inventory.json`. (All copied into
`trevorV2/` already.) The new host owns regenerating these contract artifacts.

---

## Table of contents

1. [Architecture & the host↔TUI contract](#1-architecture--the-hosttui-contract)
2. [Cross-cutting domain vocabulary](#2-cross-cutting-domain-vocabulary)
3. [The DROP list (multi-user & collaboration)](#3-the-drop-list--multi-user--collaboration)
4. [Host feature inventory (the rebuild burndown)](#4-host-feature-inventory--the-rebuild-burndown)
5. [TUI feature inventory (consumed contract, reused unchanged)](#5-tui-feature-inventory--consumed-contract-reused-unchanged)
6. [Protocol surface appendix (the acceptance contract)](#6-protocol-surface-appendix--the-acceptance-contract)
7. [Suggested rebuild order (vertical slices)](#7-suggested-rebuild-order--vertical-slices)

---

## 1. Architecture & the host↔TUI contract

Two processes, one pipe:

```
┌──────────────────────┐   ClientCommand (JSON line) → stdin    ┌───────────────────────┐
│  Rust TUI (unchanged) │ ─────────────────────────────────────▶│  TS host (rebuild on   │
│  ratatui + crossterm  │                                        │  Effect)               │
│  spawns host as child │◀───────────────────────────────────── │  emits ServerPayload    │
└──────────────────────┘   ServerPayload envelope ← stdout       │  (JSON line) to stdout │
                                                                  └───────────────────────┘
```

| Concern | How it works today | What V2 must preserve |
|---|---|---|
| Transport | TUI spawns host child (`TREVOR_HOST_CMD`, default `bun run …/server/rpc.ts`); 3 threads: stdout reader, stderr reader, stdin writer; mpsc channel to UI loop | Read JSONL from stdin, write JSONL envelopes to stdout, exit on stdin EOF |
| Framing | Newline-delimited JSON. No length prefix. One command/event per line | Identical line framing |
| Envelope | `{ v, id, ts, sessionId, runId, turnId?, correlationId, traceparent?, tracestate?, traceId?, spanId?, type, payload }` | Exact envelope shape; `type` must be in `server-events.json` |
| Emission choke point | Host writes the wire only through `emitServerEvent(...)` (typed-emission-boundary test) | Reproduce a single typed choke point |
| Decode | TUI `app_event_decoder_registry` parses known `type`s into serde structs; **unknown types pass through silently** (forward-compat) | New events are safe; the TUI ignores what it doesn't know |
| Contract handshake | After `session.started`, host emits `contract.current` with sha256 of `server-events.json`; TUI compares to its embedded copy, **warn-only on mismatch** | Emit `contract.current` with matching hashes (or accept a warn line) |
| Lifecycle | spawn → `session.start` → `session.started` → `contract.current` → event loop → stdin EOF (30s grace → SIGTERM → SIGKILL); `ping`/`pong` heartbeat; `Ctrl+r` → `session.resume` | Same handshake + heartbeat + graceful shutdown |
| Errors | Malformed host stdout → visible `DecodeFailed` transcript line; stderr lines surfaced; crash → "press Ctrl+r" | Never emit malformed lines; keep stderr for logs only |

**Why this de-risks "TUI unchanged":** the contract is executable. The new host can be
diffed against the old one by replaying recorded `(ClientCommand → ServerPayload)`
transcripts, and the golden fixtures in `packages/protocol/schema/fixtures/*.json` (one
per event) are the per-event acceptance tests.

---

## 2. Cross-cutting domain vocabulary

These nouns appear everywhere; keep them stable in V2 (they're baked into the protocol).

| Term | Meaning |
|---|---|
| **Session** | Durable container for a conversation: steering state, defaults, queue, resumable context; survives restart |
| **Turn** | User-facing conversational unit; follow-up and steering both count as turns; one turn → ≥1 runs |
| **Run** | One bounded host execution attempt; owns lifecycle, cancellation, cost, context, diagnostics |
| **Work kind** | Type of work: `chat`, `plan`, `analysis`, `implement`, `review`; drives model selection/validation/escalation |
| **Execution mode** | `direct`, `delegate_inline`, `delegate_background` |
| **Routing** | Work-kind-aware model/provider selection from intent + constraints + capability + policy |
| **Provider** | Routable target (OpenRouter, OpenAI, Anthropic, LM Studio, Ollama, local EmberLM) |
| **Adapter** | Transport to reach a provider (OpenAI-compat HTTP, Anthropic-compat HTTP, SDK, …) — never collapse with provider |
| **Tool** | Executable capability owned by a run (read, edit, bash, rg, web_fetch, …) |
| **Subagent** | Delegated agent (built-ins: `worker`, `explore`, `verification`); inherits main route unless pinned |
| **Bounded child** | Internal constrained helper; host-owned, not user-delegated; returns a structured artifact |
| **Steering / hard steering** | User control mid-request; ordinary = recorded via turn/run; hard = interrupts the provider path |
| **Transcript** | Durable record of turns/runs/tools/events; primary truth |
| **Prompt view** | The filtered subset of session state actually sent to the model |

---

## 3. The DROP list — multi-user & collaboration

The maintainer is dropping multi-user. These features and their protocol arms are **not
ported** to V2. Removing them collapses a large amount of lease/authority/ownership
plumbing that threads through `server/rpc`.

| Dropped capability | Lives in (old) | Protocol arms that go dead | What it simplifies |
|---|---|---|---|
| **Control lease** (acquire/release/holder, mutation authority gate) | `server/rpc/control-lease-commands.ts`, `authority.ts`, `command-authority.ts`, `mutation-commands.ts` | cmd `controlLease.*`; evt `controlLease.current`; `session.started.controlLease/ownerId`; errors `LEASE_*`; family `lease` | Every mutating command becomes unconditional; no `leaseHolderId`/`leaseStatus` |
| **Multi-client identity** (ownerId/clientId, shared transcript, presence, join/leave) | `authority.ts`, sessions table `owner_id/client_id/transport` | `clientId` on every command; `ownerId`/`transport` on session events | Single implicit client; drop `clientId` plumbing |
| **Teams** (roster, inbox, direct messages, audit, coordination) | `persistence/team-store.ts`, `server/rpc` team handlers | cmd `team.message.send`, `team.inbox.post`; evt `team.status`, `team.member_output`; status `Team*` enums | Delete an entire persistence store + UI modal |
| **Workspace leasing/ownership** (acquire with isolation/ownerId) | `server/rpc/workspace-commands.ts` | cmd `workspace.acquire`; evt `workspace.acquire.result` | Keep `workspace.switch`/`list`/`create`; drop acquire/own |
| **Remote/WebSocket transport & shared sessions** (architectural, mostly unbuilt) | docs only | — | Local stdio child stays the only transport |

> **TUI side:** the **Teams modal** (`tui/src/app/teams_modal.rs`) and lease/owner chrome
> in the header simply never receive their events and stay dark — no TUI change needed.
> Confirm exact boundary before locking (see open questions at end of session).

---

## 4. Host feature inventory — the rebuild burndown

> All rows `todo` (nothing built in V2 yet). Paths are in the **old** host
> (`packages/agent-host/src/…`) for reference while porting.

### 4.1 Transport, command loop & session/run lifecycle (`server/rpc`, ~40K LOC)

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-001 | JSONL command loop + dispatch (lane routing primary/read/control, validation) | `command-loop.ts`, `command-dispatcher.ts`, `client-command-validation.ts` | all ClientCommands; `error`, `pong` | KEEP | todo |
| H-002 | Envelope emission + transcript/db persist + tracing headers + single choke point | `envelopes.ts` | every ServerPayload; `contract.current` | KEEP | todo |
| H-003 | Session lifecycle (start/list/resume/restart, generation, hydrate) | `session-lifecycle.ts`, `session-bootstrap.ts`, `session-restore.ts`, `session-commands.ts` | `session.start/list/resume`; `session.started/resumed`, `sessions.current` | KEEP | todo |
| H-004 | Session tree & history (branches, turns, snapshot, switch) | `history.ts`, `workspace-session-persistence.ts` | `session.tree.switch`; `session.history.current`, `session.tree.switch.rejected` | KEEP | todo |
| H-005 | Submission dispatch & execution pipeline | `submission-dispatch.ts`, `submission-state.ts`, `submission-execution.ts`, `submission-events.ts` | `prompt.submit` | KEEP | todo |
| H-006 | Submission planning (classify/compact/context-fit) | `submission-planning.ts`, `submission-compaction.ts` | `route.classifying/resolved/outcome` | KEEP | todo |
| H-007 | Submission modes + follow-up queueing (follow_up/steering/retry, delivery policy) | `follow-up-prompt.ts`, `submission-follow-up-history.ts` | `prompt.submit.submissionMode`; settings | KEEP | todo |
| H-008 | Hard steering / alternate path (structured interruption packet, provider+tool interrupt) | `submission-dispatch.ts` | `prompt.submit.hardSteering`; `hard_steering.applied`, `steering.applied` | KEEP | todo |
| H-009 | Turn lifecycle state machine (open→running→completed/failed/cancelled, recovery) | `turn-lifecycle-state-machine.ts` | `turns.current`; turn recovery/retry fields | KEEP | todo |
| H-010 | Run lifecycle & IDs (activeRunId, abort controller, run↔turn map) | `session-lifecycle.ts`, `submission-execution.ts` | `run.stopped`, `run.metrics.current` | KEEP | todo |
| H-011 | Cancellation & interruption (`input.cancel`, tool interrupt policy) | `mutation-commands.ts`, `submission-dispatch.ts` | `input.cancel` | KEEP | todo |
| H-012 | Watchdog / idle-timeout (per-run probe, stuck detection) | `watchdog-runtime.ts`, `submission-events.ts` | `host.watchdog` | KEEP | todo |
| H-013 | Control lease & mutation authority | `control-lease-commands.ts`, `authority.ts`, `command-authority.ts` | `controlLease.*` | **DROP** | n/a |
| H-014 | Multi-client identity (ownerId/clientId) | `authority.ts`, `command-loop.ts` | `clientId` everywhere | **DROP** | n/a |
| H-015 | Read-model emission (turns/metrics/settings/home/workspace/progress snapshots) | `current-state.ts`, `state-commands.ts`, `session-metrics.ts` | `*.current` events; `ping`→`pong` | KEEP | todo |
| H-016 | Slash-command routing at RPC (immediate host commands) | `host-commands.ts` | `/init /doctor /usage /login /skills /agents /subagents /tasks /style /cd /shell /hooks /lsp /compact …` | KEEP | todo |
| H-017 | Error envelopes + classification (family/code/retryable, B11 choke) | `host-error-classification.ts`, `envelopes.ts` | `error` (44 codes, 9 families) | KEEP | todo |
| H-018 | Provider question coordination (buffer→`requested`→answer→`resolved`) | `provider-questions.ts` | `provider.question.requested/resolved`; cmd `provider.question.answer` | KEEP | todo |
| H-019 | Auth input / OAuth login coordination at RPC | `auth-commands.ts`, `host-commands.ts` | cmd `auth.input`; evt `auth.prompt/info` | KEEP | todo |
| H-020 | Workspace switch + fingerprints (drift, blockers, managed worktree capture) | `workspace-commands.ts`, `workspace-fingerprints.ts` | `workspace.switch/create/list/current`; results | KEEP | todo |
| H-021 | Workspace acquire / isolation / ownership | `workspace-commands.ts` | `workspace.acquire(.result)` | **DROP** | n/a |
| H-022 | Language-server control commands | `language-server-commands.ts` | `languageServer.*` (8 cmds, 9 evts) | DEFER | todo |
| H-023 | Background work registry (tasks, subagent runs, shell jobs) | `background-work.ts`, `child-run-lifecycle.ts` | `task.started/completed`, `childAgent.*` | KEEP | todo |
| H-024 | Bounded-child / fallback helper execution | `bounded-child.ts`, `submission-bounded-child.ts`, `takeover-runtime.ts` | `route.boundedChild.*`, `route.helper.*` | DEFER | todo |
| H-025 | Route takeover & escalation handoff | `takeover.ts`, `submission-completion.ts` | `route.takeover.*` | DEFER | todo |
| H-026 | Offline detection & recovery (probe, confirm gate, recovery loop) | `offline-detection.ts`, `offline-recovery.ts` | `offline_entered/exited` | KEEP | todo |
| H-027 | Submission error handling (fallback, scheduled retry, failure mark) | `submission-error.ts`, `submission-failure.ts` | `scheduledRetry.*`, `route.retry_*` | KEEP | todo |
| H-028 | Submission completion + self-validation + async follow-ups | `submission-completion.ts` | `assistant.completed`, `verification.verdict` | KEEP | todo |
| H-029 | Loop service & cadence scheduler (`/loop`: draft/confirm/run/stop) | `loop-service.ts`, `loop-commands.ts`, `loop-cadence-scheduler.ts` | `loop.*` (9 cmds); `loop.inventory.current`, `loop.iteration.started` | DEFER | todo |
| H-030 | Tangent management (lateral exploration threads) | `tangent-read-models.ts`, `tangent-capability-policy.ts` | `tangent.*` (4 cmds, 7 evts) | DEFER | todo |
| H-031 | Settings & preferences (output style, thinking mode, model assignment) | `output-style-settings.ts`, `session-preferences.ts` | `settings.get/update`; `settings.current` | KEEP | todo |
| H-032 | Progress surface (named progress rows) | `progress-surface.ts` | `progress.get`; `progress.current` | KEEP | todo |
| H-033 | Routing observability/telemetry (trigger signals, stage timings) | `routing-observability.ts` | (internal; feeds route events) | DEFER | todo |
| H-034 | Session metrics & token accounting (per provider/model usage, cost) | `session-metrics.ts` | `session.metrics.get`; `session.metrics.current`, `usage.current` | KEEP | todo |
| H-035 | Shell promote (`shell.promote`) | `host-commands.ts` | cmd `shell.promote` | DEFER | todo |
| H-036 | Hooks integration at RPC (record hook executions) | `envelopes.ts` | `hook.*` (6 evts) | DEFER | todo |

### 4.2 Agent loop & LLM I/O core (`agent/`, `provider/`, `sampling.ts`)

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-040 | Agent turn/message cycle (drives provider + tools, multi-turn tool results) | `agent/loop.ts` | `agent.state`, `assistant.*` | KEEP | todo |
| H-041 | Tool-call orchestration (execute, collect, feed back) | `agent/tool-call-orchestrator.ts`, `tool-execution.ts` | `tool.*` | KEEP | todo |
| H-042 | Agent state machine (thinking/executing/streaming/awaiting) | `agent/loop.ts` | `agent.state` | KEEP | todo |
| H-043 | Provider interface & registry (provider↔adapter split, dynamic import) | `provider/core.ts`, `registry.ts` | — | KEEP | todo |
| H-044 | pi-ai adapter (Anthropic/OpenAI/OpenRouter/… via `@mariozechner/pi-ai`) | `provider/local-pi-ai-provider.ts`, `pi-ai-request-builder.ts`, `local-pi-ai-auth.ts` | — | KEEP | todo |
| H-045 | LM Studio / EmberLM local adapter (omlx/mlx runtime, `/v1` + `/v1/warm`) | `provider/lmstudio-provider.ts`, `lmstudio-capability-mapper.ts` | — | KEEP | todo |
| H-046 | Ollama native adapter | `provider/ollama-native-provider.ts` | — | DEFER | todo |
| H-047 | Provider bootstrap & policy (effective policy, capability matrix) | `pi-ai-runtime.ts`, `policy.ts` | provider bootstrap obs events | KEEP | todo |
| H-048 | Stream decoder (text/reasoning/toolCall/done/error → deltas + usage) | `provider-stream-result-decoder.ts`, `provider-stream-runtime.ts` | `assistant.delta`, `assistant.reasoning.delta`, `provider.stream.event` | KEEP | todo |
| H-049 | Streaming idle-timeout guard (`streamDeltasWithIdleTimeout`) | `agent/event-runtime.ts` | (→ `host.watchdog`/timeout error) | KEEP | todo |
| H-050 | Cancellation primitives (`raceWithCancellation`, `RunCancelledError`, `throwIfCancelled`) | `agent/runtime-errors.ts` | `RUN_CANCELLED` | **KEEP → re-express in Effect** (fibers/interrupt) | todo |
| H-051 | Provider idle-timeout (`raceWithProviderIdleTimeout`, diagnostics) | `agent/runtime-errors.ts` | `PROVIDER_TIMEOUT` | **KEEP → Effect.timeout** | todo |
| H-052 | Sampling controls + sources (temp/topK/topP, work-kind/route/override layers) | `sampling.ts`, `policy.ts` | — | KEEP | todo |
| H-053 | Structured interruption packet (phase, provider cancel + tool interrupt caps) | `agent/loop-types.ts` | hard steering | KEEP | todo |
| H-054 | Provider approval flow (request/resolve tool-use approval) | `agent/loop-types.ts` | `provider.approval.requested/resolved` | KEEP | todo |
| H-055 | Run budget (max tool calls/run, max consecutive rejections) | `agent/run-budget.ts` | `RunBudgetExceededError` | KEEP | todo |
| H-056 | Tool progress monitor + lessons (fingerprint no-progress, DB-backed blocks) | `agent/tool-progress-monitor.ts`, `tool-progress-lessons.ts` | `tool.progress.signal`, `tool.progress.lessons.current` | KEEP | todo |
| H-057 | Local provider admission control (token reservation, queue, concurrency) | `provider/local-admission.ts` | `provider.local_admission.*` (4 evts) | DEFER | todo |
| H-058 | Runtime failure classification (scope/kind/retryable taxonomy) | `provider/runtime-failure.ts` | feeds `error`, route retry | **KEEP → Data.TaggedError** | todo |
| H-059 | Native extension dispatch (run/tool boundary hooks) | `agent/loop.ts` | `extension.lifecycle`, `process.lifecycle` | DEFER | todo |
| H-060 | Provider API key resolution (env → auth.json → OAuth refresh) | `provider/local-pi-ai-auth.ts` | — | KEEP | todo |
| H-061 | Runtime secret resolution (`op://`, `!command`, literal; gated) | `provider/secret-resolver.ts` | — | DEFER | todo |
| H-062 | Provider tool surface modes (default / bounded_child / selected_child_read_only / clipboard) | `provider/provider-context.ts`, `provider-tool-surface.ts` | — | KEEP | todo |
| H-063 | Event emitter + metadata threading (id/correlation/trace/span) | `agent/event-runtime.ts` | all events | KEEP | todo |
| H-064 | Run metrics (`run.metrics.current` after each provider message) | `agent/loop.ts` | `run.metrics.current` | KEEP | todo |

### 4.3 Observability (`observability/`)

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-070 | ObservabilityAdapter interface (run/provider/tool/routing/lsp callbacks, spanId) | `agent/observability-types.ts` | (telemetry) | **KEEP → Effect.withSpan candidate** | todo |
| H-071 | Observability runtime loader (`TREVOR_OBSERVABILITY_MODULE`) | `observability/runtime.ts` | — | KEEP | todo |
| H-072 | OTel adapter + span lifecycle registry (orphan detection) | `observability/otel.ts`, `span-lifecycle-registry.ts` | OTel export | DEFER | todo |
| H-073 | Provider attempt trace (opt-in JSONL, `TREVOR_PROVIDER_TRACE`) | `agent/provider-trace.ts` | `.trevor/traces/*.jsonl` | DEFER | todo |

### 4.4 Routing (`routing/`, `packages/routing-contract`)

> **V2 routing shape (D-007):** fixed posture, no model-led classifier. Role set = **main** + **ghost** only (**background ≡ main**); old `router`/`vision`/`tool_lesson` roles are moot (classifier tabled, bounded-helpers deferred). Each role is an **ordered array of models** (fallback chain), so e.g. offline → local fallback. Focus: local + cloud models.

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-080 | Candidate selection & ranking (quality tier, context fit, locality, cost) | `routing/candidate-planning.ts`, `role-validation.ts`, `core.ts` | `route.resolved` | KEEP | todo |
| H-081 | Model levels & quality tiers + posture (balanced/max, floors) | `candidate-planning.ts`, `posture.ts` | — | KEEP | todo |
| H-082 | Work-kind registry (chat/plan/analysis/implement/review, sampling, validation mode) | `work-kind-registry.ts`, `registry.ts` | `error` work-kind codes | KEEP | todo |
| H-083 | Execution modes (direct / delegate_inline / delegate_background) | `core.ts`, `execution-plans.ts` | — | KEEP | todo |
| H-084 | Route intent classification (model-led + heuristic + fixed) | `classification.ts`, `routing-intent-policy.ts` | `route.classifying` | KEEP | todo |
| H-085 | Routing classifier (model-led) — **currently disabled via `routing.enabled:false`** (~9K LOC + 76 tests, dormant) | `server/rpc/prompt-classification.ts`, `routing/router-eval.ts`, `routing-contract` | gated | **TABLE** ([TABLED.md](./TABLED.md) T-1) | n/a |
| H-086 | Bounded helper families (vision/webAccess/workspaceRead → artifacts) + reuse | `routing/helper.ts`, `handoff.ts` | `route.helper.*` | DEFER | todo |
| H-087 | Validation modes + criteria + escalation actions | `validation-mode-registry.ts`, `validation.ts` | `verification.verdict`; escalation | KEEP | todo |
| H-088 | Self-validation (deterministic + LLM prompt, bounded local) | `validation.ts`, `core.ts` | — | KEEP | todo |
| H-089 | Route outcomes / failure policy / recovery decisions | `outcomes.ts`, `route-failure-policy.ts` | `route.outcome`, `route.provider_*` | KEEP | todo |
| H-090 | Route observation & learning reports (window comparison, helper rates) | `reporting.ts` | (telemetry) | DEFER | todo |
| H-091 | Routing config + settings derivation + normalization + diagnostics | `routing/config.ts`, `registry.ts`, `server/rpc/routing-config-normalization.ts`, `routing-settings.ts` | `settings.current.routing` | KEEP | todo |
| H-092 | Role profiles & system-prompt merging | `config.ts`, `classification.ts` | — | KEEP | todo |
| H-093 | Connectivity probe + offline policy | `connectivity-probe.ts` | `offline_*` | KEEP | todo |
| H-094 | Provider recovery state (scheduled_retry / runtime_fallback) | `core.ts`, `routing/runtime-failure.ts` | `route.retry_*` | KEEP | todo |
| H-095 | Routing backend selection (builtin; pluggable) | `routing/backend.ts` | — | KEEP | todo |
| H-096 | Local provider state/availability/warming hooks | `server/rpc/routing-local-provider-state.ts`, `local-provider-lifecycle.ts`, `routing-model-metadata.ts` | `provider.reachability.current` | KEEP | todo |
| H-097 | Router model eval harness (semantic score, false-positive guards) | `routing/router-eval.ts` | — | **TABLE** ([TABLED.md](./TABLED.md) T-1) | n/a |

### 4.5 Tools (`tools/`, 27 tools)

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-100 | Tool execution core (registry, families, handler descriptors, watchdog) | `tools/core.ts`, `core-tool-family-registry.ts`, `handlers.ts`, `tool-watchdog.ts` | `tool.*`, `tools.identity.current` | KEEP | todo |
| H-101 | Result cache + volatility + workspace fingerprinting | `tools/cache.ts`, `metadata.ts` | — | DEFER | todo |
| H-102 | Tool metadata / toolsets / identity read-model / interruptibility policy | `tools/metadata.ts` | `tools.identity.current` | KEEP | todo |
| H-103 | Tool errors / boundary contracts / telemetry redaction | `tool-errors.ts`, `tool-telemetry.ts`, `process-errors.ts` | `tool.failed` | KEEP | todo |
| H-104 | **read** (line-paginated file/dir) | `tools/core.ts`, `read-pagination.ts` | tool exec | KEEP | todo |
| H-105 | **write** / **edit** (D-035 write confinement) | `file-write-tools.ts`, `tool-paths.ts` | tool exec | KEEP | todo |
| H-106 | **glob** (truncation reporting) | `tools/core.ts` | tool exec | KEEP | todo |
| H-107 | **rg** (ripgrep + JS fallback) | `tools/core.ts` | tool exec | KEEP | todo |
| H-108 | **ast_grep** (AST search) | `tools/core.ts` | tool exec | DEFER | todo |
| H-109 | **bash** (+ safety floor D-034, watchdog) | `bash-tool.ts`, `bash-safety.ts` | tool exec | KEEP | todo |
| H-110 | **process** (background supervisor: start/poll/wait/kill/write, circular buffer) | `process-tool.ts`, `process-supervisor.ts` | tool exec, `process.lifecycle` | KEEP | todo |
| H-111 | **clipboard_write** | `clipboard-tool.ts` | tool exec | KEEP | todo |
| H-112 | **code_search / code_index / project_retrieve / source_recall / session_recall** | `tools/core.ts` | tool exec | DEFER | todo |
| H-113 | **web_search / web_fetch** (fallbacks, policy, provenance) | `web-tools.ts`, `retrieval-follow-on.ts` | tool exec; `session.metrics.current.retrieval` | KEEP | todo |
| H-114 | **archive_read / archive_unpack** (+ validators, media processors) | `archive-tool.ts`, `archive-validators.ts`, `media-processors.ts` | tool exec | DEFER | todo |
| H-115 | **video_inspect** (frame extraction, artifacts; disables tools after) | `video-processor.ts` | tool exec | DEFER | todo |
| H-116 | **lsp** tool (codeActions/hover/rename/refs/applyEdit) | `lsp-tool.ts` | tool exec | DEFER | todo |
| H-117 | **skills_list / skill_view** | `skill-tools.ts` | tool exec | KEEP | todo |
| H-118 | **tool_script** (sandboxed read-only TS, tool bridge) | `tool-script-runner.ts` | tool exec | DEFER | todo |
| H-119 | **tool_proxy** (MCP client bridge) | `tool-proxy-mcp.ts` | tool exec | DEFER | todo |
| H-120 | **workspace_switch / child_output / usage / draft_loop** tools | `metadata.ts`, `usage-tool.ts`, `tools/core.ts` | tool exec | KEEP/DEFER | todo |
| H-121 | Artifacts dir + hashing + per-run cleanup | `tools/artifacts.ts` | — | KEEP | todo |
| H-122 | Path expansion + write confinement policy (D-035) | `tool-paths.ts` | — | KEEP | todo |

### 4.6 Persistence & state (`persistence/`, `retrieval/`, `workspace/`)

> **Open (OQ6):** V2 MAY optionally integrate **Richter** (a durable-sessions application) to back session durability — instead of, or alongside, the sqlite app-db + JSONL transcript store. Undecided; revisit at slice S3.

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-130 | App database (SQLite WAL): sessions, runs, history (FTS5), tree, lessons, tangents | `persistence/app-db.ts`, `app-schema-migrator.ts` | — | KEEP (drop owner/lease columns) | todo |
| H-131 | Transcript store (JSONL per session, checkpoints, oversized-line recovery) | `persistence/transcript-store.ts` | — | KEEP | todo |
| H-132 | Blob store (content-addressed sha256 externalization) | `persistence/blob-store.ts` | — | KEEP | todo |
| H-133 | Task ledger (per-project JSON, deps, status) | `persistence/task-ledger.ts` | `task.*` | KEEP | todo |
| H-134 | Team store (roster/inbox/DM/audit) | `persistence/team-store.ts` | `team.*` | **DROP** | n/a |
| H-135 | JSON store helpers (atomic, corrupt-recovery) | `persistence/json-store.ts` | — | KEEP | todo |
| H-136 | Repositories (session-history, tree, workspace-sessions, tangents, lessons) | `session-history-repository.ts`, `aggregate-repositories.ts` | — | KEEP | todo |
| H-137 | Session tree node ID derivation | `persistence/session-tree-node-id.ts` | — | KEEP | todo |
| H-138 | Retrieval core + source-recall adapter (CLI + daemon) | `retrieval/core.ts`, `source-recall.ts` | code_search tool | DEFER | todo |
| H-139 | Aleutian retrieval adapter (trace sidecar, auto-start) | `retrieval/aleutian.ts` | code_search tool | DEFER | todo |
| H-140 | Managed worktrees (stable paths/branches/hashes) | `workspace/managed-worktrees.ts` | workspace cmds | DEFER (entangled w/ acquire) | todo |
| H-141 | Workspace metadata (git status/worktree parsing) | `workspace/metadata.ts` | `workspace.current/list` | KEEP | todo |

### 4.7 Config, auth, identity, capabilities

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-150 | Paths constants (`.trevor`, state root, shared `~/.pi/auth.json`, discovery subdirs) | `config/paths.ts` | mirrored in `protocol/schema/path-fixture.json` | KEEP | todo |
| H-151 | JSONC config parser + resolution (`.jsonc`→`.json`) | `config/jsonc.ts` | — | KEEP | todo |
| H-152 | Tools config (write-confinement opt-out) / Secrets config (shell resolver opt-in) | `config/tools-config.ts`, `secrets-config.ts` | — | KEEP | todo |
| H-153 | Provider identity metadata catalog (15+ providers: aliases, auth-file keys, login alias) | `identity/provider-identity-metadata.ts` | — | KEEP | todo |
| H-154 | Auth store (atomic `~/.pi/auth.json`, 0600/0700, recovery) | `auth/auth-store.ts` | — | KEEP | todo |
| H-155 | OAuth onboarding (`/login` for openai/anthropic/google, PKCE, browser open) | `auth/oauth-onboarding.ts` | `auth.prompt`, cmd `auth.input` | KEEP | todo |
| H-156 | Capability manifest (tools + commands + contracts + surfaces, compact form) | `capabilities/manifest.ts` | — | KEEP | todo |

### 4.8 Integrations & remaining (`mcp/`, `lsp/`, `hooks/`, `doctor/`, `prompt-production/`, `cli/`, `client/`, `sdk/`, `domain-contracts/`)

| # | Feature | Lives in | Connects via | Decision | Status |
|---|---|---|---|---|---|
| H-160 | MCP client manager (stdio/HTTP-SSE, tools/resources/prompts, sampling, elicitation, env isolation) | `mcp/client.ts`, `host-mediation-policy.ts` | `tool_proxy` tool | DEFER | todo |
| H-161 | LSP service + runtime + lifecycle (start/stop, diagnostics/hover/symbols/actions, edits) | `lsp/service.ts`, `lifecycle.ts`, `document-session.ts`, `workspace-edit.ts`, `process.ts`, `runtime.ts` | `languageServer.*`, lsp tool | DEFER | todo |
| H-162 | Hooks runtime + trust + discovery (PreToolUse, allow/deny/halt/context, sha256 trust) | `hooks/runtime.ts`, `trust.ts`, `prompt-production/hooks.ts` | `hook.*` | DEFER | todo |
| H-163 | Doctor diagnostics (config/runtime/hooks/providers/LSP/workspace checks) | `doctor/diagnostics.ts` | `doctor.current` | KEEP | todo |
| H-164 | Output-style registry (assistant styles, router eligibility, prompt overlay) | `output-style/registry.ts` | `settings.current.outputStyle` | KEEP | todo |
| H-165 | Agent discovery (built-ins worker/explore/verification + `~/.trevor/agents`, override) | `prompt-production/agents.ts` | `subagents.inventory.current` | KEEP | todo |
| H-166 | Skill discovery (SKILL.md, triggers, asSlashCommand, override) | `prompt-production/skills.ts` | `skill.attached`, `skillFork.*` | KEEP | todo |
| H-167 | Slash-command discovery + routing + expansion (frontmatter, `$1/$ARGUMENTS`, nested) | `prompt-production/slash-commands.ts`, `slash-routing.ts`, `slash-nested.ts`, `command-files.ts` | host/product commands | KEEP | todo |
| H-168 | Frontmatter parser + markdown inventory + discovery config | `frontmatter.ts`, `markdown-inventory.ts`, `discovery-config.ts` | — | KEEP | todo |
| H-169 | Loop spec + compiler + command parser (NL draft → validated LoopSpec) | `domain-contracts/loop-spec.ts`, `loop-compiler.ts`, `loop-command-parser.ts` | `loop.draft` | DEFER | todo |
| H-170 | Domain-drift contracts (milestones, source-of-truth, compat fallbacks) | `domain-contracts/domain-drift-contracts.ts` | — | DEFER | todo |
| H-171 | CLI entrypoint (one-shot `--prompt`, `--json`) + runtime factory | `cli/prompt.ts`, `cli/runtime.ts` | — | KEEP | todo |
| H-172 | RPC client (non-TUI, stdio) + prompt client | `client/rpc-client.ts`, `rpc-prompt-client.ts` | (mirror of TUI transport) | DEFER | todo |
| H-173 | SDK `ask()` (programmatic single prompt) | `sdk/ask.ts` | — | DEFER | todo |
| H-174 | Smoke harness (stdin/stdout probe, envelope-sequence assert) | `server/smoke.ts` | — | KEEP (becomes conformance oracle) | todo |
| H-175 | **Shell interpolation in skills & commands** (NEW): single-line `!cmd` + multi-line ` ```! ` fenced blocks, executed at prompt-expansion time, stdout interpolated into the prompt; off by default, opt-in flag + per-file sha256 trust + D-034 deny-floor + timeout/cap | `prompt-production/` (extends slash/command/skill expansion) | wire-invisible (may surface in `prompt.view`) | KEEP (NEW) | todo |

---

## 5. TUI feature inventory — consumed contract, reused unchanged

> Status `reuse`: these already exist in `~/dev/trevor/tui` and are **not** rebuilt. They
> define **what the host must feed**. The "Host must feed" column is the real obligation
> on V2.

### 5.1 TUI architecture (skeleton — pure reuse)

| Area | Lives in | Note |
|---|---|---|
| Binary & launch, host spawn (`TREVOR_HOST_CMD`), event loop | `main.rs`, `app/bootstrap.rs`, `process.rs`, `process/host_stdio.rs` | Spawns the host; the only integration point V2 cares about |
| App state (`App` struct, run/turn records, overlay stack, selection, routing/task stores) | `app.rs`, `app/*` (185 files) | Mirrors host read-models |
| Render pipeline (ratatui 0.30 / crossterm 0.29, root_render, main_view, inspector) | `ui/*` (121 files) | — |
| Framework layer (SlotPlanner, hitbox registry, focus stack, list window, overlay stack) | `framework/*` | Domain-free mechanics |
| Protocol binding (envelope, decoder registry, serde payloads, client commands) | `protocol.rs`, `protocol/*` | **The contract mirror** — see §6 |
| Theming, keybindings, vim, selection, leader, clipboard, scroll, config persistence | `ui/chrome.rs`, `app/keybindings.rs`, `app/vim*.rs`, `app/selection*`, `app/leader.rs`, `app/clipboard.rs` | Local UI state |

### 5.2 TUI user-facing features (host must feed the right events)

| Area | Feature | Host must feed / consume | Decision |
|---|---|---|---|
| Transcript | Conversation render (role bands, markdown, code highlight) | `assistant.delta/completed`, `tool.*`, turn summaries | KEEP |
| Transcript | Reasoning stream | `assistant.reasoning.delta` | KEEP |
| Transcript | Route visibility rows | `route.classifying/resolved/outcome` | KEEP |
| Transcript | Tool grouping & progress | `tool.started/progress/completed/failed` | KEEP |
| Transcript | Image preview / vision | attachments in `prompt.submit` | KEEP |
| Composer | Prompt submit (single + expanded editor) | sends `prompt.submit` | KEEP |
| Composer | Prompt ghost / suggestions | sends `prompt.suggest`; consumes `prompt.suggestion.current` | KEEP |
| Composer | Vim mode, multiline, image paste | local; submit carries attachments | KEEP (local) |
| Composer | Submission mode toggle (follow-up/steering), thinking mode | `prompt.submit.submissionMode`, settings | KEEP |
| Overlays | Slash menu (commands/skills/agents/models) | consumes inventories; sends commands | KEEP |
| Overlays | Settings (local + shared), model/style pickers | `settings.get/update`; `settings.current` | KEEP |
| Overlays | Usage/credits | `usage.get`; `usage.current` | KEEP |
| Overlays | Resume / session picker | `session.list/resume` | KEEP |
| Overlays | File `@` picker | attachments | KEEP (local) |
| Overlays | Login modal | `auth.prompt`, `auth.input` | KEEP |
| Overlays | Jobs / subagents | `task.*`, `childAgent.*` | KEEP |
| Overlays | Tangent history | `tangent.*` | DEFER |
| Overlays | Session tree | tree events | KEEP |
| Overlays | Worktree selector | `workspace.*` | KEEP |
| Overlays | **Teams modal** | `team.*` | **DROP** (stays dark) |
| Overlays | Loop inventory | `loop.inventory.current` | DEFER |
| Overlays | Doctor | `doctor.current` | KEEP |
| Navigation | Leader mode, detail/inspector drill-down, tangent mode | local + drill events | KEEP |
| Sidebar | Inspector drawer (context gauge, routing, tools, diagnostics) | `run.metrics.current`, route events, etc. | KEEP |
| Sidebar | Task detail / background subagent panels | `task.*`, `childAgent.*` | KEEP |
| Status | Footer/header chrome, run lifecycle, runtime diagnostics | turn/run events, `host.watchdog` | KEEP |
| Status | Header lease/owner chrome | `controlLease.current` | **DROP** (stays dark) |
| Surfaces | User question / form responses | `provider.question.requested`; `provider.question.answer` | KEEP |
| Surfaces | Offline notices | `offline_entered/exited` | KEEP |
| Theming | Built-in themes (dracula-ish), density/chrome/noise, cursor | local | KEEP (local) |

---

## 6. Protocol surface appendix — the acceptance contract

The exhaustive wire surface the new host must implement. Source:
`~/dev/trevor/packages/protocol/src/jsonl.ts` + `schema/server-events.json` +
`schema/fixtures/*.json` (one golden fixture per event).

### 6.1 ClientCommands (TUI → host) — ~41 command variants (canonical Rust enum; protocol union groups some)

`session.start/list/resume`, `session.tree.switch` · `controlLease.get/acquire/release` *(DROP)* ·
`prompt.submit`, `prompt.suggest` · `tangent.submit/list/delete/open` *(DEFER)* ·
`auth.input` · `provider.question.answer` · `turn.resume/retry` · `input.cancel` ·
`scheduledRetry.cancel/runNow` · `loop.draft/confirm/list/clear/stop/pause/resume/runNow/delete` *(DEFER)* ·
`ping` · `settings.get/update` · `usage.get`, `session.metrics.get`, `progress.get`,
`host.debugInfo`, `home.modules.get` · `workspace.current/list/create/acquire*/switch`
*(acquire DROP)* · `shell.promote` · `team.message.send`, `team.inbox.post` *(DROP)* ·
`languageServer.list/diagnostics/hover/documentSymbols/codeActions/start/stop/applyWorkspaceEdit` *(DEFER)*.

### 6.2 ServerPayloads (host → TUI) — 119 registered events (grouped)

- **Lifecycle/session:** `session.started/resumed`, `sessions.current`, `session.history.current`, `session.tree.switch.rejected`, `session.metrics.current`, `session.resume.trust`, `contract.current`
- **Turns/runs:** `turns.current`, `run.stopped`, `run.metrics.current`, `agent.state`, `submission.boundary`
- **Assistant:** `assistant.delta`, `assistant.reasoning.delta`, `assistant.completed`
- **Tools:** `tool.started/progress/progress.signal/progress.lessons.current/completed/failed`, `tools.identity.current`
- **Tasks/subagents:** `task.started/completed`, `childAgent.started/input/worktree/completed`, `subagents.inventory.current`, `verification.verdict`, `skill.attached`, `skillFork.started/completed`
- **Routing:** `route.classifying/resolved/outcome/provider_unavailable/provider_retry`, `route.retry_scheduled/started/cancelled`, `route.takeover.*`, `route.helper.*`, `route.boundedChild.*`
- **Provider:** `provider.unavailable/approval.requested/approval.resolved/question.requested/question.resolved/stream.event/reachability.current`, `provider.local_admission.queued/reserved/released/refused`
- **Steering/context:** `steering.applied`, `hard_steering.applied`, `context.compaction.started/completed/failed`, `context.compacted`, `prompt.view`
- **Hooks/extensions:** `hook.started/context_added/input_rewritten/completed/blocked/failed`, `extension.lifecycle`, `process.lifecycle`, `internal_lifecycle.observation/recorded/blocked`
- **Settings/workspace:** `settings.current`, `workspace.current/list/create.result/acquire.result/switch.started/completed/result`
- **Loops/tangents:** `loop.inventory.current`, `loop.iteration.started`, `tangent.started/delta/completed/error/deleted/current/history.current`
- **Auth/usage/home/diag:** `auth.prompt/info`, `usage.current`, `home.modules.current`, `prompt.suggestion.current`, `host.debugInfo.current`, `host.watchdog`, `doctor.current`, `progress.current`, `pong`
- **Offline/control/teams:** `offline_entered/exited`, `controlLease.current` *(DROP)*, `team.status/member_output` *(DROP)*
- **Errors:** `error`

### 6.3 Wire vocabularies

`SubmissionMode` = steering|follow_up · `DeliveryPolicy` = one_at_a_time|all ·
`RoutingLocalityPreference` = auto|local|remote · `RoutingModelLevel` = lowest|mid|frontier ·
`TangentToolPolicy` = none|read_only · `ControlLeaseStatus` = held|released *(DROP)* ·
status enums: Task, Loop, Turn, Run, TurnRecovery, TangentLifecycle, Team *(DROP)*, BackgroundWork ·
`OfflineNoticeReason/Source`.

### 6.4 Error taxonomy

9 families: `action, cancelled, credentials, lease (DROP), protocol, runtime, retryable, timeout, unknown`.
44 codes (e.g. `PROVIDER_TIMEOUT`, `RUN_CANCELLED`, `ROUTING_CONTEXT_FIT_MISSING`,
`TOOL_EXECUTION_FAILED`, `INVALID_CLIENT_COMMAND`; lease codes `LEASE_*` → DROP).

---

## 7. Suggested rebuild order — vertical slices

Each slice = a few protocol events + host logic + a conformance test, landing green. The
TUI lights up incrementally; nothing else is touched.

| Slice | Goal (TUI visibly does X) | Protocol surface | Host features |
|---|---|---|---|
| **S0 — Transport & handshake** | TUI connects, shows an empty session, heartbeat steady | envelope, `session.start`→`session.started`, `contract.current`, `ping`→`pong`, stdin-EOF shutdown | H-001, H-002, H-003, H-017, H-150 |
| **S1 — One-shot turn** | Type a prompt → streamed assistant reply | `prompt.submit`, `agent.state`, `assistant.delta`, `assistant.completed`, `run.metrics.current` | H-005, H-040–H-044, H-048, H-050/51, H-060, H-063, H-064 |
| **S2 — Tools** | Tool calls render with progress/results | `tool.*`, `tools.identity.current` | H-041, H-100–H-110, H-113 (read/edit/bash/rg/glob/web) |
| **S3 — Persistence & resume** | Quit/reopen restores the session | (replay on `session.resume`) | H-130–H-132, H-136, H-004 |
| **S4 — Settings & read-models** | Settings overlay, context gauge, usage | `settings.*`, `session.metrics.current`, `usage.current`, `progress.current` | H-015, H-031, H-032, H-034, H-164 |
| **S5 — Lifecycle depth** | Cancel, retry, follow-up queue, watchdog, errors | `input.cancel`, `turn.*`, `scheduledRetry.*`, `host.watchdog`, `error` | H-007–H-012, H-027, H-028, H-055, H-058 |
| **S6 — Routing** | Route rows; work-kind model selection | `route.classifying/resolved/outcome` | H-080–H-084, H-087–H-096 |
| **S7 — Auth/login & offline** | `/login`, offline notices | `auth.prompt/info`, `auth.input`, `offline_*` | H-019, H-026, H-093, H-154, H-155 |
| **S8 — Prompt production** | `/agents`, `/skills`, slash commands, doctor | inventories, `doctor.current` | H-016, H-163, H-165–H-168 |
| **S9 — Workspace** | switch/list/create, fingerprints | `workspace.*` (no acquire) | H-020, H-141 |
| **S10+ — Long tail (DEFER)** | tangents, loops, LSP, MCP, hooks, retrieval, bounded-child, takeover, admission | respective events | H-022, H-024/25, H-029, H-030, H-036, H-057, H-112, H-116, H-119, H-138/39, H-160–H-162, H-169 |
| **Tabled** | Routing classification (model-led) | `route.classifying` (model variant) | T-1 ([TABLED.md](./TABLED.md)) |
| **Never (DROP)** | — | `controlLease.*`, `team.*`, `workspace.acquire`, multi-client `clientId` | H-013, H-014, H-021, H-134 |

---

_Last updated: 2026-06-18 (initial inventory). Update Status cells as slices land._

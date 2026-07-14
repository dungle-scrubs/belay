# Tool Phase-Streaming - Implementation Plan

## 0. Hard Dependencies

None. The change is additive at every layer (a new `ToolContext` sink, a new
`tool_update` AgentEvent case, a new `tool.delta` wire event, a new transcript
reducer case). It touches the agent loop (`apps/agent-host/src/agent/loop.ts`)
and the session protocol (`packages/session/src/protocol/`), but adds cases
rather than changing existing ones, so it does not block on any in-flight plan.

## 1. Objective

Give multi-phase tools a **callId-keyed incremental channel** so they can stream
their internal progress phases to the web UI, instead of the current
terminal-only model where a tool call shows a binary spinner and then a single
finished result. <!-- D-003 -->

This restores a capability that existed in `~/dev/tallow` - source recall there
streamed its phases via an `onUpdate(partialResult)` callback passed to
`execute` - but was lost migrating the tools into Trevor, whose tool layer is
terminal-only (`Tool.execute` returns one `Effect<string>`).

## 2. Background - why this is a BUILD, not an extend <!-- D-003 -->

A full host -> wire -> web trace confirmed tool output is terminal at all three
layers:

- **Host:** `Tool.execute(args, ctx): Effect<string, ToolError>`
  (`apps/agent-host/src/tools/types.ts:51`). `ToolContext`
  (`types.ts:12-20`) carries only `runId/callId/cwd/workspaceRoot` - no emitter.
  The agent loop turns a `tool_call` into exactly `tool_start` + `tool_end`
  (`agent/loop.ts:85-96`).
- **Wire:** `turn.ts` publishes `tool.started` then `tool.completed`
  (`packages/session/src/protocol/events.ts:1338-1355`). There is no
  `tool.delta`/`tool.update`.
- **Web:** the reducer assigns `tool.result` exactly once
  (`apps/web/src/transcript.ts:1069-1077`); `ToolMessage` has a single
  `result?: string` and no phases field; status is binary (`!done` -> running,
  `apps/web/src/components/chat/tool-status.ts:26-38`).

Assistant **text** does have a real incremental channel
(`ModelEvent.text` -> `DeltaBuffer` -> `assistant.delta` ->
`openSegment(runId).text +=`), but it is **runId-keyed with no callId** and
accumulates into the assistant text segment, so it is a template to copy, not a
channel to reuse. The new path must be addressable by `callId`. <!-- D-003 -->

## 3. Architecture

### 3.1 The phase-update contract <!-- D-001 --> <!-- D-002 -->

A tool emits phases through an **optional `onUpdate` sink on `ToolContext`**
(D-001). It stays a side channel: `executeTool` keeps returning
`Effect<string>`, so the terminal-result contract and its choke point
(`apps/agent-host/src/tools/registry.ts:31`) are untouched.

```ts
// apps/agent-host/src/tools/types.ts
interface ToolUpdate {
  readonly phase: string;                    // e.g. "static", "fetch-pages", "frames"
  readonly status: "attempting" | "ok" | "skipped" | "failed" | "falling_back";
  readonly index?: number;                   // bounded per-item loop position
  readonly total?: number;                   // loop size, when known
  readonly backend?: string;                 // ladder rung / provider id
  readonly detail?: string;                  // short, sanitized (no secrets/URLs)
}

interface ToolContext {
  readonly runId: string;
  readonly callId: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly onUpdate?: (update: ToolUpdate) => void;   // NEW - optional sink
}
```

A tool opts in:

```ts
ctx.onUpdate?.({ phase: "static", status: "attempting", backend: "static" });
// ...
ctx.onUpdate?.({ phase: "static", status: "blocked", backend: "static" });
ctx.onUpdate?.({ phase: "jina", status: "attempting", backend: "jina" });
```

The **typed phase delta** (D-002) is the single shape designed to fit all five
multi-phase tools; the terminal result still arrives via `tool.completed`.

### 3.2 The shared phase vocabulary <!-- D-006 -->

A survey found the five multi-phase tools reduce to three composable shapes, all
expressible with the `ToolUpdate` above:

| Shape | Tools | Phase encoding |
|-------|-------|----------------|
| Named-backend ladder (rung tried only if prior unusable) | `web_fetch` (static->jina->firecrawl), `source_recall` (provider chain) | `backend` + `status: attempting\|ok\|falling_back\|failed` |
| Discover -> fetch -> persist | `docs` (root->pages->normalize->save), `archive` (download->parse->process) | `phase` name per stage |
| Bounded per-item loop | `docs` fetch-pages, `video_inspect` frames, `archive` entries | `phase` + `index`/`total` + per-item `status: ok\|skipped\|failed` |

`web_search`, `mcp`, and `doctor` are single-phase and would use only the
degenerate case (one `attempting` -> one `ok`), so they are out of scope here.

### 3.3 Transport path (the new callId-keyed channel)

```
tool body        ctx.onUpdate?.(update)                       [host, per tool]
  -> executeTool  forwards sink                               registry.ts:81-120
  -> loop         emits AgentEvent {type:"tool_update",callId,update}   loop.ts:85-96
  -> turn.ts      publishes events.toolUpdate({runId,callId,update})    turn.ts:388-427
  -> wire         "tool.delta" event (wireEvent codec + decode)  protocol/{events,wire}.ts
  -> web reducer  case "tool.delta": toolByCall.get(callId).phases.push(update)  transcript.ts:~1069
  -> renderer     ToolMessage.phases drives a live phase list  tool-message.tsx
```

No `DeltaBuffer` coalescing initially (D-008) - phases are low-frequency, unlike
text deltas. If a high-frequency emitter (e.g. `docs` per-page loop) later floods
the wire, add a per-`callId` buffer then.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `executeTool` must keep returning `Effect<string>` (D-001) | The sink is a side channel threaded through `ToolContext`, never a `Stream` return; the terminal path is unchanged. |
| Updates must be addressable to a specific tool row (D-003) | Every wire/loop/reducer hop carries `callId`; the runId-keyed `assistant.delta` path cannot be reused. |
| Additive wire event | Old clients ignore unknown `tool.delta`; `tool.completed` remains the source of the final result. |
| No secrets in phase detail | `detail` is sanitized like the existing redacted attempt logs (host never logs URL query/keys). |

### Boundaries

- **`ToolContext.onUpdate`** is the one seam tools depend on; they never touch the
  wire or the loop.
- **`WebFetchProvider`** (P1) is the provider boundary, modeled on the existing
  `SourceRecallProvider` (`apps/agent-host/src/tools/source-recall/contract.ts`).
  Tools depend on the port + normalized outcome, never on a backend's raw
  endpoints. New target files (`web-fetch/contract.ts`, `web-fetch/registry.ts`,
  `web-fetch/adapters/*.ts`, `web-fetch/scraper-fetch.ts`) get module-level
  comments stating what each owns.

### Observability

This is transport/runtime work, so observability is part of the feature:

- Each emitted `ToolUpdate` is a structured, sanitized event (phase, status,
  backend, index/total) - already the shape the redacted attempt log wants.
- The renderer's live phase list is the user-visible inspection surface: the
  ladder/loop is legible as it runs, not just at completion.
- A dropped/mis-keyed update must never crash a turn: the reducer no-ops when
  `toolByCall.get(callId)` is absent, and `onUpdate?.` is optional-call.

---

## Phases

### Phase 1 (P0): Streaming foundation, proven with web_fetch <!-- D-005 -->

**Goal:** an end-to-end callId-keyed `tool.delta` channel, with `web_fetch`
emitting its ladder phases visibly in the UI.

**Gate from previous:** none (entry phase).

#### M1: `ToolContext.onUpdate` sink + `ToolUpdate` type

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `ToolContext` (`tools/types.ts:12-20`), `simpleTool`
     (`tools/shared.ts:114`), `executeTool` (`tools/registry.ts:81-120`).
  2. RED: a tool whose body calls `ctx.onUpdate?.(u)` has those updates captured
     by a sink `executeTool` installs; the terminal string is unchanged.
  3. GREEN: add `ToolUpdate` + optional `onUpdate` to `ToolContext`; thread `ctx`
     through `simpleTool`; `executeTool` installs/forwards the sink.
  4. RED: a tool that never calls `onUpdate`, and a context with no sink wired,
     both behave exactly as today (no-op safe).
  5. GREEN: optional-call semantics.
  6. REFACTOR: define `ToolUpdate` in one shared module; add module comment.

#### M2: `tool_update` AgentEvent + loop relay

- **Dependencies:** M1
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `AgentEvent` union + emit sites (`agent/loop.ts:85-96`,
     `995`, `1014`, `1089`).
  2. RED: when a running tool calls `onUpdate`, the loop yields
     `{type:"tool_update", callId, update}` between `tool_start` and `tool_end`.
  3. GREEN: add the union case; connect the `executeTool` sink to a per-call
     emit; ensure ordering (start before updates before end).
  4. RED: `tool_update` carries the correct `callId` when multiple tools run in
     one segment.
  5. GREEN.
  6. REFACTOR: keep the emit plumbing next to the existing tool lifecycle emits.

#### M3: `tool.delta` wire event + `turn.ts` mapping

- **Dependencies:** M2
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `events.toolUpdate` factory + `wireEvent` codec
     (`protocol/events.ts:1338-1355`, `protocol/wire.ts`), `turn.ts` handle
     dispatch (`turn.ts:388-427`).
  2. RED: `turn.ts` maps a `tool_update` AgentEvent to a
     `events.toolUpdate({runId, callId, update})` publish.
  3. GREEN: add the `toolUpdate` factory, `type: "tool.delta"` (callId-keyed),
     `wireEvent` + decode arm, and the new `turn.ts` arm.
  4. RED: encode -> decode round-trips a `tool.delta` with all `ToolUpdate`
     fields (including optional `index/total/backend/detail`).
  5. GREEN.
  6. REFACTOR: place `toolUpdate` beside `toolStarted`/`toolCompleted`.

#### M4: Web reducer `tool.delta` + `ToolMessage.phases` + status

- **Dependencies:** M3
- **Effort:** M
- **Testing:** test-first (reducer) then test-after (render)
- **Tasks:**
  1. Seams under test: transcript reducer (`transcript.ts:~1069`), `ToolMessage`
     shape (`transcript.ts:63-80`), `toolMessageStatus`
     (`tool-status.ts:26-38`).
  2. RED: `case "tool.delta"` appends the update into
     `toolByCall.get(callId).phases`; an update for an unknown `callId` no-ops.
  3. GREEN: add `phases?: ToolUpdate[]` to `ToolMessage`; add the reducer case.
  4. RED: while `!done` and phases exist, status reflects an in-progress phase
     (distinct from the bare "running" with no phases).
  5. GREEN: extend `toolMessageStatus`.
  6. REFACTOR: mirror the `assistant.delta` accumulation pattern (`+=` analog).

#### M5: `web_fetch` emits phases (vertical-slice proof) + live renderer

- **Dependencies:** M4
- **Effort:** M
- **Testing:** test-first (emission) then test-after (render)
- **Tasks:**
  1. Seams under test: `runWebFetch`/`fetchVia`/`runBackend`
     (`web-fetch/web-fetch.ts:134-214`), `WebFetchResult`
     (`components/chat/web-fetch.tsx`).
  2. RED: `runWebFetch` emits `ctx.onUpdate` at each backend transition -
     `static attempting`, then `blocked`/`thin` -> `falling_back`, `jina
     attempting`, `firecrawl attempting`, terminal `ok`/`failed`.
  3. GREEN: thread `ctx` into `runBackend`; emit typed phases per rung.
  4. RED: the emitted `backend`/`status` sequence matches the attempts ladder.
  5. GREEN.
  6. RED/GREEN (test-after): `WebFetchResult` renders the streaming phases (the
     ladder advancing) instead of a binary spinner; falls back cleanly when a
     result arrives with no phases (older host).
  7. REFACTOR: extract a small `emitPhase(ctx, ...)` helper reused later by other
     tools.

### Gate 1->2

- [ ] All Phase 1 tests pass (host, session, web suites)
- [ ] Manual: a live `web_fetch` shows its static->jina->firecrawl ladder
      advancing in the UI, then the final result
- [ ] `tool.delta` round-trips through the wire codec
- [ ] A host without the change (or a result with no phases) still renders
      correctly (back-compat)

### Phase 2 (P1): web_fetch as provider/registry + scraper adapter <!-- D-007 -->

**Goal:** `web_fetch`'s hardcoded ladder becomes a `WebFetchProvider` port + a
never-failing, config-driven registry (modeled on `source-recall`), with a
`scraper` adapter that calls `~/dev/scraper`'s local service for real rendering +
chrome stripping. Every adapter emits phases via M5's helper.

**Gate from previous:** Gate 1->2 green.

#### M6: `WebFetchProvider` port + normalized outcome

- **Dependencies:** M5
- **Effort:** M
- **Testing:** test-first
- **Tasks:** mirror `source-recall/contract.ts`: define `WebFetchProvider`
  (`fetch(input)`), the normalized outcome (reuse `BackendOutcome`), and a typed
  provider error. RED/GREEN around the port contract; REFACTOR module comments.

#### M7: never-failing config-driven registry

- **Dependencies:** M6
- **Effort:** M
- **Testing:** test-first
- **Tasks:** mirror `source-recall/registry.ts`: config-ordered adapters
  (priority, enabled), `attemptChain` fallback on unusable (not just transport),
  `mode` -> explicit-provider selection, key-absence -> `enabled:false`. RED: the
  registry never throws (missing/disabled/unreachable -> structured result).
  GREEN/REFACTOR.

#### M8: migrate static/jina/firecrawl to adapters

- **Dependencies:** M7
- **Effort:** M
- **Testing:** test-first
- **Tasks:** move `runStatic`/`runJina`/`runFirecrawlBackend` behind the port as
  adapters, each emitting phases. RED: behavior parity with the existing ladder
  tests (`web-fetch.test.ts`). GREEN/REFACTOR.

#### M9: `scraper` adapter (`~/dev/scraper` local service)

- **Dependencies:** M8
- **Effort:** M
- **Testing:** test-first
- **Tasks:** `scraper-fetch.ts` calls the local scraper HTTP/CLI contract
  (`{markdown, source, bot_detected, error, elapsed_ms}`), mapping
  `bot_detected -> blocked`, `error -> failed`, else `ok`. Config-gated; absent
  service -> `enabled:false` (never a crash). RED/GREEN/REFACTOR + phase
  emission (`scraper attempting`/`rendering`).

### Gate 2->3

- [ ] Existing `web_fetch` behavior parity (all `web-fetch/*.test.ts` green)
- [ ] Registry never throws on any misconfiguration
- [ ] `scraper` adapter usable when the service is up; degrades to `unavailable`
      when down
- [ ] Each adapter emits phases through the M5 channel

### Phase 3 (P2): source_recall regains phase streaming

**Goal:** `source_recall`'s provider registry emits its phases (provider-chain
position + discover/query/rank), restoring tallow parity.

**Gate from previous:** Gate 2->3 green.

#### M10: source-recall provider phases + registry forwarding

- **Dependencies:** M4 (channel), independent of P1/P2 web_fetch work
- **Effort:** M
- **Testing:** test-first
- **Tasks:** the registry's `attemptChain` (`source-recall/registry.ts:100-189`)
  emits `ToolUpdate`s ("trying provider <id> (k of N)", "falling_back",
  "re-indexing" for refresh). RED/GREEN around emission; REFACTOR onto the shared
  helper.

#### M11: source_recall live renderer

- **Dependencies:** M10
- **Effort:** S
- **Testing:** test-after (rendering)
- **Tasks:** the source_recall renderer shows streamed phases; verify with a
  story/fixture.

### Phase 4 (P3): docs / video_inspect / archive adopt the primitive

**Goal:** the remaining three multi-phase tools stream phases through the shared
channel.

**Gate from previous:** Gate 2->3 green (channel proven); P4 milestones are
independent of each other.

#### M12: `docs` phases (discover -> fetch k/N -> normalize -> persist)

- **Dependencies:** M4
- **Effort:** M
- **Testing:** test-first
- **Tasks:** emit at `resolveCandidates`/`fetchPages`/`saveCorpus`
  (`docs/build-actions.ts:69-169`), including per-page `index/total`. First
  candidate for coalescing if the loop is chatty (see D-008). RED/GREEN/REFACTOR.

#### M13: `video_inspect` phases (check -> probe -> frame k/N)

- **Dependencies:** M4
- **Effort:** S
- **Testing:** test-first
- **Tasks:** emit at binary-check/probe/frame-loop
  (`video-inspect/processor.ts:58-159`). RED/GREEN/REFACTOR.

#### M14: `archive` phases (download -> parse -> entry k/N)

- **Dependencies:** M4
- **Effort:** S
- **Testing:** test-first
- **Tasks:** emit at download/parse/per-entry (`archive/tool.ts`,
  `archive/source.ts:90-125`). RED/GREEN/REFACTOR.

### Gate 3->done

- [ ] All five multi-phase tools stream phases through one channel
- [ ] Shared `emitPhase` helper is the single emission path
- [ ] Full suite green; no regression in terminal results

---

## Non-Goals

- **No coalescing/buffering in P0** (D-008); add per-`callId` buffering only if a
  chatty emitter needs it.
- **No retrofit of single-phase tools** (`web_search`, `mcp`, `doctor`) - they
  have no user-meaningful intermediate stages.
- **No change to terminal semantics** - `tool.completed` remains the source of the
  final result; phases are additive.
- **The two web_fetch bug fixes already landed** (blocked/failed content
  suppression at `web-fetch.ts:191`; the `<noscript>` false-positive-block fix in
  `extract.ts`) are prerequisites already satisfied, not tasks in this plan.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Phases mis-keyed to the wrong tool row | high | low | callId carried at every hop; round-trip + multi-tool-in-segment tests (M2/M3) | host |
| `scraper` service coupling/availability | medium | medium | config-gated adapter; absent service -> `enabled:false`, never a crash (M9) | host |
| Chatty emitter floods the wire | medium | low | phases low-frequency by design; add per-callId coalescing if needed (D-008) | host |
| Old web client / no-phase result | low | medium | additive event; renderer falls back to terminal render when `phases` absent (M4/M5) | web |

---

## Escape Hatches

1. **If the callId-keyed wire event proves too heavy:** the terminal path is
   untouched (D-001), so shipping P0 without phases still leaves `web_fetch`
   fully functional - phases degrade to the existing binary spinner.
2. **If `~/dev/scraper` coupling is undesirable:** keep Firecrawl as the rendered
   tier; the `scraper` adapter (M9) is an optional, config-gated provider, not a
   dependency of the registry (M7).
3. **If a per-item loop is too chatty:** collapse it to phase-start + phase-end
   with a final `index/total` summary instead of per-item updates.

---

## Progress Report Accounting

See `progress-report.md`. Buckets: current-cutoff blockers (P0 = M1-M5),
accepted/deferred follow-up (P1-P3 = M6-M14, sequenced behind the gates),
superseded/obsolete (none). Current focus = M1.

```bash
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "65-tool-phase-streaming"
```

---

## Validation Commands

```bash
# host + session unit suites
pnpm exec vitest run apps/agent-host/src/tools/web-fetch/ apps/agent-host/src/agent/ packages/session/src/protocol/
# web reducer + renderer
pnpm exec vitest run apps/web/src/transcript.test.ts apps/web/src/components/chat/
# typecheck
pnpm --filter agent-host exec tsc --noEmit
```

---

## Decisions

Canonical decisions are in `.plans/65-tool-phase-streaming/plan.db`.

- D-001: Emit mechanism = optional `onUpdate` sink on `ToolContext` (side channel, not a `Stream` return).
- D-002: Wire payload = typed phase delta `tool.delta` (not a full envelope); terminal result via `tool.completed`.
- D-003: BUILD a new callId-keyed path; the runId-keyed `assistant.delta` channel is a template, not reusable.
- D-004: Fresh top-level plan 65; no plan in flight, no downstream plans to accommodate.
- D-005: Foundation-first vertical slice - P0 proves the pipe with `web_fetch` before generalizing.
- D-006: One shared phase vocabulary designed against all five multi-phase tools.
- D-007: web_fetch -> `WebFetchProvider` port + never-failing registry (mirrors source-recall); `scraper` adapter.
- D-008: No `DeltaBuffer` coalescing initially; phases are low-frequency.

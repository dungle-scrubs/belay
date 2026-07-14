# Progress Report - Tool Phase-Streaming

**Plan:** `65-tool-phase-streaming`
**Stage:** ready - milestones decomposed, not started
**Current focus:** M1: `ToolContext.onUpdate` sink + `ToolUpdate` type (test-first)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (P0 milestones M1-M5) | 5 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 5 |
| Accepted/deferred follow-up (P1-P3 milestones M6-M14) | 9 |
| Superseded/obsolete | 0 |

Prerequisite already satisfied (NOT a task here): the two `web_fetch` bug fixes -
blocked/failed content suppression (`web-fetch.ts:191`) and the `<noscript>`
false-positive-block fix (`extract.ts`).

## Current Cutoff - Phase 1 (P0): streaming foundation

### M1: `ToolContext.onUpdate` sink + `ToolUpdate` type (test-first)

- [ ] RED: a tool body calling `ctx.onUpdate?.(u)` has updates captured by a sink `executeTool` installs; terminal string unchanged (`tools/types.ts`, `shared.ts:114`, `registry.ts:81-120`).
- [ ] GREEN: add `ToolUpdate` + optional `onUpdate` to `ToolContext`; thread `ctx` through `simpleTool`; install/forward the sink in `executeTool`.
- [ ] RED: a tool that never calls `onUpdate`, and a context with no sink, both behave exactly as today.
- [ ] GREEN: optional-call / no-op-safe semantics.
- [ ] REFACTOR: define `ToolUpdate` in one shared module; add module-level comment.

### M2: `tool_update` AgentEvent + loop relay (test-first)

- [ ] RED: a running tool's `onUpdate` makes the loop yield `{type:"tool_update", callId, update}` between `tool_start` and `tool_end` (`agent/loop.ts:85-96`).
- [ ] GREEN: add the union case; connect the `executeTool` sink to a per-call emit; enforce start->updates->end ordering.
- [ ] RED: correct `callId` when multiple tools run in one segment.
- [ ] GREEN: per-call routing.
- [ ] REFACTOR: keep the emit plumbing beside the existing lifecycle emits (`loop.ts:995,1014,1089`).

### M3: `tool.delta` wire event + `turn.ts` mapping (test-first)

- [ ] RED: `turn.ts` maps `tool_update` to `events.toolUpdate({runId, callId, update})` (`turn.ts:388-427`).
- [ ] GREEN: add the `toolUpdate` factory + `type:"tool.delta"` (callId-keyed) + `wireEvent` codec + decode arm + `turn.ts` arm (`protocol/events.ts:1338-1355`, `protocol/wire.ts`).
- [ ] RED: encode->decode round-trips all `ToolUpdate` fields (incl. optional `index/total/backend/detail`).
- [ ] GREEN: codec completeness.
- [ ] REFACTOR: place `toolUpdate` beside `toolStarted`/`toolCompleted`.

### M4: Web reducer `tool.delta` + `ToolMessage.phases` + status (test-first, then test-after render)

- [ ] RED: `case "tool.delta"` appends into `toolByCall.get(callId).phases`; unknown `callId` no-ops (`transcript.ts:~1069`).
- [ ] GREEN: add `phases?: ToolUpdate[]` to `ToolMessage` (`transcript.ts:63-80`); add the reducer case.
- [ ] RED: while `!done` with phases, `toolMessageStatus` reflects an in-progress phase distinct from bare "running" (`tool-status.ts:26-38`).
- [ ] GREEN: extend `toolMessageStatus`.
- [ ] REFACTOR: mirror the `assistant.delta` accumulation pattern.

### M5: `web_fetch` emits phases + live renderer (test-first emission, test-after render)

- [ ] RED: `runWebFetch` emits `ctx.onUpdate` at each backend transition (static attempting -> blocked/thin/falling_back -> jina -> firecrawl -> terminal) (`web-fetch/web-fetch.ts:134-214`).
- [ ] GREEN: thread `ctx` into `runBackend`; emit typed phases per rung.
- [ ] RED: emitted `backend`/`status` sequence matches the attempts ladder.
- [ ] GREEN: sequence correctness.
- [ ] RED/GREEN (test-after): `WebFetchResult` renders streaming phases; falls back cleanly to terminal render when a result has no phases (`components/chat/web-fetch.tsx`).
- [ ] REFACTOR: extract a shared `emitPhase(ctx, ...)` helper for reuse by later tools.

### Gate 1->2

- [ ] All Phase 1 tests pass (host, session, web)
- [ ] Live `web_fetch` shows its ladder advancing, then the final result
- [ ] `tool.delta` round-trips the wire codec
- [ ] Back-compat: a no-phase result / older host still renders

## Accepted/Deferred Follow-Up (P1-P3 - sequenced behind the gates)

### Phase 2 (P1): web_fetch provider/registry + scraper adapter

- [ ] M6: `WebFetchProvider` port + normalized outcome (mirror `source-recall/contract.ts`). test-first.
- [ ] M7: never-failing config-driven registry (mirror `source-recall/registry.ts`); `mode`->selection, key-absence->`enabled:false`. test-first.
- [ ] M8: migrate static/jina/firecrawl to adapters, each emitting phases; behavior parity with `web-fetch.test.ts`. test-first.
- [ ] M9: `scraper` adapter calling `~/dev/scraper` (map `bot_detected->blocked`, `error->failed`); config-gated, degrades to `unavailable`. test-first.
- [ ] Gate 2->3: parity green; registry never throws; scraper usable/degrades; every adapter emits phases.

### Phase 3 (P2): source_recall regains phase streaming

- [ ] M10: source-recall `attemptChain` emits phases (provider k/N, falling_back, re-indexing) (`source-recall/registry.ts:100-189`). test-first.
- [ ] M11: source_recall live renderer via story/fixture. test-after.

### Phase 4 (P3): docs / video_inspect / archive adopt the primitive

- [ ] M12: `docs` phases (discover -> fetch k/N -> normalize -> persist) (`docs/build-actions.ts:69-169`); coalescing candidate. test-first.
- [ ] M13: `video_inspect` phases (check -> probe -> frame k/N) (`video-inspect/processor.ts:58-159`). test-first.
- [ ] M14: `archive` phases (download -> parse -> entry k/N) (`archive/tool.ts`, `source.ts:90-125`). test-first.
- [ ] Gate 3->done: all five tools stream through one `emitPhase` helper; full suite green.

## Superseded/Obsolete Checklist Debt

None.

# Deepen — Progress Report

Implementation resume state. Normalized accounting (not raw checkbox counts).

**Current focus:** Phase 1 complete. Next: Phase 2 (the web frontend), starting at M9.

## Summary

- Current-cutoff blockers (Phase 1, the host): 8 milestones, **8 complete** (M1-M8). ✅
- Near-term follow-up (Phase 2, the web): 7 milestones, seeded, 0 complete —
  may proceed in parallel; M9 enables host M6 (host M6 landed self-contained per D-012).
- Near-term follow-up (Phase 3, transport/stores): 5 milestones, seeded, 0 complete.
- Superseded/obsolete: none.
- Completed current work: Phase 1 (M1-M8). Full suite green (274 passed / 3 gated skips),
  full typecheck + Biome clean, e2e hermetic lane green.

## Phase 1 — the host (current cutoff) ✅ COMPLETE

- [x] **M1** turn-scheduler lifecycle entry points (`processCompletion`, `noteTurn`); migrated `main.ts` call sites; micro-mutations now private — `agent/turn-scheduler.ts`, `main.ts`
- [x] **M2** `PiAiProviderBase` + `CredentialResolver` (OAuth/static-key strategies, shared `AUTH_PATH`); codex/pi-key reduced to strategy+config — `providers/{codex,pi-key,credentials,pi-ai-base}.ts`
- [x] **M3** `defineTool` primitive (name-bound error envelope + cap) + `walkWorkspace`/`collectWorkspace` search iterator + `prepareEdit` confine-and-replace; collapsed `bash.ts`; ported every tool — `tools/{shared,search,edit-core,glob,grep,edit,multi-edit,bash,read,write,web-search}.ts`
- [x] **M4** `ProviderErrorClassifier` (auth + overflow + `promptTooBig`); `systemPrompt` consumed via `streamPiAiModel` (full thread from `turn.ts` deferred — would change `Provider.stream`, which Gate 1→2 pins) — `providers/{pi-ai,error-classifier}.ts`
- [x] **M5** split `LmStudioClient`/`LmStudioProvider`; env config factory `lmStudioProvider` — `providers/{lmstudio,lmstudio-client,index}.ts`
- [x] **M6** category-driven `BreakdownAccumulator.poolTotal(pool)`; `logUsageBreakdown` takes the accumulator — `usage/breakdown.ts`, `turn.ts`
- [x] **M7** narrowed `commands.ts` inputs (per-command `select` slice); `/skills` builder in `skills.ts` — `commands.ts`, `skills.ts`
- [x] **M8** per-provider env factories (`codexProvider`/`deepseekProvider`/`glmProvider`/`minimaxProvider`/`lmStudioProvider`); `buildProviders()` one line per provider — `providers/{index,codex,pi-key,lmstudio}.ts`

### Gate 1→2

- [x] Phase 1 milestone tests pass (unit + integration) — 172 host tests green
- [x] Host e2e hermetic lane green
- [x] `Provider` interface + `services.ts` Layer composition unchanged (M4 systemPrompt threaded inside the adapter to preserve this)
- [x] `main.ts` no longer orchestrates turn-scheduler internals (drives `noteTurn`/`processCompletion`)

## Phase 2 — the web frontend (near-term follow-up)

- [ ] **M9** centralize token-breakdown metadata + rollup in `@trevor/session`; web + host consume it — `packages/session`, `apps/web/.../panel/breakdown.ts`, `apps/agent-host/.../usage/breakdown.ts` (enables host M6)
- [ ] **M10** one tool-row rendering primitive + shared status config; collapse `ToolShell`/flat-bordered; reuse in `ConcurrentToolRow` — `components/chat/tool-*.tsx`, `concurrent-tools.tsx`, `message.tsx`
- [ ] **M11** `generateToolDiff` view-model; `DiffViewer` display-only — `components/chat/{tool-diff,multi-edit-diff,diff-utils}.tsx`, `assistant-ui/diff-viewer.tsx` (dep: M10)
- [ ] **M12** single-source loop grammar; drop `legendKeywords`; remove unused `registry.ts` — `commands/{loop,loop-parser,registry}.ts`
- [ ] **M13** command parse → presentation view-model; loop/doctor UI stop reaching past parse fields — `commands/*`, `components/chat/loop/*`, `components/chat/doctor/*` (dep: M12)
- [ ] **M14** fold `session/client.ts`; split `useSession` / `useSessionActions` — `session/{client,use-session}.ts`, `App.tsx`
- [ ] **M15** decompose `App.tsx` (PanelControls + composer-state hook + PanelHost) — `App.tsx`, new files (dep: M10, M14)

### Gate 2→3

- [ ] `web` Vitest project green; Storybook builds, no visual regression
- [ ] `@trevor/session` is the single source of breakdown metadata + rollup
- [ ] No component reaches past the parse/session view-models to raw fields
- [ ] `App.tsx` is a composition root

## Phase 3 — transport / session / stores (near-term follow-up)

- [ ] **M16** co-locate the stream-param codec with its owner (`identity.ts`); store consumes it — `packages/session/src/{identity,stream-transport}.ts`, `apps/session-store/src/server.ts`
- [ ] **M17** shared server-kit (cors/json/readBody + startServer) for both stores + test-kit — `apps/{session-store,blob-store}/src/{server,main}.ts`, `packages/test-kit`
- [ ] **M18** `SessionLog.readFrames()`; server becomes dumb fan-out — `apps/session-store/src/{log,server}.ts` (dep: M17)
- [ ] **M19** resolve the transport/Richter false seam (collapse, or deepen richter) — `packages/session/src/{transport,stream-transport,index}.ts`, `packages/richter/src/client.ts`, callers
- [ ] **M20** `events.raw()` for forward-compat tests; route fake-provider — `packages/session/src/protocol.ts`, `apps/agent-host/test/support/fake-provider.ts`

### Gate 3→done

- [ ] Transport-conformance suite green against `session-store` + Richter
- [ ] Both stores' integration lanes green; no behavior change
- [ ] Stream-param wire contract compile-checked on client + store
- [ ] No duplicated HTTP bootstrap across the two stores + test-kit

## Notes

- **Audit exclusion:** `HEX64` in `apps/blob-store/src/store.ts` is intentional
  isolation (zero-dep leaf); do not flag it (D-026).

# Deepen — Progress Report

Implementation resume state. Normalized accounting (not raw checkbox counts).

**Current focus:** Phase 1 ✅ and Phase 2 (the web) ✅ except M15's `<PanelHost>` extraction
(deferred, visually sensitive). Next: Phase 3 (transport/stores), starting at M16.

## Summary

- Current-cutoff blockers (Phase 1, the host): 8 milestones, **8 complete** (M1-M8). ✅
- Phase 2 (the web): 7 milestones — M9-M14 complete; M15 partial (composer hook + PanelControls
  extracted, App 1002→910; the `<PanelHost>` render-tree relocation deferred for visual review).
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

- [x] **M9** centralized the display rollup + semantic colors in `@trevor/session` (`BREAKDOWN_GROUPS` + `rollupBreakdown`); web `panel/breakdown.ts` collapsed to a thin adapter (only resolves the color token → `hsl(var(--…))`); host already consumes the shared schema via M6 `poolTotal`. 5 parity tests — `packages/session/src/breakdown.ts`, `apps/web/.../panel/breakdown.ts`
- [x] **M10** folded `ToolShell`'s border/ToolSection assembly into `ToolCall` (the single tool-row primitive: header + status + collapse + border) and deleted `tool-shell.tsx`; the four renderers now pass one `children` body to `ToolCall` (each owns its own flat-vs-bordered branch where it genuinely differs); one shared `tool-status.ts` (`toolStatusColor(status, pulse)`) replaces the duplicate color maps in `message.tsx` + `concurrent-tools.tsx`. Behavior/stories preserved (faithful body reproduction). 3 status tests + existing tool-output test green
- [x] **M11** added `generateToolDiff(path, old, new, context) → { patch, added, removed }` to `diff-utils.tsx` (the single owner of `createTwoFilesPatch` + `withNewline` + `countChanges`); `tool-diff` + `multi-edit-diff` route through it once (no direct `createTwoFilesPatch`); `DiffViewer` is display-only - its `parsePatch`/`computeDiff` are no longer exported. 3 patch-prep tests — `components/chat/{diff-utils,tool-diff,multi-edit-diff}.tsx`, `assistant-ui/diff-viewer.tsx`
- [x] **M12** `loop.ts` now owns the grammar AND its derived lookups via `loopGrammar()` (runner-alias map, legend, control-verb set); `loop-parser.ts` consumes the factory instead of rebinding the `LOOP_*` constants. Dropped `legendKeywords` from `LOOP_FAMILY` + `CommandFamilyDescriptor` (the legend now derives from `keywords`). Removed the Storybook-only `registry.ts` (the one story checks `LOOP_FAMILY.names` directly). +1 legend-derivation test — `commands/{loop,loop-parser,command-family}.ts`
- [x] **M13** added `commandPresentation(parse, descriptor) → { chips, rows, errors, ready }` to `command-family.ts`; `LoopBuilder` + `LoopKeywords` are now pure render over the view-model (no re-deriving the used-set or filtering diagnostics), `LoopHelper` builds it once. (`loop-inventory` + the doctor panels consume their own structured read-models, not `CommandParseResult`, so they never reached past parse fields.) 3 view-model tests + stories ported — `commands/command-family.ts`, `components/chat/loop/*`
- [x] **M14** folded the transport binding (backend select + tab identity + connect/publish/ensure) from `session/client.ts` into `use-session.ts` and deleted `client.ts`; split `useSession` (read: events/status/replayed/presence) from `useSessionActions` (write: publish/cancel/command/openInEditor); `App.tsx` consumes the two hooks and imports `ensureSession` from `use-session`. Behavior-preserving (existing send-queue/web tests green) — `session/use-session.ts`, `App.tsx`
- [~] **M15** decompose `App.tsx`: extracted `useComposer` (the composer-state hook: draft + attachments + upload state + refs + file-intake/quote handlers) and `<PanelControls>` (the model/reasoning/show-thinking controls). App is down 1002→910 lines with two real boundaries; typecheck + web tests green. REMAINING: the `<PanelHost>` render-tree relocation (App as a pure composition root) - deferred because it relocates ~430 lines of JSX behind a 30+-prop interface (itself shallow) and is visually sensitive, so it wants Storybook/visual verification rather than a headless move — `App.tsx`, `hooks/use-composer.ts`, `components/panel/panel-controls.tsx`

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

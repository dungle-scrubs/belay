# Deepen Backlog — Trevor V2

> A ranked backlog of **deepening candidates** (shallow modules / leaky abstractions / pass-through
> wrappers / callers reaching past the API) found by repeated whole-repo `deepen` audits. This is an
> AUDIT artifact, not an implementation plan: each candidate is acted on **separately** — pick one,
> run `planner` with it as the brief to redesign, then `observability` to instrument the new boundary.
> Candidates carry a stable `C-NN` id; new passes dedup against the module + symptom and only ADD.

Ranking heuristic: `(callers benefiting) × (clarity of proposed boundary) ÷ (estimated churn)`.

---

## High

### C-01 — packages/session: the `events` / `decode` / `DecodedEvent` protocol triple
- **Area:** packages/session
- **Symptom:** Information leakage (#7), interface heavier than implementation (#2), repeated boilerplate (#5).
- **Evidence:** Every event is spelled THREE times — 42 `events.*` constructors (protocol.ts:276-768), 41 decode arms (protocol-decode.ts:557-826), 41 `DecodedEvent` variants (protocol-decode.ts:345-547). For `assistant.completed` the field list appears 4× (param type, payload spread, union variant, decode arm); emit keys and decode keys are bare string literals with no compiler link.
- **Proposed deeper boundary:** Drive all three faces from one per-event field-descriptor table (name → ordered fields with kind: req-string/opt-string/number/flag/sub-coder); an engine generates the constructor, decode arm, and (via mapped types) the `DecodedEvent` variant. Sub-objects plug in existing `coerce*`/`decode*`. `breakdown.ts`'s `BREAKDOWN_CATEGORIES` is the proven precedent.
- **Payoff:** New event/field = one row, not four edits; emit/decode key drift becomes unrepresentable; ~80 mirrored `...(p.x?{x}:{})`/`optStr(p.x)` sites collapse.
- **Churn:** Two files rewritten internally; public surface (`events.*`, `decodeTrevorEvent`, `DecodedEvent`, `LIFECYCLE_TYPES`) unchanged so the 891-line protocol.test.ts is the regression net. Medium-high risk (protocol spine; per-event quirks must be descriptor attributes). Do decode-side first.

### C-02 — apps/agent-host/src/main.ts: the command-dispatch lane (~lines 1845-2004)
- **Area:** agent-host
- **Symptom:** Temporal/role decomposition (#8), repeated boilerplate (#5), information leakage (#7); the `commands.ts` registry is bypassed.
- **Evidence:** A 24-arm `if (command === "/x") { handler(args).catch(warn(...)); return; }` ladder; 21 arms byte-identical in shape. Command-name knowledge split 3 ways (commands.ts 13 specs, debug-commands.ts 5 specs, main.ts 22 dispatch names) that disagree — `/internet-refresh`, `/catalog-refresh`, `/source-signin*`, `/worktree-*` are dispatched but declared in NO spec (invisible to /help). Defeats the registry promise (commands.ts:9-20).
- **Proposed deeper boundary:** Widen `CommandRegistry` so a command's `run` can be an action (publishes its own events / returns void) via the existing `select(ctx)` pattern; `handleEvent` collapses to decode → gate → `commands.run`. Replay side-effects (/clear, /compact admit) stay as a small spec-keyed pre-dispatch hook.
- **Payoff:** ~160-line ladder → ~10 lines; a command is one entry that auto-surfaces in /help + host.online; three-way name drift → one source of truth.
- **Churn:** main.ts (−160), commands.ts (widen contract + register actions), debug-commands.ts (fold in). High churn, handlers move near-verbatim; registry + tests already exist. **Subsumes C-21.**

### C-03 — apps/agent-host/src/main.ts: workspace-switch handlers (/cd, /clear, /handoff, worktree)
- **Area:** agent-host
- **Symptom:** Repeated boilerplate (#5); `switchToWorkspace` is a thin wrapper its own callers bypass (#1); blocker config (#6).
- **Evidence:** `workspaceSwitchBlocker()` + identical bail-`commandResult` at the top of 5 handlers (main.ts:1178,1280,1340,1390,1449). The canonical switch sequence (ensureSession → spawnReplacementHost → sessionSwitch → clearPending → contextRegistry.reset → retireAfterSessionSwitch) exists as `switchToWorkspace` (1235) but `clearToFreshSession`, `cdToFreshSession`, and the handoff `switchAndRetire` each hand-inline their own copy — duplicated 4 ways.
- **Proposed deeper boundary:** One `guardedWorkspaceSwitch(command, plan)` that runs the blocker+bail, resolves the target, runs the one canonical sequence, emits success; route clear/cd/handoff through the single `switchToWorkspace` body.
- **Payoff:** 5 blocker copies + 4 switch-sequence copies → one each; a new switch command can't forget the blocker or `contextRegistry.reset()`.
- **Churn:** main.ts only; medium-high churn, low risk (sequence already tested via handoff-flow/workspace-switch).

### C-04 — apps/agent-host/src/agent/compaction-controller.ts + the compaction callsites
- **Area:** agent-host
- **Symptom:** Callers reaching past the API (#4), pass-through args (#3), information leakage (#7).
- **Evidence:** Controller exposes raw `lastInput`/`lastWindow`/`lastFold` getters that main.ts re-assembles into `runCompaction`'s arg list by hand in 2 places (main.ts:824-831, 1035-1043); `compactionController.provider(providers[DEFAULT_PROVIDER])` repeated 4× (564, 817, 1027, 2117). The "a fold needs these 4 pieces in this order" invariant lives in the host, not the state owner.
- **Proposed deeper boundary:** `controller.planFold({events, foldId, force})` (or own the `runCompaction` call) packaging window/input/provider/PRODUCER_ID from captured state; `startCompaction`/`forceCompact` differ only by `force` + result handling. Collapse the provider idiom into `controller.providerOrDefault()`.
- **Payoff:** Fold-arg assembly stops duplicating + leaking; the two compaction functions become small wrappers.
- **Churn:** compaction-controller.ts + 2 main.ts callsites; medium churn, low risk (compactor.test.ts + /compact cover both paths).

### C-05 — apps/agent-host/src/providers: default-reasoning-level policy reconstructed per adapter
- **Area:** agent-host
- **Symptom:** Information leakage (#7), repeated boilerplate (#5).
- **Evidence:** The "prefer medium, then high, then off…" ladder is hand-rewritten in codex.ts:33-34, pi-key.ts:81-86, anthropic.ts:33-38, and catalog.ts:174-185 (`defaultReasoningFor`). `PiAiProviderBase` already takes a `pickDefaultReasoning` strategy (pi-ai-base.ts:46,81) but all 4 inline near-identical closures; catalog default and turn default computed twice from the same `getSupportedThinkingLevels`.
- **Proposed deeper boundary:** One `defaultReasoningLevel(levels)` beside `reasoning-policy.ts`; `pickDefaultReasoning` defaults to it and `catalog.entryFor` calls it; adapters pass only a genuinely different preference.
- **Payoff:** Rule lives once — a model's catalog default can't disagree with the level it actually streams at; each adapter drops 4-6 lines.
- **Churn:** 4 files + 1 policy module; low risk (pure, existing tests).

### C-06 — apps/agent-host/src/providers/provider-failure-log.ts: `providerFailureLogFields` pass-through
- **Area:** agent-host
- **Symptom:** Thin wrapper (#1), interface heavier than implementation (#2).
- **Evidence:** provider-failure-log.ts:37-39 is `return buildProviderFailureLogFields(input);`; lines 10-14 re-export 3 types verbatim from failure-record-schema.ts. The only consumer (agent/loop.ts:21,44) imports the wrapper, not the builder. The module's real content is the ring + `summarizeFailures`.
- **Proposed deeper boundary:** Drop the forwarder + type re-exports; import `buildProviderFailureLogFields` from failure-record-schema (or move the builder into this module). Keep this module to the in-memory ring + summary.
- **Payoff:** One fewer hop on the loop's hot path; module surface shrinks to what it owns.
- **Churn:** 2 files (one import line in loop.ts); low risk.

### C-07 — apps/web/src/App.tsx: the model/reasoning resolution block (~lines 372-451)
- **Area:** web
- **Symptom:** Callers reaching past the API (#4), duplicated derivation (#5,#7), orchestration root doing deep-module work.
- **Evidence:** ~80 lines re-derive the active model atop `useModelSelection`, reaching into `selection.catalogBySource`/`reasoningSurface`/`activeLabel` to recompute `activeEntry`/`activeReasoningLevels`/`activeReasoning`/`sendModelRef`/`activeLabel`. The "stored level if still valid else default" rule is written twice (387-389, 440-444). App keeps a SECOND reasoning store (`reasoningMap` keyed by provider) although `@trevor/session` `ModelPreferences.reasoningByModel` + `constrainReasoning` already exist. Legacy-vs-catalog precedence lives in the component.
- **Proposed deeper boundary:** Push the whole active-model/reasoning/levels/label/sendRef resolution into `useModelSelection`/`buildModelSelection`, folding `reasoningMap` into `ModelPreferences.reasoningByModel` — one store, one rule.
- **Payoff:** App.tsx drops ~70 lines, stops reaching into hook internals; duplicated reasoning rule + precedence live once (unit-testable); two reasoning stores → one.
- **Churn:** model-selection.ts, use-model-selection.ts, App.tsx + chooser/panelControls bindings; medium risk (live send path; preserve D-065 legacy fallback).

### C-08 — packages/session: session-store read-model API (`GET /sessions`) missing from the transport seam
- **Area:** packages/session + stores
- **Symptom:** Information leakage (#7), caller reaching past the API (#4).
- **Evidence:** `SessionTransport` owns ensureSession/publishEvent/connectSession but NOT the inventory read; 3 callers hand-roll `fetch(\`${base}/sessions\`)` + re-derive the `{sessions?}` envelope + `Array.isArray` guard: trevor-cli/src/main.ts:26-33, web/src/resume/use-inventory.ts:14-21, agent-host/src/agent/recall/reader.ts:40-49. stream-transport.ts already owns the sibling POST routes.
- **Proposed deeper boundary:** Add `fetchInventory(): Promise<readonly SessionSummary[]>` to `SessionTransport`, implemented in `streamTransport` beside the other routes.
- **Payoff:** 3 callsites collapse to one transport call; inventory envelope owned once; Richter-vs-local stays a pure URL swap for reads too.
- **Churn:** 4 files (additive to the seam); low risk.

### C-09 — packages/session/identity.ts + session-store: the `/sessions/{id}/...` route path vocabulary in 3 layers
- **Area:** packages/session + stores
- **Symptom:** Information leakage (#7).
- **Evidence:** The path grammar (`/sessions`, `/sessions/{id}/events`, `/sessions/{id}/stream`) is spelled independently by server matchers (session-store/src/server.ts:34-35,127,142), client URL builders (stream-transport.ts:43,95,107), and the Vite proxy (web/vite.config.ts:32). The PARAM codec was already centralized (identity.ts:120-152) to stop exactly this drift; the path segments are the un-owned half.
- **Proposed deeper boundary:** A `sessionRoutes` descriptor in `@trevor/session` (path templates + derived `STREAM_PATH`/`EVENTS_PATH` regexes), imported by the store matchers and client builders, mirroring `RESERVED_PORTS` single-ownership.
- **Payoff:** A route rename edits one descriptor; store regexes can't drift from client URLs.
- **Churn:** ~3 files; low-medium risk (regexes must stay byte-equivalent — cf. blob-store anchor bug).

### C-29 — packages/session/breakdown.ts ↔ host usage/breakdown.ts ↔ web transcript.ts: the chars→token heuristic + input-pool sum (DRIFTED)
- **Area:** cross-package (session / agent-host / web)
- **Symptom:** Information leakage (#7) — and the two copies have already diverged (a real bug).
- **Evidence:** `CHARS_PER_TOKEN = 4` + input-pool sum implemented independently host-side (usage/breakdown.ts:36,39,130-142 `poolTotal("input")`) and web-side (transcript.ts:184 re-declares the const, 186-201 `estimatedBreakdownInputTokens` hand-lists categories), plus a bare `Math.round(message.reclaimed / 4)` literal at transcript-row-view.tsx:119. DRIFT: web's estimate ADDS `imagesBase64`; host's `poolTotal`/`sumInput` deliberately EXCLUDE images — same breakdown → different "input tokens." `packages/session/breakdown.ts` owns `BREAKDOWN_CATEGORIES` but exposes no token-estimate/input-total helper.
- **Proposed deeper boundary:** Add `CHARS_PER_TOKEN`/`estimateTokens(chars)`/`inputEstimateTokens(breakdown)` (+ `reclaimedTokens`) to packages/session/breakdown.ts beside the category schema; host + web import them.
- **Payoff:** The 4-chars/token constant + the "which categories are input" rule live once; the image-inclusion question gets ONE answer (fixes the host/web drift).
- **Churn:** 3 files, 0 wire changes; low risk (the drift fix changes one web number — add a test).

### C-30 — packages/session/blob.ts ↔ apps/blob-store/store.ts + server.ts: the blob client/server contract
- **Area:** cross-package (session / blob-store)
- **Symptom:** Information leakage (#7) — hand-synced by explicit policy.
- **Evidence:** `HEX64` duplicated (blob.ts:20, store.ts:26 — comment admits "intentionally duplicated… kept in sync by hand"; server.ts:23 strips anchors to reuse as a matcher). Result shape duplicated: `PutBlobResult` (blob.ts:23-29) vs `StoredBlob` (store.ts:35-40) — same 4 fields, two names. Route vocab spelled both sides (blob.ts:34,44 vs server.ts:23,27,58,75). Dedup 200/201 semantics known server-side, re-derived as client `deduped`.
- **Proposed deeper boundary:** A zero-dep `@trevor/session/blob-contract` leaf (mirroring the `ports`/`node-paths` subpath pattern the blob-store may import) owning `HEX64`, the result type, and `/blobs` path builders; blob-store imports it instead of re-spelling.
- **Payoff:** Hash format + wire result + routes stop being a hand-synced triple; one edit per change.
- **Churn:** 3 files; blob-store's "zero workspace deps" becomes "one leaf-contract dep" (same exception already granted to ports.ts). Low-medium risk.

### C-34 — apps/agent-host/src/agent/loop.ts + turn.ts: `ProviderUnavailable` → flat evidence projection re-derived 4×
- **Area:** agent-host
- **Symptom:** Callers reaching past the API (#4), exposed implementation in signatures (#9).
- **Evidence:** The same `unavailable?.{classification,userAction,evidence?.status,evidence?.code,evidence?.shapeFields,detail}` unpack at loop.ts:48-55, 85-88, 129-131 and turn.ts:275-281, feeding 3 near-identical input interfaces in failure-record-schema.ts (ObservationInput/ProviderFailureLogInput/RecordFailureInput, all carrying provider/model/classification/status/code/shapeFields/detail). The `instanceof ProviderUnavailable ? error : undefined` guard is repeated at loop.ts:40,117 + turn.ts:270,288.
- **Proposed deeper boundary:** One `providerFailureEvidence(error): {classification?,userAction?,status?,code?,shapeFields?,retryAfterMs?,requestId?,detail}` beside the error type (providers/errors.ts); the 3 `*Input` shapes take the evidence object + their few extra fields.
- **Payoff:** Each callsite collapses to `failureLogFields({...evidence(error), attempt, outcome})`; a new evidence field is one edit, not four.
- **Churn:** loop.ts + turn.ts + 1 schema file; medium-low risk (pure projection, covered by failure-record/provider tests).

### C-37 — apps/web SidePanel.tsx `fmtTok` + model-chooser.tsx `contextLabel` vs derive.ts `fmtTokens`/`fmtCtx`
- **Area:** web
- **Symptom:** Repeated formatting (#5), information leakage (#7). The compact token/context-window DISPLAY formatter (distinct from C-29's chars→token heuristic) is reimplemented 3× and diverges.
- **Evidence:** SidePanel.tsx:11-12 local `fmtTok` ≈ a byte-copy of derive.ts:44-46 `fmtTokens` — while the same file already imports `fmtCtx` (SidePanel.tsx:4). model-chooser.tsx:559-568 `contextLabel` is a THIRD copy with divergent output (`"128K"`/uppercase, different M rounding) vs derive.ts:49-60 `fmtCtx` (`"128k"`, `"?"` for zero). derive's pair is the canonical one used by transcript-row-view/compacting-bar/Treemap.
- **Proposed deeper boundary:** Delete SidePanel `fmtTok` (use `fmtTokens`), replace `contextLabel` with `fmtCtx` (add an uppercase option if the chooser truly needs it). derive.ts owns the token/ctx number-formatting vocabulary.
- **Payoff:** One rounding/casing rule for every token/ctx label; panel + chooser can't drift from the transcript meta.
- **Churn:** 2 files; low risk (display strings, covered by stories).

### C-38 — apps/web model-chooser.tsx `ACTION_LABEL` vs source-auth-panel.tsx `ACTION_META`
- **Area:** web
- **Symptom:** Repeated derivation (#5/#7) — already drifting.
- **Evidence:** Both map every `SourceAction` (owned by session/model-source.ts:38, which ships no label projection): model-chooser.tsx:60-66 `ACTION_LABEL` and source-auth-panel.tsx:57-63 `ACTION_META`. They DISAGREE: `refresh` → "Refresh catalog" vs "Refresh".
- **Proposed deeper boundary:** One `sourceActionMeta(action): {label, icon}` (shared chooser const, or in session if the label belongs to the contract); both consumers read it.
- **Payoff:** One name per source action; resolves the visible "Refresh catalog"/"Refresh" inconsistency structurally.
- **Churn:** 2-3 files; low risk.

### C-43 — apps/agent-host/src/agent/recall/engine.ts: the recall result envelope
- **Area:** agent-host
- **Symptom:** Exposed implementation (#9), information leakage (#7), pass-through arg-reshaping (#3).
- **Evidence:** The engine-level diagnostic literal `{ sessionId: "", kind, detail }` (the empty-sessionId "not tied to a session" encoding) is hand-written at 6 sites in engine.ts (129,139,203-206,221-225,238-242,278-283) + reader.ts:124. Activity counters exist in two shapes the engine maps between: `empty()` takes `{sessions,folds,records}` (engine.ts:100) and re-expands to the 5-field `RecallActivity` (108-114), while the success path builds `searchedSessions/Folds/Records` (212-218); the 3-field literal is passed at 4 callsites. `RecallStatus` precedence `diagnostics.length>0 ? "partial" : base` duplicated 3× (172,188,252).
- **Proposed deeper boundary:** A result-builder seam: `engineDiagnostic(kind, detail)` (owns `sessionId:""`), one `RecallActivity` accumulator (no `searched`→`searchedX` remap), and `resolveStatus(base, diagnostics)`/`empty(...)` closing over the running activity.
- **Payoff:** 7 diagnostic literals → named calls; dual activity vocab → one; 3 partial-fallbacks → one; reader stops knowing the `sessionId:""` convention.
- **Churn:** mostly engine.ts + 1 reader literal; low risk (recall tests cover it).

### C-44 — apps/agent-host/src/context: init-agents.ts + claude-migration.ts duplicated ignored-dir workspace walk
- **Area:** agent-host
- **Symptom:** Exposed implementation (#9), configuration sprawl (#6).
- **Evidence:** `IGNORE_DIRS`/`IGNORED_DIRS` (same 7 entries) byte-identical in init-agents.ts:6-14 and claude-migration.ts:6-14; `shouldIgnoreDir` (init-agents.ts:43-46, claude-migration.ts:30-33) and recursive `walk` (init-agents.ts:48-68, claude-migration.ts:35-55) are near-verbatim copies.
- **Proposed deeper boundary:** One context workspace walker `walkContextTree(root)` (or `findFiles(root, accept)`) owning the single `CONTEXT_IGNORED_DIRS` + prune/sort; both consumers apply only their basename filters.
- **Payoff:** The ignore policy + prune-traversal live once; adding an ignored dir is one line; the two modules shrink to their real domain logic.
- **Churn:** 2 modules + 1 helper; low risk (both have synthetic-tree tests).

### C-48 — apps/agent-host/src/agent/loop.ts: the budget→gate pair + its live-fact bag
- **Area:** agent-host
- **Symptom:** Large option-bag threaded twice (#3/#6), temporal decomposition with thin interfaces (#8), repeated assembly (#5).
- **Evidence:** `currentBudget()` (loop.ts:486-499) packs 11 live facts into `deriveTurnBudget`; `TurnTerminationGate.decide({...})` is then built TWICE (loop.ts:619-628 step gate, 778-788 protocol-anomaly gate), each re-reading the same 7 mutables (lastInputTokens, lastContextWindow, contextBudgetFraction, repeatedToolName, repeatedToolRounds, budget.effectiveMaxSteps, budget.reason). `evaluateTurnTermination` (turn-policy.ts:190) already bundles the action but is DEAD in production; only the thin `.decide` wrapper is used. The loop is the only place that knows budget + gate must be called as a pair against the same facts.
- **Proposed deeper boundary:** A `TurnGovernor` (or `assessTurn(liveFacts)`) holding the mutable live facts that derives the budget and runs the gate in one call → `{stop, budget}`; the loop updates via `observeUsage`/`observeToolRound` and asks `gate()`.
- **Payoff:** Two decide-callsites collapse to one-liners; the 7-field bag + "build currentBudget then thread its fields into the gate" choreography stops being copy-pasted; the budget+gate coupling is owned in one module.
- **Churn:** 1 module + loop.ts (2 callsites + mutable block); medium risk (central to every turn; well-covered by turn-policy/turn-budget/loop tests).

### C-52 — test suites: hand-spelled `SessionEvent` durable-log envelope (no `storedEvent` helper)
- **Area:** tests (web + agent-host + packages)
- **Symptom:** Information leakage (#7), repeated boilerplate (#5) — a missing shared helper forcing ~12 copies.
- **Evidence:** An identical "stamp a `TrevorEventInput` into `{sessionId,seq,eventId,producerId,createdAt,type,payload}`" function is re-declared in ~12 files (derive.test.ts:33-40, transcript.test.ts:32-42, use-session.test.tsx:13-21, use-modal-state.test.tsx:75, compactor.test.ts:26-37, history-projection.test.ts:36-47 [byte-identical], recall/engine.test.ts, reader.test.ts, corpus.test.ts, breakdown-categories.test.ts, turn-scheduler.test.ts). The production stamp is session-store/log.ts:87-108; the `TrevorEventInput` half is `events.*`. Copies DRIFT on defaults (producerId "host"/"trevor-host"/"trevor-web"; createdAt across 4 dates; seq closure vs param).
- **Proposed deeper boundary:** One `storedEvent(input, over?): SessionEvent` (+ `storedLog(...inputs)` auto-sequencing) in `@trevor/test-kit`, wrapping `events.*` so tests never name the envelope.
- **Payoff:** Hides the durable-log envelope behind one factory; kills ~12 copies + their drift.
- **Churn:** ~12 test files + 1 helper; low risk (test-only, pure).

### C-53 — e2e + store tests: hermetic-server boot lifecycle re-rolled per file
- **Area:** tests (e2e + stores)
- **Symptom:** Repeated boilerplate (#5), reaching into internals (#4) — the harness the test-kit doc promises but never ships.
- **Evidence:** The `startServer(createSessionStore(":memory:"))` / `startServer(createBlobServer(tempDir,25MB))` + `afterAll close()` + `rmSync` block is copied across e2e/{boot,ask-user,golden-path,handoff,blobs}.test.ts; the store/blob app tests bypass `startServer` and re-roll it via raw `listen(0)` + `address() as AddressInfo` (session-store/test/sessions-smoke.test.ts:24-32, transport.test.ts:18-27, blob-store/test/server.test.ts:23-34). test-kit/index.ts:11-20 documents this boot but ships only tempDir/testTransport/waitFor/subscribe.
- **Proposed deeper boundary:** `bootStore()`/`bootBlob()` returning `{url, close}` on `startServer` in `@trevor/test-kit` (or a server-kit test entry for the two store apps that must avoid the package cycle).
- **Payoff:** One boot+teardown contract; removes ~8 hand-rolled lifecycles + the `AddressInfo` cast + the `:memory:`/25MB constants.
- **Churn:** ~8 test files + 1-2 helpers; low-medium risk (package-cycle constraint is the only subtlety, already understood).

---

## Medium

### C-10 — apps/agent-host/src/main.ts: control-prompt model/provider resolution
- **Area:** agent-host
- **Symptom:** Pass-through args (#3), information leakage (#7), thin wrappers over control-model.ts (#1).
- **Evidence:** `controlProvider()`/`lastTurnModel()` then the `{text, provider, model, producerId: CONTROL_PRODUCER_ID}` shape rebuilt in 3 near-identical places: publishControlPrompt (581-587), retryLastPrompt (610-619), handoff targetModel (1298). The CONTROL_PRODUCER_ID user.message shape is load-bearing (turn-scheduler self-echo contract) yet re-derived 3×.
- **Proposed deeper boundary:** One `controlPrompt(text, opts?)` + `controlPromptFor(userMessage)` owning producer id + model/provider resolution + event construction; handoff reads the same resolver; `lastTurnModel`/`controlProvider` become private.
- **Payoff:** The control-prompt shape lives once; 3 callsites stop re-deriving provider+model.
- **Churn:** main.ts (or a small control-prompt.ts); medium churn, low risk.

### C-11 — apps/agent-host/src/main.ts: auto-resume / trailing-turn log scanners
- **Area:** agent-host
- **Symptom:** Temporal decomposition (#8), information leakage of the resume-marker encoding (#7), log threaded through 4 scanners (#3).
- **Evidence:** `lastUserPrompt`/`trailingTurn`/`trailingResumeMarkers`/`maybeAutoResume` (main.ts:549-561,650-749) each walk historyEvents backward reconstructing a slice of trailing-turn state. `trailingResumeMarkers` re-encodes the `RESTART_RESUME_PREFIX` text rule (596) that `continueAfterStop` (598) authored — writer + reader 90 lines apart with a literal "Keep in sync" comment. The pure policy (`resumeAfterStop`/`countRestartResumes`) is in session-lifecycle.ts; the log→inputs projection is stranded in main.ts.
- **Proposed deeper boundary:** A `resume-projection` taking historyEvents (+ selfProducerId) → `ResumeInputs` + trailing turn, paired with the existing pure policy; the continuation-prefix encoding moves next to its reader.
- **Payoff:** `maybeAutoResume` becomes project → decide → act; the writer/reader sync hazard closes by colocation; projection becomes unit-testable.
- **Churn:** extract one module + main.ts callsites; medium churn, low risk (policy half already tested).

### C-12 — apps/agent-host/src/messages.ts: `msg()` bypassed by 2 modules
- **Area:** agent-host
- **Symptom:** Information leakage (#7) of the `error instanceof Error ? .message : String(error)` idiom the module claims to own.
- **Evidence:** `msg()` is used ~20× but the same inline expression is re-spelled at workspace-switch.ts:95 and commands.ts:281.
- **Proposed deeper boundary:** Route both bypasses through `msg` (confirm importability). "Use the deep module you already have," not a new boundary.
- **Payoff:** unknown→message normalization lives in one place as documented.
- **Churn:** 2 lines; trivial risk.

### C-13 — apps/agent-host/src/providers: construction split (index.buildProviders vs catalog.buildSourceProvider)
- **Area:** agent-host
- **Symptom:** Parallel decomposition (#8), information leakage (#7).
- **Evidence:** buildProviders (index.ts:37-59, keyed by browser key) and buildSourceProvider (catalog.ts:277-325, keyed by sourceId) both branch over the same adapter set and consume `PI_KEY_PROVIDERS`; `SOURCES` (catalog.ts:50-98) and `PI_KEY_PROVIDERS` (pi-key.ts:116-141) kept aligned by hand (comment calls out the id coincidence). A new provider touches both tables + both dispatchers.
- **Proposed deeper boundary:** One source registry owning per-source id/type/auth + the `(modelId)=>Provider` factory; `buildProviders` becomes a projection (default per slot), `buildSourceProvider` a lookup.
- **Payoff:** Adding a provider = one row; the adapter-per-source knowledge stops living in two switches that can diverge.
- **Churn:** 3 files + roster/catalog tests; medium risk (live browser-key roster — anchor with the parity test).

### C-14 — apps/agent-host/src/doctor/build.ts: readiness→status + the two probe shapers
- **Area:** agent-host
- **Symptom:** Information leakage (#7), repeated boilerplate (#5).
- **Evidence:** `doctorProviderProbe` (118-130, structured) and `providerStatus` (133-146, plaintext) are the same probe with two renderings; the `ready ? (warm?"warm":"cold") : "unreachable"` ladder appears verbatim at 125 and 137, each re-running readiness() with identical catch-to-unreachable.
- **Proposed deeper boundary:** One `probeProviderStatus(provider): "warm"|"cold"|"unreachable"` (owns readiness run + catch + ladder); both surfaces format its result; the mapping lives next to the `Readiness` type.
- **Payoff:** Status vocabulary + unreachable-on-throw policy live once; the two /doctor surfaces can't drift.
- **Churn:** 1 file; low risk.

### C-15 — apps/agent-host/src/skills.ts: discoverSkills + buildSkillRegistry walk the roots twice
- **Area:** agent-host
- **Symptom:** Information leakage (#7), parallel decomposition (#8).
- **Evidence:** discoverSkillsIn (110-133) and buildSkillRegistry (197-244) both loop roots → sortedVisibleEntries → readFileSync → parseFrontmatter and both encode "first enabled per id across root order," with two caches cleared together (148). `discoverSkills()` is effectively `buildSkillRegistry().filter(available)` computed by a second walk.
- **Proposed deeper boundary:** Make `buildSkillRegistry` the single walk; derive enabled `Skill[]` as a projection of its `available` entries (SkillEntry already supersets Skill). One memo.
- **Payoff:** Precedence/shadow/disabled rules live in one walk; roster + registry can't disagree; removes a second FS scan + cache.
- **Churn:** 1 file + skills/skill-registry tests; medium risk (mechanical projection).

### C-16 — apps/agent-host/src/skills.ts + tools/skills-list.ts: the "description up to Triggers:" format in 3 places
- **Area:** agent-host
- **Symptom:** Information leakage (#7).
- **Evidence:** The `/\btriggers:/i` split is re-implemented at skills.ts:186 (extractTriggers), skills.ts:351 (blurb), tools/skills-list.ts:35 (blurbOf).
- **Proposed deeper boundary:** One `splitDescription(description): {blurb, triggers}` exported from skills.ts; `blurbOf` reads `SkillEntry.triggers` instead of re-splitting.
- **Payoff:** Description format owned once; the registry `triggers` field becomes the single source.
- **Churn:** 2 files; low risk.

### C-17 — apps/web/src/components/chat/tool-status.ts: missing `ToolMessage → ToolStatus` mapping
- **Area:** web
- **Symptom:** Information leakage (#7) — derivation in 3 places, divergent.
- **Evidence:** The status rule is duplicated and NOT identical: App.tsx:199-205 folds `result.startsWith("error:")`; tool-message.tsx:254 does not — so a completed read-only tool returning `error:` shows "done" in the transcript row but "error" in a concurrent batch. The `error:` convention is re-encoded at tool-message.tsx:41. tool-status.ts already owns status→color/icon.
- **Proposed deeper boundary:** Add `toolMessageStatus(tool): ToolStatus` + `isErrorResult(result)` to tool-status.ts; both `toConcurrentTool` and `ToolRenderer` call it.
- **Payoff:** One definition of tool lifecycle state — kills the transcript-vs-batch divergence (a real bug).
- **Churn:** 3 files; low risk (pure, covered by tool-message tests).

### C-18 — apps/web/src/derive.ts: project/workspace-name derivation
- **Area:** web
- **Symptom:** Information leakage (#7).
- **Evidence:** The "workspace basename ignoring `~`" rule is computed two slightly-different ways: App.tsx:223-226 (workspace only) and use-modal-state.ts:33-34 (falls back to cwd). The session-slug fallback (App.tsx:225) is free-floating. The 60-char truncation is duplicated (App.tsx:266, derive.ts:80).
- **Proposed deeper boundary:** Add `projectName(host, target)` + `truncate(text, max)` to derive.ts; the title effect and `resolvedProject` both call it.
- **Payoff:** One definition of the project label — tab title and resume/sidebar scoping can't disagree.
- **Churn:** 3 files; low risk (pure).

### C-19 — packages/session/src/provider-question.ts: normalize vs decode of the same contract
- **Area:** packages/session
- **Symptom:** Information leakage (#7).
- **Evidence:** normalizeChoice/Question/AskUserInput (186-238) and decodeChoice/Question/Contract (456-503) build the same Item/Choice output with duplicated per-field rules: id fallbacks (`choice_${i+1}`/`question_${i+1}`), `deriveAnswerShape`, the same optional spreads; normalizePreview (174) and decodePreview (439) both shape the preview. Only the input vocabulary differs (typed Raw vs unknown).
- **Proposed deeper boundary:** One permissive coercion core; `normalizeAskUserInput` becomes the thin "already-typed Raw" entry funneling into it.
- **Payoff:** A new field is added once; host normalize path and wire decode can't disagree on defaults.
- **Churn:** 1 file; low risk (provider-question.test.ts covers it).

### C-20 — apps/trevor-cli/src/main.ts: `lifecycleIo()`/`hostControlIo()` re-wiring + duplicated `processAlive`
- **Area:** cli
- **Symptom:** Repeated boilerplate (#5), thin pass-through (#1).
- **Evidence:** `lifecycleIo()` is rebuilt per subcommand (main.ts:22-44), each making a fresh `streamTransport(STORE_URL)` + a raw `/sessions` fetch (the C-08 leak); `hostControlIo()` (47-64) re-implements `process.kill(pid,0)` liveness that already exists as `processAlive` in platform.ts:284-294.
- **Proposed deeper boundary:** Build the IO bundles once (module-level/memo); route `fetchSessions` through the new `fetchInventory` (C-08); reuse `nodePlatform.processAlive`.
- **Payoff:** One transport per process; the signal-0 probe stops being written twice; one fewer hand-rolled `/sessions` callsite.
- **Churn:** 1-2 files; low risk. (Pairs with C-08.)

### C-31 — apps/agent-host/src/main.ts:107: session-store port `17424` hardcoded vs `RESERVED_PORTS.store`
- **Area:** cross-package (agent-host / session)
- **Symptom:** Information leakage (#7) — the one literal that shadows the declared single owner.
- **Evidence:** main.ts:107 `?? "http://127.0.0.1:17424"` is the only `17424` literal outside ports.ts:13 (`RESERVED_PORTS.store`), whose header claims "no literal shadows it." Every other surface (trevor-cli, both stores, vite, even the host's blob client at artifacts.ts:20) builds the URL from `RESERVED_PORTS`.
- **Proposed deeper boundary:** Build the host default from `http://127.0.0.1:${RESERVED_PORTS.store}` like everyone else.
- **Payoff:** Port lives in one place again; a port change is one edit.
- **Churn:** 1 line; trivial.
- **NOTE:** Now subsumed by **C-56** (the general `serviceUrl(name, env)` resolver) — fix as part of that, or standalone as the trivial quick win.

### C-32 — packages/server-kit/service.ts (`/health`) ↔ apps/trevor-cli/platform.ts: the health-probe contract
- **Area:** cross-package (server-kit / trevor-cli)
- **Symptom:** Information leakage (#7).
- **Evidence:** `createService` owns `/health` → `{ok:true}` (service.ts:63-64); trevor-cli (never imports server-kit) hand-spells the path + body check (platform.ts:69,75-76,129).
- **Proposed deeper boundary:** Export the health path + `isHealthBody(x)` (or `probeHealth(url)`) from `@trevor/server-kit`; trevor-cli imports it.
- **Payoff:** The endpoint's path + body shape have one owner shared by server and launcher.
- **Churn:** 2 files; trevor-cli gains a server-kit dep. Low risk (borderline Low — tiny contract).

### C-35 — apps/agent-host/src/turn.ts + agent/loop.ts: the offered-tool-def set computed twice
- **Area:** agent-host
- **Symptom:** Duplicated derived knowledge that must stay in sync (#3/#9) — a drift hazard.
- **Evidence:** `(useTools ? TOOL_DEFS : [])` filtered by `toolNames` then concatenated with `delegate.defs` is built independently at turn.ts:71-73 (to SIZE the breakdown overhead) and loop.ts:437-442 (to OFFER to the model). The breakdown overhead is only correct if it reflects exactly the offered set, yet agreement rests on duplicated 3-step logic; no shared helper exists.
- **Proposed deeper boundary:** One `offeredToolDefs(useTools, toolNames, delegate)` (tools/index or agent/loop); both the breakdown sizing and the model offer call it.
- **Payoff:** The filter-then-append rule lives once; breakdown overhead can't silently diverge from what the model sees.
- **Churn:** 2 files; low risk (both paths exercised by loop/turn tests).

### C-39 — apps/web/src/components/chat/transcript-row-view.tsx: tone-coded `Alert` blocks
- **Area:** web
- **Symptom:** Repeated markup/derivation (#5), shallow ladder (#2).
- **Evidence:** `Alert className="border-smui-{X}/25 bg-smui-{X}/[0.04] [&>svg]:text-smui-{X}"` + matching `AlertTitle` repeated 6× (yellow 122,187,217,230; blue 137; purple 166) + the tone ternary at 156; compacting-bar.tsx:59 is a 7th copy. No shared toned-alert primitive (yet the doctor surface already centralizes severity via `DOCTOR_STATUS_META`).
- **Proposed deeper boundary:** A `<ToneAlert tone icon title>` (or a `TONE` class map keyed by smui color); each row passes a tone token, not three class strings.
- **Payoff:** Restyling a tone is one map entry; the transcript can't grow a 5th subtly-different yellow.
- **Churn:** 1-2 files; low-medium risk (story/snapshot diffs).

### C-40 — apps/web/src/App.tsx: `toConcurrentTool` ToolMessage→view projection (App-resident + drilled)
- **Area:** web
- **Symptom:** View projection authored in the orchestration root (#5/#7) + prop-drilled (#3); the status arm diverges. **Extends C-17** (which adds the shared status helper); this is the broader "move the projection out of App" seam.
- **Evidence:** App.tsx:196-214 `toConcurrentTool` derives status (with the `result.startsWith("error:")` arm that ToolRenderer at tool-message.tsx:254 lacks → batch shows red, row shows "done"), bundles `toolSummary`+`onOpenPath`, and is threaded App→PanelHost(:59)→VirtualTranscript(:23)→transcript-row-view.
- **Proposed deeper boundary:** Move the `ToolMessage → ConcurrentTool` projection beside `readOnlyToolBatches`/the transcript model, sharing one `toolMessageStatus` (C-17) so the two status rules can't diverge; App stops drilling a 4-hop function prop.
- **Payoff:** One status rule regardless of renderer; removes a drilled callback; projection sits with its data.
- **Churn:** 3-4 files; medium risk (touches live status — corrects a real inconsistency). Do with C-17.

### C-45 — apps/agent-host/src/context/rules.ts + registry.ts: `RuleCollector` re-walked per file-touch and per turn
- **Area:** agent-host
- **Symptom:** Temporal decomposition / hot-path rework (#8), exposed lifecycle (#9).
- **Evidence:** `ContextRegistry` builds `new RuleCollector(cwd)` twice — in `noteFileAccess` (registry.ts:81, fires on every read/edit/write tool call) and in `report` (registry.ts:90, every turn). Each construction runs `collectTrevorRuleSources` → a full recursive `collectMarkdownFiles` walk + frontmatter parse (rules.ts:241-257,416), result discarded each time. So `.trevor/rules` is re-walked on every file touch.
- **Proposed deeper boundary:** Registry owns one cached `RuleCollector` keyed by cwd (invalidated on `reset()`/cwd change); `noteFileAccess` queries parsed rules instead of re-walking. Keep the "re-read each turn survives compaction" intent for the eager AGENTS.md path only.
- **Payoff:** Rules parsed once per session/turn, not once per file op; the read/edit hot path stops doing FS traversal; one owner of the rule lifecycle.
- **Churn:** registry.ts (cached field + invalidation); medium risk (preserve compaction-survival semantics; invalidate on /clear).

### C-49 — apps/agent-host/src/turn.ts: turn-preamble overhead assembly duplicates the provider's
- **Area:** agent-host
- **Symptom:** Repeated assembly / exposed seam (#5/#9). Distinct from C-35 (the tool-def SET); this is the overhead BYTE-COUNT formula.
- **Evidence:** turn.ts:71-77 seeds `new BreakdownAccumulator(buildSystemPrompt(toolDefs).length + JSON.stringify(toolDefs).length)`; the same `systemPrompt.length + JSON.stringify(tools).length` formula is computed in pi-ai.ts:188-190 (overflow estimate), and `buildSystemPrompt` runs a 3rd time at pi-ai.ts:360 — so it runs twice per turn for accounting the provider already does.
- **Proposed deeper boundary:** `promptOverheadChars(tools)` (or `BreakdownAccumulator.seedOverhead(tools)`) next to buildSystemPrompt/breakdown, called by both the accumulator seed and the provider estimate.
- **Payoff:** turn.ts drops the inline arithmetic + the second buildSystemPrompt; estimator and breakdown seed can't disagree on overhead.
- **Churn:** 3 files; low-medium risk (pure char arithmetic).

### C-50 — apps/agent-host/src/agent/turn-stop-metrics.ts + turn.ts stop handler: the stop sink, split + double-projected
- **Area:** agent-host
- **Symptom:** Shallow single-function module (#1), caller re-projects the same value twice (#5).
- **Evidence:** turn.ts:201-225 handles one `stop` event by building both `recordTurnStopMetric({...})` AND a sibling `log("turn","stop",{...cause,action,steps,inputTokens,contextWindow,pressure})`, hand-unpacking `stop.context?.*` inline; turn-stop-metrics.ts (26 lines) owns only the jsonl append, so "a turn stopped, observe it" is split between module and caller.
- **Proposed deeper boundary:** Make it a `recordTurnStop({runId, provider, stop})` sink that does BOTH the append and the structured log (unpacking `stop.context` once internally).
- **Payoff:** turn.ts stop branch → one call; the context unpack + provider/model fields stop being duplicated; file format + log line move together.
- **Churn:** 2 files + test; low risk.

### C-54 — test suites: in-memory `SessionTransport` test double re-implemented 4×
- **Area:** tests (agent-host + web)
- **Symptom:** Duplicated fake builder that should be one factory (#1/#5), each hand-implementing the transport contract (#4).
- **Evidence:** Four independent hand-rolled `SessionTransport` doubles with recording arrays: delegate.test.ts:28-44, recall/reader.test.ts:54-73 (connectSession replays a stored log via queueMicrotask), use-session.test.tsx:23-45 (drives onStatus), handoff-flow.test.ts (same family). `@trevor/test-kit` ships only the REAL-network `testTransport` (C-26), no in-memory double.
- **Proposed deeper boundary:** A `recordingTransport()` factory in test-kit → `{transport, ensured, publishedBy(id), seed(id, events)}`; connectSession replays seeded logs then onReplayComplete.
- **Payoff:** One owner of the in-memory transport contract; the 4 doubles collapse to seed+assert.
- **Churn:** 4 test files + 1 factory; low risk.

### C-55 — doctor: `DoctorSnapshot`/`DoctorArea` fixtures hand-spelled 5× while doctor-fixtures.ts is stories-only
- **Area:** tests + web
- **Symptom:** Information leakage (#7), duplicated fixture, a stories-only fixture not reused by tests.
- **Evidence:** Full snapshot/area literals hand-built in doctor-panel.test.tsx:13, doctor-result.test.tsx:12, tools/doctor.test.ts, and session/doctor.test.ts:19,82,135 (local snapshot()/area()). Meanwhile web/components/chat/doctor/doctor-fixtures.ts (coreOk, sessionStuck, …) is imported ONLY by the two doctor stories — never by the tests beside it. `@trevor/session` doctor owns the type but exports no fixture builder.
- **Proposed deeper boundary:** `doctorSnapshot(over)` + `doctorArea(id,status,over)` next to the contract (or a shared fixture module); web tests, host tests, protocol test, and stories all point at it.
- **Payoff:** One fixture vocabulary across all doctor consumers; stories + tests can't drift.
- **Churn:** 4-5 files + 1 fixture module; low risk.

### C-56 — service-endpoint URL construction reassembled per callsite (subsumes C-31)
- **Area:** cross-package (session ports / all apps)
- **Symptom:** Configuration sprawl (#6) — a duplicated default + a live drift bug.
- **Evidence:** `RESERVED_PORTS` owns the numbers, but the URL + its env-override name are reassembled at ≥8 non-test sites: trevor-cli platform.ts:26-27,66,69 + main.ts:20 + launch.ts:80, web/vite.config.ts:33, web/src/blob.ts:10-11 (`VITE_BLOB_STORE_URL ?? …blob`), host artifacts.ts:20 (`BLOB_STORE_URL ?? …blob`), and host main.ts:107 hard-coding `"http://127.0.0.1:17424"` instead of `RESERVED_PORTS.store` (the C-31 drift). `LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL` likewise duplicated (source-models.ts:5, lmstudio.ts:54).
- **Proposed deeper boundary:** A `serviceUrl(name, env)` + `SERVICE_ENV` map co-located with `RESERVED_PORTS` returning `env[OVERRIDE] ?? http://127.0.0.1:${RESERVED_PORTS[name]}`. **Subsumes C-31.**
- **Payoff:** Loopback host + port lookup + env-override name named once; eliminates the 17424 drift; one place to change when a service moves; pairs with C-08's Richter URL-swap goal.
- **Churn:** ~8 callsites across 3 apps + web build + 1 resolver; medium risk (web `import.meta.env` vs node `process.env` must both flow through).

### C-58 — `GitStatus` ref-label derivation: host `currentGit` vs web `gitLine`
- **Area:** cross-package (session / agent-host / web)
- **Symptom:** Exposed implementation in signatures (#9), cross-boundary derivation (#7). The shared `GitStatus` exposes raw `branch` + `detached`; both sides reconstruct the `detached <sha>` ref label.
- **Evidence:** main.ts:931 `status.branch ?? (status.detached ? \`detached ${status.detached}\` : undefined)`; WorkspaceIdentity.tsx:24-43 `gitLine()` builds `ref: \`detached ${git.detached}\``; type at protocol.ts:184-192; commands.ts:38 documents the same "(or detached <sha>)" contract.
- **Proposed deeper boundary:** `gitRefLabel(status: GitStatus): string | null` in `@trevor/session` beside `GitStatus`; both `currentGit` and `gitLine` call it (gitLine keeps its `detached` boolean for styling).
- **Payoff:** The "branch, else detached <sha>" rule lives once next to the type; /doctor, host.online branch, and the web sidebar can't drift.
- **Churn:** 3 files; low risk (pure string).

---

## Low

### C-21 — apps/agent-host/src/main.ts: `commandResult` emission (40 callsites)
- **Area:** agent-host
- **Symptom:** Repeated boilerplate (#5). `emit(events.commandResult({command, text, ok}))` ×40, command name repeated inside a handler that knows it. **Subsumed by C-02** (handlers return `{text, ok}`, dispatcher emits). Track only as the payoff of C-02.

### C-22 — apps/agent-host/src/providers/protocol-anomaly.ts: 5 rules differ only by wording
- **Area:** agent-host
- **Symptom:** Configuration sprawl (#6), information leakage (#7). All 5 entries (36-67) share identical `patterns` + `retryable:true`, varying only the provider-named `reason`.
- **Proposed deeper boundary:** One rule applied to all providers, provider name templated into the reason; the table collapses to the pattern set + a name map.
- **Payoff:** Adding a provider needs no new rule; detection can't diverge per provider.
- **Churn:** 1 file; low risk, low payoff (already small/correct).

### C-23 — apps/agent-host/src/context/sources.ts: speculative source taxonomy (2 of 3 kinds unused)
- **Area:** agent-host
- **Symptom:** Speculative configuration (#6), thin module (#2). `CONTEXT_SOURCE_KINDS` declares agentsMd/claudeMigration/trevorRule but only `trevorRule` is read; the other two kinds are never produced.
- **Proposed deeper boundary:** Fold the live kind + types into rules.ts (sole consumer) or drop the unused kinds; re-introduce the shared taxonomy when a second consumer lands.
- **Payoff:** Removes a one-caller abstraction advertising states nothing produces.
- **Churn:** 2 files; low risk. May be intentional staging — confirm before acting.

### C-24 — apps/web: `useComposer` → PromptInput prop expansion (via PanelHost)
- **Area:** web
- **Symptom:** Pass-through/prop-drilling (#3), configuration sprawl (#6).
- **Evidence:** `useComposer` returns one cohesive `Composer` object (use-composer.ts:35-56); App passes it whole to PanelHost (App.tsx:779), which un-bundles it into 14 individual PromptInput props (PanelHost.tsx:397-414), most threaded un-inspected.
- **Proposed deeper boundary:** PromptInput accepts the `Composer` object directly (+ the 3 App-owned wiring props); the re-spread collapses to `composer={composer}`.
- **Payoff:** Adding/renaming a composer field stops requiring edits in two layers.
- **Churn:** 2 files; low risk (couples PromptInput Storybook to the full Composer shape — why it's Low).

### C-25 — packages/session/src/model-source.ts: `host.sourceAuth` flat-spread vs whole-payload decode asymmetry
- **Area:** packages/session
- **Symptom:** Information leakage / exposed implementation (#7/#9).
- **Evidence:** `events.hostSourceAuth` emits `payload: {...p.state}` (flat, incl. its own sourceId); decode reads `decodeSourceSignIn(p)` over the entire payload and names it `auth` (protocol-decode.ts:817; variant 544). Every sibling event nests under a key; this one inlines, so "payload IS the state" is enforced only by convention.
- **Proposed deeper boundary:** Nest under a `state`/`auth` key on emit so decode reads `p.auth`, matching siblings; fold into the C-01 descriptor.
- **Payoff:** Removes the one-off "payload root == sub-object" special case.
- **Churn:** Tiny code, but a durable wire-format change → needs decode-both-shapes tolerance. Best done with C-01.

### C-26 — packages/test-kit/src/index.ts: `testTransport` thin wrapper
- **Area:** packages/test-kit
- **Symptom:** Thin wrapper (#1). `testTransport(url){ return streamTransport(url); }` adds nothing; `subscribe`/`waitFor` earn their place, this doesn't.
- **Proposed deeper boundary:** Drop it; callers use `streamTransport` directly (or alias on import).
- **Payoff:** One fewer indirection; the harness exports only value-adding helpers.
- **Churn:** Trivial.

### C-27 — apps/blob-store/src/main.ts: bypasses the shared `startServer` lifecycle
- **Area:** stores
- **Symptom:** Configuration sprawl / inconsistency (#6, mild). session-store + all harnesses go through `startServer`; blob-store's main calls raw `.listen(PORT,…)` (main.ts:17-19), re-hand-rolling the banner and forgoing the `RunningServer` close handle.
- **Proposed deeper boundary:** Route blob-store main through `startServer(createBlobServer(...), {port, onListen})` like session-store.
- **Payoff:** One listen/banner path for both stores.
- **Churn:** 1 file; very low risk.

### C-28 — apps/blob-store: `HEAD /blobs/<hash>` is server-only surface with no client
- **Area:** stores
- **Symptom:** Interface heavier than its use (#2, mild). The store + `BlobStore.head` (store.ts:93-102) implement HEAD, but the client SDK (blob.ts) exposes no `headBlob`; only a test exercises it.
- **Proposed deeper boundary:** Add `headBlob` to blob.ts if a metadata probe is wanted, or drop the route + `BlobStore.head` until a caller needs it.
- **Payoff:** The blob store's verb set matches its actual clients.
- **Churn:** 1-2 files; low risk — verify no Richter/out-of-repo consumer first.

### C-33 — apps/agent-host/src/main.ts:327: host hand-rolls relative-time vs session `relativeTime`
- **Area:** cross-package (agent-host / session)
- **Symptom:** Information leakage (#7) of an existing shared helper.
- **Evidence:** main.ts:327 inlines `${Math.round((Date.now()-Date.parse(snap.checkedAt))/1000)}s ago`; `packages/session/time-format.ts:17 relativeTime` is used by 4 web modules but never the host. Also doctor.ts:123 documents `checkedAt` as a "12s ago" label but doctor/build.ts:291 ships raw ISO — the label derivation is unowned/inconsistent.
- **Proposed deeper boundary:** Host imports `relativeTime`; decide once (in session) whether `checkedAt` is ISO or pre-formatted so both surfaces agree.
- **Payoff:** One relative-time formatter across host + web.
- **Churn:** 1-2 lines + a doctor doc/format reconciliation; trivial.

### C-36 — apps/agent-host/src/agent/loop.ts: provider-error → ProviderDiagnostic/incident-reason cluster + `withDiagnostic` field-copy
- **Area:** agent-host
- **Symptom:** Exposed implementation / domain knowledge stranded in the loop (#9).
- **Evidence:** `incidentReasonOf` (loop.ts:97-108), `providerDiagnostic` (110-133), and `withDiagnostic` (135-150 — copies 8 fields to rebuild `ProviderUnavailable` just to attach a diagnostic) read the same evidence surface as C-34 and break if a field is added.
- **Proposed deeper boundary:** Move `incidentReasonOf`/`providerDiagnostic` beside the failure taxonomy (providers/); give `ProviderUnavailable` a `withDiagnostic(d)` method so the loop never re-lists the constructor fields.
- **Payoff:** The loop stops being a second home for provider-failure shape knowledge.
- **Churn:** loop.ts + errors.ts; low risk (single-callsite — the win is locating knowledge, pairs with C-34).

### C-41 — apps/web message.tsx `formatElapsed` vs assistant-ui/tool-fallback.tsx `formatToolDuration`
- **Area:** web
- **Symptom:** Repeated formatting (#5). Two elapsed-ms→string formatters with overlapping ranges + divergent output (message.tsx:48-60 `"5m 29s"`/has hours; tool-fallback.tsx:71-77 `"5.2s"`/`"<1s"`/no hours).
- **Proposed deeper boundary:** One `formatElapsed(ms, {tenths?, hours?})`; each surface passes options.
- **Payoff:** One owner of "how long did this take"; the two surfaces converge on breakpoints.
- **Churn:** 2 files; low risk (surfaces are intentionally somewhat separate — hence Low).

### C-42 — apps/web message-images.tsx & message-attachments.tsx: artifact image-partition filter
- **Area:** web
- **Symptom:** Repeated derivation (#5). `artifacts.filter(a => a.kind === "image")` split independently in two composing components (message-attachments.tsx:20, message-images.tsx:84-85) + a third branch at prompt-input.tsx:111.
- **Proposed deeper boundary:** `partitionArtifacts(artifacts): {images, others}` used by both.
- **Payoff:** The image-vs-other rule named once; MessageAttachments stops re-filtering just to test `.length`.
- **Churn:** 2 files; trivial.

### C-46 — apps/agent-host: scattered `env → number-with-default` parsers (no shared owner)
- **Area:** agent-host
- **Symptom:** Configuration sprawl / scattered env reads (#6).
- **Evidence:** The "parse env to finite number else default" idiom is re-implemented ≥5 ways with divergent edge behavior: loop.ts:159-162 and 173-176 (byte-identical IIFEs), main.ts:382 (`value ? Number(value) : undefined`, no finite-check), turn-preflight.ts:6 (`Number(...) || 16_384`), lmstudio.ts:58 (`Number(...) || Infinity`). `LMSTUDIO_URL` also read independently at lmstudio.ts:54 + source-models.ts:5.
- **Proposed deeper boundary:** One `env.ts` exposing `envNumber(name, default)`/`envFlag(name)` with one empty/NaN policy; the numeric reads call it. (Per-provider model-name env stays decentralized by existing design.)
- **Payoff:** One definition of a valid numeric override; the identical IIFEs + divergent `|| default` reads converge; edge-behavior drift footgun removed.
- **Churn:** ~5 one-line swaps; low risk.

### C-47 — apps/agent-host/src/context/registry.ts: scope-band precedence reconstructed positionally
- **Area:** agent-host
- **Symptom:** Information leakage (#7) — precedence lives implicitly in concatenation order.
- **Evidence:** Band order (user-global < project < trevor-rule < below-cwd < below-cwd-rule) is a comment + type union (agents-md.ts:31-32) but the ordering is reconstructed positionally at registry.ts:103 (`[...eager, ...alwaysRules, ...lazy, ...lazyRules]`); `renderContext` trusts array position. Nothing enforces union order == concat order.
- **Proposed deeper boundary:** A `SCOPE_PRECEDENCE` rank owned next to the `scope` union; registry/renderer sort by it instead of hand-ordering.
- **Payoff:** Reordering/adding a band is one edit; comment-vs-code drift goes away.
- **Churn:** agents-md.ts + registry.ts; low risk, modest payoff (current positional design is correct/commented — hence Low).

### C-51 — apps/agent-host/src/agent/loop.ts: the per-step model-stream assembly built twice
- **Area:** agent-host
- **Symptom:** Repeated assembly (#5/#8).
- **Evidence:** The synthesize step (loop.ts:563-578) and `connectStep` (loop.ts:668-701) both do `withStallTimeout(provider.stream(...), model, streamStallMs).pipe(Stream.filterMap(...accumulate text...))`; only the per-event siphon differs (synthesize drops tool_call/overflow, sums `answer`; connectStep keeps them + usage).
- **Proposed deeper boundary:** A `modelStep(conversation, tools, reasoning, {onText, onUsage})` owning the watchdog + stream construction, parameterized by the siphon.
- **Payoff:** One owner of "how a model step is wrapped + observed"; synthesize stops re-encoding the stall config + text-accumulation idiom.
- **Churn:** loop.ts (2 callsites); low payoff (the siphons diverge meaningfully — shared part may be thin) → Low.

### C-57 — apps/agent-host recall tests: `RecallRecord` fixture hand-spelled 3×
- **Area:** tests (agent-host)
- **Symptom:** Duplicated fixture (#5), information leakage (#7).
- **Evidence:** Near-identical `function rec(seq): RecallRecord` (same range/kind/runId:null/tool:null/foldId:null/timestamp defaults) in recall/search.test.ts:27-40, neighborhood.test.ts:25-38, distill.test.ts:50-62; recall/types.ts owns the type but ships no fixture.
- **Proposed deeper boundary:** `recallRecord(over)` (+ `recallSessionRef(over)`) beside recall/types.ts.
- **Payoff:** The recall-record shape named once; new recall tests stop re-typing six defaults.
- **Churn:** 3 test files + 1 helper; low risk.

### C-59 — apps/web Storybook `Frame` width-wrapper re-declared per file
- **Area:** web (stories)
- **Symptom:** Repeated story boilerplate (#1/#5) — a missing shared fixture.
- **Evidence:** `const Frame = ({children}) => <div className="w-[...] max-w-full">…` re-declared in 6+ story files differing only by width: message.stories.tsx:46-48 (40rem), diff-viewer.stories.tsx:31 (64rem), concurrent-tools.stories.tsx:20 (48rem), tool.stories.tsx:22 (48rem), session-recall.stories.tsx:26-27 (44rem), doctor-panel.stories.tsx:37 (max-w-3xl) + inline copies in message-images.stories.tsx:62,102. No story-helpers module exists.
- **Proposed deeper boundary:** One shared `<Frame width="...">` (or `frame(width)` decorator) the stories import.
- **Payoff:** The transcript-width staging convention lives once; the doctor variant's difference becomes explicit not accidental.
- **Churn:** 7-8 story files + 1 helper; near-zero risk (Storybook-only).

### C-60 — cross-package "unknown → message string" normalization (host `msg` is host-private)
- **Area:** cross-package (agent-host / web / cli)
- **Symptom:** Duplicated trivial logic with no shared home (#1). Distinct from C-12: those are host modules that COULD import `msg`; these are packages that CANNOT.
- **Evidence:** `error instanceof Error ? error.message : String(error)` inline at web/blob.ts:33, web/hooks/use-composer.ts:120,135, trevor-cli/main.ts:146,183; the canonical `msg()` lives only in host messages.ts:9.
- **Proposed deeper boundary:** Lift `msg(error: unknown): string` to a shared util (`@trevor/session` or a small `@trevor/util`); host/web/cli all import it.
- **Payoff:** One unknown→displayable-string definition monorepo-wide.
- **Churn:** ~5 sites across 3 packages + 1 export; low risk — borders on not worth a new dep (hence Low). Fold in with C-12.

---

## Considered and rejected (do not re-add)

lease.ts, turn-scheduler.ts, turn-machine.ts, history-projection.ts/baseline.ts, compaction-planner.ts/compactor.ts (the shallow seam is the *controller*, C-04), provider-questions.ts, session-lifecycle.ts (gap is the projection, C-11), control-model.ts (gap is the host wrappers, C-10), reasoning-levels.ts, services.ts, startup.ts, handoff.ts/handoff-flow.ts, workspace-switch.ts, overflow-recovery.ts, processes.ts buildTool; providers/pi-ai-base.ts/pi-ai.ts + the adapters, failure-taxonomy/evidence/error-classifier, observation-store, tools/* (simpleTool factory), tools/index.ts, doctor/source.ts, doctor/probe-runner.ts, connectivity/*, worktrees/*, git-status.ts, paths.ts, usage/breakdown.ts, system-prompt.ts, tasks.ts; web RowChooserModal, transcript.ts (`toTranscript`/`panelModel`), derive.ts selectors, use-session.ts, question/view-model.ts, scroll.ts/use-scroll-follow.ts, markdown-body.tsx, panel binding props; session breakdown.ts (the precedent), tools/ports/identity constants, doctor/recall/catalog-query/inventory, transport.ts/stream-transport.ts, envelope.ts, server-kit/*; session-store/log.ts, blob-store/store.ts, session-store/server.ts (depth real; only its path strings → C-09), blob-store/transcode.ts, trevor-cli launch.ts/host-registry/project/fs/spinner/platform.ts.

---

## Audit log

- **Pass 1** (5 parallel area audits — agent-host core, agent-host subsystems, web, packages, stores+cli): seeded C-01…C-28.
- **Pass 2** (cross-package leakage + deeper agent-host): added C-29…C-36 (incl. the host/web token-estimate DRIFT C-29 and the 4× ProviderUnavailable projection C-34).
- **Pass 3** (web component depth + recall/context/Effect-DI): added C-37…C-47 (display-formatter drift C-37, source-action label drift C-38, recall envelope C-43, context tree-walk dup C-44, hot-path rule re-walk C-45).
- **Pass 4** (turn-pipeline core + test-infrastructure + completeness critic): added C-48…C-57 (budget/gate pair C-48, the test-fixture family C-52/C-53/C-54/C-55/C-57, general service-URL resolver C-56 subsuming C-31).
- **Pass 5** (final sweep — stories/assistant-ui kit, largest files re-scanned, rarest symptoms): added only C-58…C-60 (1 Medium, 2 Low) and **zero new High** → the High/Medium backlog has CONVERGED. 5-pass cap reached.

### Totals
**60 candidates** (C-01…C-60), one subsumed (C-31 → C-56). Roughly: **High ~17**, **Medium ~22**, **Low ~21**. The High bucket stopped growing at pass 4; pass 5's near-empty result is the convergence signal. Further passes would mostly re-surface recorded items.

### How to act on this backlog
Pick a candidate (start High), then run `planner` with it as the brief to design the redesign, and `observability` to instrument the new boundary. Highest-leverage starting points: **C-01** (protocol triple — biggest single-source win), **C-02** (command-dispatch registry), **C-07** (App model/reasoning), **C-29** (fixes a live host/web token drift), **C-34** (ProviderUnavailable evidence ×4). Several are 1-liners with outsized clarity payoff: **C-12**, **C-31/C-56**, **C-37/C-38** (also fix visible UI drift), **C-17** (fixes a real status bug).

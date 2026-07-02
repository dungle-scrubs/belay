# Deepen - Standing Deepening Backlog

A ranked backlog of shallow-module candidates (Ousterhout deep-modules discipline) accumulated by
`/deepen-plan` audit passes. <!-- D-001 --> Each milestone is ONE candidate: symptom, evidence,
proposed deeper boundary, payoff, churn. This plan records candidates; redesigning one is a separate
`planner` run seeded with its milestone as the brief. Dedup key for future passes: target module +
symptom.

## 0. Hard Dependencies

None. Candidates are independent; each notes its own risk.

## Ranked candidates

Ranking: (callers benefiting x boundary clarity) / churn. <!-- D-002 -->

### High

#### M1: `packages/session` SessionTransport - read/await/identity helpers

- **Symptom:** exposed implementation in signatures + repeated boilerplate + pass-through identity.
- **Evidence:** `connectSession` returns only `{close}`; the replay-gate/timeout/settled/close
  protocol is re-rolled as ~30-line Promise machines in `agent/recall/reader.ts:64-97` and
  `trevor-cli/platform.ts:143-180`; `SessionIdentity` literals hand-built at 6 sites
  (platform.ts:153, host main.ts:1230+1255, web use-session.ts:61, test-kit index.ts:38,
  conformance.ts:20); live-tail reconnect gate re-rolled in web `use-session.ts:218-281` and host
  `main.ts:1244-1275`.
- **Proposed boundary:** `readLog(sessionId, identity, {afterSeq?, timeoutMs?})` +
  `awaitEvent(sessionId, identity, predicate, {timeoutMs})` on SessionTransport (owning
  timer/settled/close); `hostIdentity()`/`viewerIdentity()` builders in identity.ts; optionally
  `connectWithReplayGate` for the two reconnect loops.
- **Payoff:** two Promise machines become one call each; 6 identity literals -> 2 builders; the
  callback+close protocol stops leaking into 4 apps.
- **Churn:** medium (~250-350 LOC; transport impls + richter conformance must stay green).

#### M2: `apps/agent-host/src/processes` child-spawn hygiene primitive

- **Symptom:** repeated boilerplate + information leakage across 4 spawners.
- **Evidence:** identical EPIPE pipe-error guards in mcp/stdio-transport.ts:266, lsp/client.ts:452,
  hooks/runner.ts:126, tool-script/spawn.ts:77; SIGTERM->grace->SIGKILL ladders duplicated at
  stdio-transport doClose, lsp/client terminate+doShutdown, hooks/runner:96, tool-script/spawn:104;
  each hand-wires spawn + minimalChildEnv + stdio pipes.
- **Proposed boundary:** `processes/child-spawn.ts`: `spawnHardenedChild({command, args, cwd,
  extraEnv})` with guards attached + `reap(child, graceMs)` owning the kill ladder; all four
  spawners consume it.
- **Payoff:** the "never crash on EPIPE / never leave a zombie" security invariants live once; new
  child runtimes inherit hygiene by construction.
- **Churn:** medium (small module + 4 mechanical call-site edits; security-sensitive paths, existing
  spawn tests must stay green).

#### M3: `apps/web/src/derive.ts` hostAnnouncement projection

- **Symptom:** information leakage / missing read-model boundary.
- **Evidence:** 9 selectors each independently fold "latest host.online" over the whole event log
  (derive.ts:322-599: providerModelsFrom, sourcesFrom, catalogFrom, defaultProviderFrom,
  vimEnabledFrom, jobsFrom, commandsFrom, worktreesFrom + hostStatus:203); 8 sibling `[events]`
  memos in app.tsx + one in use-modal-state.ts:49.
- **Proposed boundary:** one `hostAnnouncement(events): HostAnnouncement | null` projection; the
  selectors become field reads (or are deleted); App holds one announcement memo.
- **Payoff:** 9 full-log decode passes -> 1; a new host.online field is a struct change, not a new
  scanner + memo + test.
- **Churn:** moderate (new projection + ~9 call sites + folding their unit tests).

#### M4: `apps/agent-host/src/agent` provider-failure sink

- **Symptom:** information leakage + caller reaching past the API + repeated boilerplate.
- **Evidence:** a terminal provider failure fans out to five sinks split across two layers:
  loop-failures.ts owns debug log + observation store; turn.ts:648-694 hand-wires
  providerFailures.record (11 fields), traceWriter.record (9 fields), recordIncident + its own
  providerFailureEvidence spread; turn.ts imports the store singletons directly (turn.ts:16-17).
- **Proposed boundary:** one `recordTerminalProviderFailure(provider, error, {reconnectAttempts,
  traceWriter, at})` in/beside loop-failures.ts projecting evidence once and fanning out to
  ring + trace + incident.
- **Payoff:** turn.ts's ~45-line failure branch collapses to one call; adding/removing a sink
  touches one module.
- **Churn:** low-moderate (2-3 files; preserve record-before-complete ordering).


#### M21: `apps/agent-host/src/tools/web-fetch/url-guard.ts` async SSRF boundary (pass 2)

- **Symptom:** leaky abstraction - the guard exposes a SYNC ResolveHost, forcing every caller to
  re-implement the async->sync DNS bridge.
- **Evidence:** three byte-equivalent `syncResolverFor` copies (static-fetch.ts:142-163,
  archive/source.ts:245-265, web-fetch.ts:378-394); duplicated guardUrl/guardRedirect wrappers with
  a hand-maintained divergence (archive try/catches the resolve, static-fetch does not);
  jina-fetch.ts/firecrawl-fetch.ts `resolveHost` deps carry a single-host closure whose type claims
  general resolution.
- **Proposed boundary:** `assertSafeUrlAsync(raw, asyncResolveHost)` +
  `assertSafeRedirectAsync(hop, seen, asyncResolveHost)` in url-guard doing the one-host
  pre-resolution internally; callers keep only their error mapping; backend deps take the real
  async resolver.
- **Payoff:** ~90 duplicated lines across 4 files; the DNS-safety subtlety cannot drift between
  backends; signatures stop lying.
- **Churn:** medium (url-guard exports + tests; three callers; jina/firecrawl dep types).

#### M22: `apps/web/src` per-tool argument schema owner (pass 2)

- **Symptom:** information leakage + duplicated per-tool dispatch.
- **Evidence:** "which fields does tool X's args carry and which is salient" reconstructed at four
  sites off the shared parseToolArgs: tool-detail/detail-args.ts:23-152 (typed extractors, imported
  only by detail-body), tool-message.tsx:75-305 (same knowledge inline in ~8 render arms),
  derive.ts:156-174 toolSummary, compact-display.ts:261-277 compactToolSummary; the tool->family
  grouping duplicated between detail-body.tsx:43-66 and TOOL_RENDERERS.
- **Proposed boundary:** promote detail-args.ts to a neutral `tool-args.ts` single schema owner
  (typed extractor per tool + declared salient field); all four consumers read it. Scope narrowly
  to the arg schema, not render formatters (rejected in pass 1).
- **Payoff:** transcript row, compact summary, and detail takeover cannot drift on a tool's args;
  new tool args touch one module.
- **Churn:** moderate (~6 render arms + two summary fns re-pointed; all four sites unit-tested).

### Medium

#### M5: `apps/agent-host/src/{mcp,lsp}` framed JSON-RPC child connection

- **Symptom:** two near-identical deep bodies + duplicated error taxonomy (the documented "third
  consumer" trigger has effectively fired - lsp/client already imports mcp framing/envelopes).
- **Evidence:** ~150 lines of parallel machinery each (pending map, settle, terminate/drain,
  awaitExit, send, handleBody id-correlation ladder, stream pumps) - stdio-transport.ts:93-330 vs
  client.ts:168-456; mcp/errors.ts vs lsp/errors.ts near-copies; transport.ts already generic over
  error constructors (decodeRpcError/armRequestTimeout).
- **Proposed boundary:** protocol-neutral `createFramedJsonRpcConnection(child, {errorFor,
  onNotification, onServerRequest, scrubStderr})` layered on M2; mcp keeps env-scrub + mediation,
  lsp keeps doc-sync + diagnostics store; one parameterized error family.
- **Payoff:** the subtle reap/correlation/timeout invariants live once; a third JSON-RPC consumer
  becomes cheap.
- **Churn:** high (two large modules rewritten; dense test suites re-pointed). Sequence after M2.

#### M6: `apps/agent-host/src/agent` ConversationLog (history projection state)

- **Symptom:** information leakage + pass-through arguments.
- **Evidence:** `history`/`historyEvents` bare lets in main.ts:284-285 with admit/recordEvent
  mutators (main.ts:760-773); the pairing invariant lives in a comment; 5 factories thread ~6
  bespoke getter closures (control-prompts, handoff, compaction-commands, host-facts, recall);
  currentLabel() re-iterates the raw log.
- **Proposed boundary:** a `ConversationLog` owning both arrays + `admit`/`record` + read accessors,
  constructed in main.ts, reset in connect(); factories take the object (or a Pick). Keep `emit`
  out (already its own seam). handleEvent edits are field-access renames (D-003-compatible).
- **Payoff:** ~6 getter deps collapse; the buildHistory-pairing invariant co-locates with its state.
- **Churn:** medium (~60-line module + 5 dep-interface edits + wiring).

#### M7: `apps/agent-host/src/doctor` peripheral classification fold

- **Symptom:** parallel decomposition + repeated boilerplate.
- **Evidence:** mcp-status.ts:28-127, lsp-status.ts:45-173, hooks-status.ts implement the same
  unconfigured -> auth-needed -> timeout -> error -> unavailable -> ready precedence ladder +
  readyDetail + debugSummary triple over PeripheralState; only generic bits (plural,
  statusHistogram) are shared.
- **Proposed boundary:** `classifyPeripheral(entries, {isEnabled, precedence table, readyDetail})`
  declarative fold in doctor/; each subsystem supplies its predicate table; one debug-summary
  wrapper in host-facts.
- **Payoff:** new peripherals get a table row; mcp/lsp ladders cannot silently diverge in ordering.
- **Churn:** medium-low (three modules behind unchanged exports; ladders already pinned by tests).

#### M8: `apps/agent-host/src/commands` doctor fact-bag (ctx.doctor)

- **Symptom:** interface heavier than implementation + pass-through + configuration sprawl.
- **Evidence:** CommandContext carries 18 fields (commands.ts:44-72), ~13 doctor-only;
  DoctorInput = Omit<CommandContext,"compact">; buildDoctorCommand.select re-lists 14 fields as an
  identity projection (commands.ts:140-168); DoctorRuntimeFacts mirrors the set (build.ts:53-89);
  one new fact = six edit sites.
- **Proposed boundary:** carry runtime facts as one opaque `ctx.doctor: DoctorRuntimeFacts`;
  select collapses to `({doctor}) => doctor`; CommandContext shrinks to genuinely shared members.
- **Payoff:** 18 -> ~8 context fields; adding a doctor fact touches only host-facts + probe-input.
- **Churn:** medium (mechanical; commands.ts + build.ts + main.ts context assembly).

#### M9: `apps/agent-host/src/tools/lsp-shared.ts` LSP request pipeline

- **Symptom:** repeated boilerplate at callsites.
- **Evidence:** the identical ~20-line load -> acquire -> capability-gate -> open -> request ->
  degraded-guard preamble in lsp-hover.ts:84-104, lsp-document-symbols.ts:104-123,
  lsp-code-actions.ts:168-204 (plus the no-file subset in lsp-workspace-symbols.ts:86-98); five
  describeDegraded checks per tool.
- **Proposed boundary:** `runFileLspRequest(manager, {file, provider, method, params(loaded),
  render(value, loaded)})` in lsp-shared.ts (code-actions gets a pre-request hook); no-file variant
  for workspace-symbols.
- **Payoff:** each tool drops to decode + render; the D-006 bounded-degradation invariant is
  enforced in one place instead of five copies per tool.
- **Churn:** low-medium (one helper + 3-4 tool bodies; degraded rungs already tested).

#### M10: `apps/web/src/hooks` publish(prompt) object signature

- **Symptom:** pass-through decomposition + exposed implementation in signatures.
- **Evidence:** `publish(text, provider, reasoning?, artifacts?, model?, pastes?)` declared in
  use-session.ts:289-296, re-declared in use-send-queue.ts:59-65, decomposed from QueuedPrompt at
  two call sites (117-124, 161-168) then reassembled into an object in createSessionActions.
- **Proposed boundary:** `publish(prompt: UserTurnInput)` (QueuedPrompt's field set) end to end.
- **Payoff:** a new turn field ripples through zero signatures instead of three.
- **Churn:** small-moderate (1 interface, 2 call sites, actions + tests).

#### M11: `apps/agent-host/src/main.ts` programmatic-command dispatch lane

- **Symptom:** repeated boilerplate + information leakage (two overlapping command boundaries).
- **Evidence:** 26 inline `if (command === ...)` arms in the pinned user.command arm
  (main.ts:912-1099), each with identical `.catch(warn("host","x failed"))` plumbing (~32 warn
  sites); 7 commands exist in the registry only as "handled by the live host" placeholder specs
  (commands.ts:191-197, 305-358) while their behavior lives inline; a third group is unregistered
  and invisible to /help.
- **Proposed boundary:** a programmatic-command dispatch map (or an "action" command kind on
  CommandRegistry) so the pinned arm makes ONE dispatch call applying the leader gate + uniform
  error handling; specs reunify with behavior.
- **Payoff:** deletes ~26 arms + ~20 warn sites; new programmatic commands are one registration.
- **Churn:** medium-high; touches the pinned file as delegation from one call site - verify against
  the 22.2 characterization test first.

#### M12: `packages/server-kit` startStore boot helper

- **Symptom:** temporal decomposition + configuration sprawl.
- **Evidence:** session-store/main.ts:1-39 and blob-store/main.ts:1-40 are ~90% identical
  (env->port/host convention, legacy-migration nudge, startServer + banner).
- **Proposed boundary:** `startStore({name, reservedPort, host, build, legacyArtifact, dataLabel})`
  in server-kit; each main.ts becomes ~6 declaration lines.
- **Payoff:** boot choreography + env/banner conventions get one owner; a third store is trivial.
- **Churn:** low (~70 LOC).

#### M13: `packages/test-kit` joinSession + waitForType

- **Symptom:** repeated boilerplate at callsites (test infrastructure).
- **Evidence:** the 4-line ensureSession + subscribe + waitFor(isReplayed) prologue repeated across
  ~9 e2e files (18 ensureSession / 12 subscribe / 11 isReplayed hits); the
  `waitFor(() => viewer.events.some(e => e.type === X))` idiom recurs alongside.
- **Proposed boundary:** `joinSession(store, id, who?)` returning a Subscriber with
  `waitForType(type, opts)`.
- **Payoff:** ~12-18 call sites shed setup lines; the join contract centralizes.
- **Churn:** low (two helpers + mechanical e2e edits).


#### M23: `apps/session-store/src/server.ts` session fan-out hub (pass 2)

- **Symptom:** conjoined maps + temporal orchestration at call sites.
- **Evidence:** parallel `subscribers` + `hosts` Maps with nine free closures (server.ts:57-127);
  the connection handler must run readFrames->send->replayComplete->subscribe then
  addHost+broadcastPresence in order (246-261); the close handler manually keeps both maps in
  lockstep (263-270); OPEN-readyState guard + instanceId dedup live beside the routes.
- **Proposed boundary:** a `SessionHub` owning both maps behind attach(sessionId, socket,
  {host?})/detach/publish/presence; server.ts reduces to HTTP routing + replay + WS wiring.
- **Payoff:** the "subscriber+presence torn down together" invariant lives once and becomes
  unit-testable without a WS harness.
- **Churn:** moderate (~90-line module; server.ts 274 -> ~190 lines; store tests cover e2e).


#### M26: event-provenance predicates (host + packages/session) (pass 3)

- **Symptom:** information leakage - the self/answerable/control/clip producer-id rule is one tiny
  vocabulary reconstructed at ~11 read sites; only turn-scheduler names it (isAnswerablePrompt,
  extracted precisely so the contract could not regress).
- **Evidence:** byte-identical isSelf lambdas in agent/history-projection.ts:72 and
  agent/baseline.ts:45; bare producerId comparisons in compaction-planner.ts:82 and six main.ts
  dispatch arms (912-1162); sub-producer namespace built by string concat in main.ts:115-120 but
  compared raw in session/control-model.ts:86 + agent/start-turn.ts:185; history-projection stays
  in sync with main.ts only via a prose comment (:59); PRODUCER_IDS in packages/session/identity.ts
  already owns the strings.
- **Proposed boundary:** an EventProvenance helper (beside PRODUCER_IDS, or a thin host wrapper)
  owning the sub-producer derivation (self, :control, :clip, :recall) and predicates
  isSelf/isAnswerable/isOwnControl/isClip; read sites call the predicate.
- **Payoff:** ~11 inline comparisons + 2 duplicate lambdas collapse; the comment-only coupling
  disappears; the startsWith-bug class the isAnswerablePrompt doc fears becomes structurally
  impossible.
- **Churn:** medium (~40-line helper + 11 mechanical call sites across 6 host files).

#### M27: cancellable-fiber Exit interpretation (agent-host) (pass 3)

- **Symptom:** repeated boilerplate - the "interrupt = quiet cancel, failure = warn(host,
  Cause.pretty), success = value" fold copied at every Effect->promise bridge.
- **Evidence:** structurally identical blocking bridges in handoff/orchestrator.ts:219-234 and
  agent/compaction-commands.ts:169-177; the same fold in start-turn.ts:255 observer; the
  classification recurs in turn.ts:606/623/645, telemetry/span.ts:43, boot/leadership.ts:166
  (Cause.pretty x7 sites, isInterruptedOnly x7, nearly all paired); the cancel one-liner
  Effect.runFork(Fiber.interrupt(f)) copied at 3 sites.
- **Proposed boundary:** `interpretFiberExit(exit, label)` returning
  {cancelled}|{failed}|{ok,value} and owning the warn shape, plus `interruptFiber(fiber)`; callers
  branch on the tag.
- **Payoff:** one owner for what counts as a clean cancel vs a defect and how the host logs it; the
  log shape cannot drift between handoff/compaction/turn paths.
- **Churn:** small-medium (~25-line helper + ~5 call-site rewrites; scoped away from the recorded
  ActiveRun/forwarder candidates).

### Low

#### M14: `apps/agent-host/src/agent` ActiveRun cell

- **Symptom:** exposed implementation in signatures + temporal decomposition.
- **Evidence:** `runningRunId` + `activeSwitch` lets (main.ts:308, 317) set/cleared together but
  threaded as four get/set closures into start-turn (start-turn.ts:77-83) + a getter into
  run-lifecycle + a direct read in handleEvent's model.switch arm.
- **Proposed boundary:** an `ActiveRun` cell `{runId, switch}|null` with open/clear/current; the
  two fields can never disagree about which run is live.
- **Payoff:** 4 dep fields -> 1; "clear both iff this run" becomes one method.
- **Churn:** low-medium.

#### M15: `apps/agent-host/src/providers/failure-record-schema.ts` evidence composition

- **Symptom:** information leakage (schema re-declared).
- **Evidence:** RecordFailureInput (:205) and ObservationInput (:67) re-list the evidence fields
  instead of composing ProviderFailureEvidence (the pattern ProviderFailureLogInput:150 already
  uses); failureFingerprint's six fields re-spelled at 3 callsites; a second raw evidence shape in
  failure-evidence.ts:18.
- **Proposed boundary:** compose both inputs from ProviderFailureEvidence; derive the fingerprint
  once from the evidence projection.
- **Payoff:** a new evidence field reaches every record/fingerprint automatically.
- **Churn:** low, BUT failureFingerprint is a persisted hash - field set/order must stay
  byte-identical.

#### M16: `apps/web/src/app.tsx` useActiveModel extraction

- **Symptom:** exposed implementation in signatures / missing session-view-model boundary.
- **Evidence:** ~130 lines of model-resolution semantics inline (app.tsx:504-637): fallback chain,
  seededReasoning, modelMeta fallback, then a second post-useModelSelection resolution pass
  (sendModel/activeEntry/activeLabel/activeReasoning/onSelectModel with constrainReasoning).
- **Proposed boundary:** fold into useModelSelection (or a `useActiveModel` beside it) returning one
  `{sendModelRef, activeLabel, activeReasoningLevels, activeReasoning, onSelectModel}` bundle.
- **Payoff:** App moves toward pure wiring; the catalog/legacy reconciliation gets one testable
  owner.
- **Churn:** moderate-large (touches the send path).

#### M17: `packages/session` testing leaf for conformance primitives

- **Symptom:** thin duplicate wrappers root-caused by layering (test-kit depends on session, so
  session's own tests re-roll test-kit primitives).
- **Evidence:** transport-conformance.ts:20-64 re-implements waitFor (byte-identical to
  test-kit/index.ts:232-244), subscriber, and an identity builder.
- **Proposed boundary:** push the zero-dep primitives down into a `@trevor/session/testing` leaf;
  test-kit re-exports. Unifies with M1's identity builders.
- **Payoff:** deletes a duplicated harness; conformance + test-kit cannot drift.
- **Churn:** low-medium (~40 LOC moved + two runners updated).

#### M18: `apps/agent-host/src/agent` compaction planner forwarders

- **Symptom:** thin wrapper + pass-through arguments.
- **Evidence:** runCompaction -> planCompaction (exported, single caller two lines away,
  compactor.ts:49-75) -> CompactionPlanner.plan (namespace forwarding to module-private
  planFromAnalysis/analyzeLog); the 5-arg tuple threaded uninspected through both layers. Also two
  colliding `FoldPlan` interfaces (compaction-planner.ts:40 vs compaction-controller.ts:19).
- **Proposed boundary:** inline the forwarders; flatten CompactionPlanner to two exported functions
  one hop from their single callers; rename one FoldPlan.
- **Payoff:** removes two pass-through layers + dead public surface.
- **Churn:** low (pure inlining).

#### M19: `apps/web/src` shellMessageStatus

- **Symptom:** information leakage (tri-state rule with no owner).
- **Evidence:** verbatim `!done ? "running" : ok === false ? "error" : "done"` at
  compact-display.ts:111 and tool-detail/detail-model.ts:96, plus the inline third copy in
  message.tsx:462; tool-status.ts already owns the tool equivalent.
- **Proposed boundary:** `shellMessageStatus(shell)` beside toolMessageStatus; three sites call it.
- **Payoff:** shell + tool lifecycle rules sit together; future states added once.
- **Churn:** tiny.

#### M20: `apps/web/src` transcript message-kind descriptor registry

- **Symptom:** repeated per-kind switch across the two transcript renderers.
- **Evidence:** transcript-row-view.tsx:189-363 (~14-arm if-ladder) and compact-display.ts:84-185
  (parallel 14-arm switch) independently choose icon/status/quiet-marker per kind (icons literally
  picked twice); TOOL_RENDERERS (tool-message.tsx:313) is the in-repo pattern to follow.
- **Proposed boundary:** a per-kind descriptor registry (icon + status + isQuietMarker +
  primary/secondary derivation) consumed by both renderers; rich JSX bodies stay per-arm.
- **Payoff:** one place to register a kind; compact and full cannot drift.
- **Churn:** moderate-high with real over-abstraction risk - scope strictly to
  icon/status/quiet-flag.


#### M24: `apps/agent-host/src/tools/docs/corpus-store.ts` requireLoadedCorpus (pass 2)

- **Symptom:** callsite boilerplate - the 3-state LoadResult union hand-unwrapped per action.
- **Evidence:** the missing->errorResult / corrupt->corruptResult mapping (with verbatim wording)
  duplicated at query-actions.ts:46-58, 110-116, 212-223 and build-actions.ts:215-224.
- **Proposed boundary:** `requireLoadedCorpus(action, loaded, ref)` returning LoadedCorpus or a
  ready failure envelope; four actions collapse to a guard line.
- **Payoff:** the load-union -> wire-envelope mapping becomes single-owner (~24 lines removed).
- **Churn:** low (one helper + four call sites; action tests cover behavior).

#### M25: `apps/agent-host/src/worktrees/manager.ts` summaryRow builder (pass 2)

- **Symptom:** internal duplication - the 13-field WorktreeSummary built three times.
- **Evidence:** manager.ts:99-161 - baseline row (105-120), missing row (124-139), live row
  (142-157) each re-spell the six git-state-derived field expressions.
- **Proposed boundary:** `summaryRow(identity, role, state | null)` mapping git state (null =>
  missing-row zeros) once; the three sites pass identity + role flags.
- **Payoff:** ~35 lines collapse; the "missing rows read zeroed, not stale" invariant lives once;
  a unit-test seam for row construction without a live repo.
- **Churn:** low (single file; summaries() already tested).

## Considered and rejected (pass 3)

- Truncation-marker spelling drift (TRUNCATION_NOTICE vs 4 local variants): cosmetic, unparsed,
  host-local - domain-drift material, not a depth boundary.
- Duration/relative-time/number formatters: already converged (relativeTime shared; formatElapsed
  single-owner; commas vs k/M deliberately different surfaces).
- Identity/wire vocabulary (PRODUCER_IDS, RUNTIME_KIND, HOST_ROLE, encodeStreamParams): already
  centralized with strong docs.
- Largest not-yet-flagged files (loop.ts 1106, turn.ts 703, docs/discovery.ts 636, hooks/runtime.ts
  576, tasks.ts 533): cohesive single-purpose modules, not shallow.

## Considered and rejected (pass 2)

- recall/admission/residency/loop/serial-run/manifest/telemetry internals (uniformly deep); loop
  runner twin switch arms (D-009 divergence expected); serial-run SerialWorktreeOps double
  interface (deliberate sync->async narrowing seam); manifest core-sections combinator (marginal);
  blob-store get/head readMeta (~12 lines, small+correct); telemetry-file-sink vs provider-trace
  (both delegate to the shared capped-jsonl writer); side-panel vs artifact-panel (only one is
  resizable); command menu/modal/palette (distinct contracts); chat/loop views (thin over a shared
  view-model by design); node-paths (data-driven taxonomy, deep); use-model-selection (logic lives
  in model-selection + session transitions).

## Considered and rejected (pass 1)

Recorded so later passes do not re-litigate:

- turn-budget vs turn-policy split (deliberate D-019); provider adapter *FromConfig factories;
  pi-model lookup; reasoning-policy layers; pi-ai message projection (restructure, not depth);
  ProviderIncidentLog vs ProviderFailureLog (intentionally distinct retention); the three failure
  taxonomies (different surfaces); withStallTimeout residual arg-assembly (~3 lines).
- boundedText/capText/boundText aliases (already single-owner); child-env allowlist (already
  shared); doctor/format + hooks/redact (already centralized); http-transport as second McpTransport
  (different substrate); tool-script host-manager (bespoke protocol, injected seam); simpleTool
  (already deep; the empty-params jsonSchema constant x3 is too small); tools/mcp.ts importing
  cache constants (legitimate ownership).
- vim-store/style-store parameterized-factory merge (depth already in boot/config scaffold; merging
  trades legibility for cleverness); the loadJsonConfig store family (parses genuinely differ);
  collapsing the 14 make* factories (they ARE the 22.x deepening); shell-lane/source-signin/env
  (thin but justified seams); splitting handleEvent (pinned by 22.2 D-003).
- panel-host.tsx (deep data-only render seam, not a god-component); transcript.ts toTranscript (the
  reference deep module); derive.ts formatters (single-owned); use-session write actions (the write
  API boundary; thinness is the point); loopControlCommand dead wrapper (too small; either wire
  app.tsx:718 through it or delete - a simplify note, not depth).
- protocol decode boundary (reference-quality deep module; no consumer re-derivation found);
  server-kit createService (correctly deep); session barrel/subpath exports (deliberate
  browser-safe split); cli services/host-registry (already deep).

## Acting on a candidate

Pick a milestone and run `planner` with it as the brief (redesign), then `observability` on the new
boundary. Check its box in the progress report only when the deepening has shipped.

## Decisions

Canonical decisions in `.plans/deepen/plan.db`.

# Deepen Backlog - Progress Report

> A standing backlog of deepening candidates. A checkbox is "checked" only when that candidate has
> been REDESIGNED (via `planner`) and the deeper boundary landed - not when merely recorded. `deepen`
> passes ADD new candidates here; they do not check existing ones.

> Current focus: Phase 1: High - candidates open; pick one and run `planner` to redesign it.

## Candidates (open)

### Phase 1: High

- [x] C-01: `packages/session/src/inventory-display.ts` - promote project-scoped selection + recency comparator into `@trevor/session`; fixes the sidebar tangent-leak bug.
- [x] C-02: `packages/sdk/src` - `sessionOp`/`blobOp` error-context helpers + operation-labeled `publishEvent`.
- [x] C-03: `apps/web/src/session/use-session.ts` (+ new-session hooks) - single `publishWebEvent` owning the `PRODUCER_IDS.web` stamp.
- [x] C-17: `apps/web/src/composer/image-tokens.ts` + `paste-tokens.ts` - new `positional-tokens.ts` holds one generic `positionalTokenDraft(codec)` engine (renumber/insert/removeAt/removeAdjacent/sync); the two token modules collapse to a `TokenCodec` instance + thin field-adapter wrappers that keep their exact public API (`ImageDraft.refs` / `PasteDraft.pastes`, same fn names), so `draft.ts` + both unit suites stay unchanged and keep pinning correctness. The two ~150-line twins went 309 -> 176 lines; the invariant logic now lives once.
- [x] C-20: `apps/agent-host/src` programmatic-command lane - new `commands/command-replier.ts` `commandReplier(emit)` -> `replyFor(command)` -> `{ ok, fail, result, failed }`, built locally in each command factory from the already-injected `emit` (no deps-signature change). Converted the 4 high-density files (worktrees 13, handoff 5/7, serial-run 7, session-switch 6 = 31 sites): the command name + `command.result` shape + "Failed to <verb>" phrasing now each have one owner. Intentionally NOT converted: `lifecycle.ts` (7 of 10 strings carry pre-existing em-dashes, left byte-for-byte), `main.ts` (its `emitResult`/`runCommand` are already the central relay + carry the menu variant the replier omits), `model-prefs-command.ts` (its `emit` is the wider `() => Promise<void> | void`), and the two 1-site files (`leadership.ts`, `control-prompts.ts`, `handoff` x2 em-dash) where a replier saves nothing.
- [x] C-22: `packages/session/src/fork.ts` - export `FORK_ORIGIN_KEY` + `hasForkOrigin` so `tangent-isolation.ts` stops re-declaring the contract.

### Phase 2: Medium

- [x] C-04: `packages/session/src/transport.ts` - make `readSessionLog`/`awaitSessionEvent` private, unify into internal `collectUntil`.
- [x] C-05: emit-side `PublishInput` splice - `toPublishInput(envelope, producerId)` package helper (foundational for C-03).
- [x] C-06: `apps/agent-host/src/mcp/transport.ts` - relocate protocol-neutral JSON-RPC primitives to `json-rpc/` so LSP no longer depends on MCP.
- [x] C-07: `apps/agent-host/src/agent/loop.ts` + `turn.ts` - bundle switch/rebuildProvider/initialModel into one `SwitchSurface`.
- [x] C-08: `packages/sdk/src/prompt.ts` + `capabilities.ts` - shared `awaitStreamResult` stream settle/teardown primitive.
- [x] C-09: `apps/blob-store/src` + `apps/session-store/src` - one colocated store-identity descriptor per app.
- [x] C-10: `apps/web/src/hooks/use-model-selection.ts` ↔ `use-active-model.ts` - focused fix: dropped the thin `setDefault`/`togglePin` pass-through wrappers + their command round-trip (callers send the host command directly); kept `useModelSelection` as its own unit-tested state hook rather than merging the two.
- [x] C-18: `apps/web/src/components/chat/compact-display.ts` - delete `TOOL_SUMMARY_ARG`, route through `tool-args.ts` `salientToolArg`/`toolSummary` (fixes compact-vs-full drift).
- [ ] C-19: `apps/web/src/composer/*-token-overlay.tsx` + `loop/command-input.tsx` - a shared `MirrorField` primitive + `segmentBySpans` helper.
- [x] C-23: slug rule - route `branchSlug` + docs `slug()` through `packages/session/src/identity.ts` `idSlug`.
- [x] C-24: `apps/agent-host/src/tools/source-recall` - move `MAX_SNIPPET_CHARS` into the shared `contract.ts`.

### Phase 3: Low

- [x] C-11: `apps/agent-host/src/agent/turn.ts` `publishTurn` ↔ `RunAgentOptions` - REJECTED on read. The audit's premise (`toolNames`/`delegate`/`loop`/`seedUsage` are pass-throughs) is false: each is inspected locally in `publishTurn` (`toolNames`/`delegate` -> `offeredToolDefs` at :162, `loop` -> `turnLoopConfig(loop).streamStallMs` at :282, `seedUsage` -> `seedWindow` at :169). No pure pass-through remains after C-07 pulled the one always-together triple (`SwitchSurface`). The proposed `{ loop, seedUsage }` bundle groups a test-only seam (`loop`, never set in production) with a production per-turn carry-forward that don't co-occur, and would force the one production reader to reach through a nested bag - degrading a hot path. Each option maps to a distinct, documented concern; the bag is wide but not shallow.
- [x] C-12: `apps/agent-host/src/doctor/build.ts` - REJECTED on read. The doctor pipeline is already a clean 3-module split by responsibility (`host-facts.ts` reads live singletons -> `build.ts` assembles -> `snapshot.ts` folds the ordered area grid), and subsystems ALREADY own their rollup shaping in their own modules (`mcpPeripheralState`/`lspPeripheralState`/`hooksPeripheralState`/`admissionDoctorSummary`/`residency.summary()`/`telemetryDoctorFacts()`). `DoctorRuntimeFacts` is an honest DTO between those two stages, not a shallow interface. The proposed fragment-merge fails the code: `buildDoctorSnapshot` takes a fixed flat `DoctorProbeInput` with ~10 REQUIRED keys, so merging `Partial<DoctorProbeInput>` fragments loses the compile-time exhaustiveness that today catches a dropped required area (forcing a cast in a health-reporting path). And the payoff is illusory: adding a subsystem still requires editing `probe-input.ts`'s type AND `snapshot.ts`'s explicitly-ordered `areas` array. Most fields in `buildLiveDoctorSnapshot` are genuine transforms (opaque host record -> typed session, catalog -> redacted `catalogSources`, env -> web/build, `?? unconfigured` peripheral fallbacks), not pass-throughs; only ~5 (`admission`/`residency`/`telemetry`/`lspDiagnostics`/`hooksFindings`) spread verbatim, and those are the clearest lines.
- [x] C-13: `packages/session/src/capability-manifest-compact.ts` - import `CHARS_PER_TOKEN` from `breakdown.ts`.
- [x] C-14: `apps/web/src/components/panel/panel-host.tsx` → `virtual-transcript.tsx` - pass transcript handlers as one bundle.
- [x] C-15: `apps/web/src/components/command-menu/use-command-menu.ts` - route keys through the shared `useAutocompleteMenuKeys`.
- [x] C-16: node-side `resolveServiceUrl(name)` - own the `<SVC>_URL` override, close the CLI override gap.
- [x] C-21: `apps/agent-host/src/tools/shared.ts` - lift `clipLine`/`boundedText` host-wide; route ~8 re-implementations through it.
- [x] C-25: `apps/web` cap+ellipsis - collapse `derive.ts` `truncate` / `tool-args.ts` `truncateText` / `foldback.ts` inline copy to one.
- [x] C-26: `apps/agent-host/src/tools/video-inspect/errors.ts` - narrow the 7-class `Data.TaggedError` hierarchy to `VideoCancelledError` + `VideoDegraded`; delete the dead union.

## Summary
- Total candidates: 26
- Redesigned (done): 23
- Open candidates: 1
- Current cutoff blockers: 1
- Rejected on read (premise didn't survive code review): 2 (C-11, C-12)
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Audit provenance
- Pass 1 (2026-07-06): whole-repo audit via 4 area agents (agent-host, web, session, smaller apps/packages). Seeded C-01 .. C-16.
- Pass 2 (2026-07-06): targeted audit of areas pass 1 deprioritized (host recall/worktree/hooks/commands, web composer/doctor/tangent, session fork/recovery + a repo-wide information-leakage sweep). Added C-17 .. C-25 (9 new).
- Pass 3 (2026-07-06): symptom-class sweep (temporal decomposition, exposed-implementation signatures, config sprawl, Effect service/error shallowness) + previously-unaudited blob-store/supervisor/launcher/server-kit/test-kit. Added C-26 (1 new); web+session dimension returned fully converged.
- Pass 4 (2026-07-06): completeness-critic sweep of remaining blind spots (trevor-cli, repo-policy, cross-app type leaks, build/tooling config, duplicated magic constants, Effect adoption, web↔session boundary). Added 0 new - **CONVERGED**. Yield trend 16 → 9 → 1 → 0; stopped early at pass 4 of 5 (pass 5 skipped: it would only re-find recorded items).

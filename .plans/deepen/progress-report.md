# Deepen Backlog - Progress Report

> A standing backlog of deepening candidates. A checkbox is "checked" only when that candidate has
> been REDESIGNED (via `planner`) and the deeper boundary landed - not when merely recorded. `deepen`
> passes ADD new candidates here; they do not check existing ones.

> Current focus: Phase 1: High - candidates open; pick one and run `planner` to redesign it.

## Candidates (open)

### Phase 1: High

- [x] C-01: `packages/session/src/inventory-display.ts` - promote project-scoped selection + recency comparator into `@trevor/session`; fixes the sidebar tangent-leak bug.
- [ ] C-02: `packages/sdk/src` - `sessionOp`/`blobOp` error-context helpers + operation-labeled `publishEvent`.
- [x] C-03: `apps/web/src/session/use-session.ts` (+ new-session hooks) - single `publishWebEvent` owning the `PRODUCER_IDS.web` stamp.
- [ ] C-17: `apps/web/src/composer/image-tokens.ts` + `paste-tokens.ts` (+ `draft.ts`) - one generic `PositionalTokenDraft<Payload>` engine over a `TokenCodec`.
- [ ] C-20: `apps/agent-host/src` programmatic-command lane - a `CommandReplier` collapsing 51 hand-spelled `events.commandResult` sites.
- [x] C-22: `packages/session/src/fork.ts` - export `FORK_ORIGIN_KEY` + `hasForkOrigin` so `tangent-isolation.ts` stops re-declaring the contract.

### Phase 2: Medium

- [x] C-04: `packages/session/src/transport.ts` - make `readSessionLog`/`awaitSessionEvent` private, unify into internal `collectUntil`.
- [x] C-05: emit-side `PublishInput` splice - `toPublishInput(envelope, producerId)` package helper (foundational for C-03).
- [x] C-06: `apps/agent-host/src/mcp/transport.ts` - relocate protocol-neutral JSON-RPC primitives to `json-rpc/` so LSP no longer depends on MCP.
- [x] C-07: `apps/agent-host/src/agent/loop.ts` + `turn.ts` - bundle switch/rebuildProvider/initialModel into one `SwitchSurface`.
- [ ] C-08: `packages/sdk/src/prompt.ts` + `capabilities.ts` - shared `awaitStreamResult` stream settle/teardown primitive.
- [x] C-09: `apps/blob-store/src` + `apps/session-store/src` - one colocated store-identity descriptor per app.
- [ ] C-10: `apps/web/src/hooks/use-model-selection.ts` ↔ `use-active-model.ts` - collapse into one `useModel` hook.
- [x] C-18: `apps/web/src/components/chat/compact-display.ts` - delete `TOOL_SUMMARY_ARG`, route through `tool-args.ts` `salientToolArg`/`toolSummary` (fixes compact-vs-full drift).
- [ ] C-19: `apps/web/src/composer/*-token-overlay.tsx` + `loop/command-input.tsx` - a shared `MirrorField` primitive + `segmentBySpans` helper.
- [x] C-23: slug rule - route `branchSlug` + docs `slug()` through `packages/session/src/identity.ts` `idSlug`.
- [x] C-24: `apps/agent-host/src/tools/source-recall` - move `MAX_SNIPPET_CHARS` into the shared `contract.ts`.

### Phase 3: Low

- [ ] C-11: `apps/agent-host/src/agent/turn.ts` `publishTurn` ↔ `RunAgentOptions` - group always-together knobs into named bundles.
- [ ] C-12: `apps/agent-host/src/doctor/build.ts` - subsystems contribute own doctor fragments instead of 20-field facts threading.
- [x] C-13: `packages/session/src/capability-manifest-compact.ts` - import `CHARS_PER_TOKEN` from `breakdown.ts`.
- [ ] C-14: `apps/web/src/components/panel/panel-host.tsx` → `virtual-transcript.tsx` - pass transcript handlers as one bundle.
- [ ] C-15: `apps/web/src/components/command-menu/use-command-menu.ts` - route keys through the shared `useAutocompleteMenuKeys`.
- [x] C-16: node-side `resolveServiceUrl(name)` - own the `<SVC>_URL` override, close the CLI override gap.
- [x] C-21: `apps/agent-host/src/tools/shared.ts` - lift `clipLine`/`boundedText` host-wide; route ~8 re-implementations through it.
- [x] C-25: `apps/web` cap+ellipsis - collapse `derive.ts` `truncate` / `tool-args.ts` `truncateText` / `foldback.ts` inline copy to one.
- [x] C-26: `apps/agent-host/src/tools/video-inspect/errors.ts` - narrow the 7-class `Data.TaggedError` hierarchy to `VideoCancelledError` + `VideoDegraded`; delete the dead union.

## Summary
- Total candidates: 26
- Redesigned (done): 16
- Open candidates: 10
- Current cutoff blockers: 10
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Audit provenance
- Pass 1 (2026-07-06): whole-repo audit via 4 area agents (agent-host, web, session, smaller apps/packages). Seeded C-01 .. C-16.
- Pass 2 (2026-07-06): targeted audit of areas pass 1 deprioritized (host recall/worktree/hooks/commands, web composer/doctor/tangent, session fork/recovery + a repo-wide information-leakage sweep). Added C-17 .. C-25 (9 new).
- Pass 3 (2026-07-06): symptom-class sweep (temporal decomposition, exposed-implementation signatures, config sprawl, Effect service/error shallowness) + previously-unaudited blob-store/supervisor/launcher/server-kit/test-kit. Added C-26 (1 new); web+session dimension returned fully converged.
- Pass 4 (2026-07-06): completeness-critic sweep of remaining blind spots (trevor-cli, repo-policy, cross-app type leaks, build/tooling config, duplicated magic constants, Effect adoption, web↔session boundary). Added 0 new - **CONVERGED**. Yield trend 16 → 9 → 1 → 0; stopped early at pass 4 of 5 (pass 5 skipped: it would only re-find recorded items).

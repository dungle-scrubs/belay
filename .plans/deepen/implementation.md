# Deepen Backlog - Implementation Plan

A ranked, deduped backlog of **deepening candidates** for the trevor codebase: shallow modules,
leaky abstractions, pass-through wrappers, and information leaks surfaced by the `deepen` audit
(Ousterhout's deep-modules discipline). This is an **audit backlog**, not a feature spec - each
candidate is an independent opportunity. Acting on one is a separate step: pick a candidate, run
`planner` to redesign it, then `observability` to instrument the new boundary.

Candidates are `C-NN` and stable: later `deepen` passes dedup against the module + symptom recorded
here and only ADD genuinely new opportunities.

## 0. Hard Dependencies

- None. This is a standing audit backlog; candidates are independent and each is redesigned on its own.

## Ranking

Ranked by `(callers benefiting) × (clarity of proposed boundary) ÷ (estimated churn)`, in High /
Medium / Low buckets. The codebase is already deeply factored (explicit "Responsible for / Not for"
contracts, pure-core + glue splits, single-owner vocabularies), so the highest-value finds are
**information leaks** where consumers re-derive package-owned rules - not thin wrappers.

---

## Phase 1: High

### C-01: `packages/session/src/inventory-display.ts` - shallow filter primitives; the "sessions view" is re-composed divergently (tangent-leak bug)
- **Symptom:** interface≈implementation (4 one-line filter/sort primitives), information leakage, a consumer that cannot reach the real owner, plus a live divergence bug.
- **Evidence:** exports 4 low-level primitives callers compose themselves (`activeSessions` `:10`, `tangentsOf` `:20`, `archivedSessions` `:30`, `sortInventory` `:40`). The canonical composite `selectSessions` lives in `@trevor/sdk` (`packages/sdk/src/lifecycle.ts:29-37`) which `apps/web` does not depend on, so `apps/web/src/components/panel/session-sidebar.tsx:30` re-implements the active filter as `!s.archived && !s.deleted` - **omitting `!s.tangentOf`**, leaking tangents into top-level nav. The recency comparator `b.updatedAt.localeCompare(a.updatedAt)` is re-spelled in ≥4 places (`inventory-display.ts:45`, `session-sidebar.tsx:32`, `agent-host/src/agent/recall/reader.ts:99`, `sdk/lifecycle.ts:36`).
- **Proposed deeper boundary:** promote the project-scoped selection (today's `selectSessions`) and a canonical recency comparator down into `inventory-display.ts` in `@trevor/session` (which every surface already depends on); expose one view function (e.g. `sessionsForProject(summaries, project, {archived})`) instead of four primitives.
- **Expected payoff:** one owner for "what shows in navigation"; the sidebar tangent-exclusion bug vanishes by construction; `sdk/lifecycle.selectSessions` collapses to a thin re-export; the recency rule stops being copy-pasted.
- **Estimated churn:** ~4 files; low risk - all pure, well-tested functions.

### C-02: `packages/sdk/src` (client/prompt/lifecycle/capabilities) - error-context boilerplate + workflows bypassing `publishEvent`
- **Symptom:** repeated boilerplate at callsites + callers reaching past the API + information leakage.
- **Evidence:** the `{ operation, backend: "session", sessionId, backendUrlClass }` context object is hand-built 17× (`client.ts:104-184`, `prompt.ts:44-189`, `lifecycle.ts:44-68`, `capabilities.ts:44-183`); the `"session"` literal and URL-redaction rule duplicated at each. Four workflows (`submitPrompt` `prompt.ts:50`, `cancelRun` `prompt.ts:68`, `switchModel` `prompt.ts:102`, `publishArchived` `lifecycle.ts:71`) bypass `TrevorClient.publishEvent` (`client.ts:128-134`, which already stamps producer + wraps error) to hit the raw transport just to supply a per-op error label.
- **Proposed deeper boundary:** add bound `sessionOp(operation, sessionId?, run)` / `blobOp(operation, run)` helpers on `TrevorClient` that own the backend literal + redaction; let `publishEvent` take an operation label so the four workflows collapse to `client.publishEvent(sessionId, events.X(input), "prompt")`.
- **Expected payoff:** the redaction rule + "session backend" fact live once; 4 workflows stop duplicating producer-stamp + error-wrap; ~40 lines of context objects disappear.
- **Estimated churn:** SDK-only, ~4-5 files (each with its `.test.ts`); low risk.

### C-03: `apps/web/src/session/use-session.ts` (+ `new-session/use-launch.ts`, `use-supervisor.ts`) - the browser event-publish stamp is re-implemented per site
- **Symptom:** repeated boilerplate + information leakage - "stamp a browser event with `PRODUCER_IDS.web` and publish" re-spread 7× instead of owned once.
- **Evidence:** the `{ producerId: PRODUCER_IDS.web, ...built }` stamp appears at `use-session.ts:134,143,153,207,505`, `use-supervisor.ts:98`, `use-launch.ts:105`. The hook already centralizes it in `publishVia` (`use-session.ts:499-509`), but the four module-level free functions and both new-session hooks re-spread it inline.
- **Proposed deeper boundary:** a single `publishWebEvent(sessionId, built)` (stamp + publish via the shared transport) imported by the free functions and both hooks, so the `PRODUCER_IDS.web` knowledge lives once. Can build on C-05's package-level `toPublishInput`.
- **Expected payoff:** 7 callsites become one-line delegations; a new publish path can't forget the stamp or drift.
- **Estimated churn:** 3 files, additive helper, low risk.

### C-17: `apps/web/src/composer/image-tokens.ts` + `paste-tokens.ts` (+ `draft.ts`) - two near-identical positional-token draft engines
- **Symptom:** whole-module boilerplate + interface≈implementation - `paste-tokens.ts:17-18` admits "This deliberately mirrors `image-tokens.ts`: same insert/remove/sync/renumber semantics."
- **Evidence:** each ~150 lines of 1:1 twins differing only in parser/token-text + payload type: `renumber` (`image-tokens.ts:33`) vs `renumberPastes` (`paste-tokens.ts:43`); `refsIn` (`:45`) vs `pastesIn` (`:55`); `insertImages` (`:63`) vs `insertPaste` (`:72`); `removeAdjacentToken` (`:95`) vs `removeAdjacentPasteToken` (`:123`); `syncDraft` (`:131`) vs `syncPasteDraft` (`:146`). `draft.ts` adds per-op glue (`imageView`/`pasteView` `:37-45`, re-spread of the sub-model into `ComposerDraft` for every op).
- **Proposed deeper boundary:** one generic `PositionalTokenDraft<Payload>` parameterized by a `TokenCodec<Payload> = { parse(text): Span[]; render(n, span): string }`; the two token modules collapse to ~10-line codec instances and `draft.ts` becomes a multi-codec composer over one shared `text`.
- **Expected payoff:** ~250 duplicated lines collapse to one engine; the positional-renumber / adjacent-remove / old-number→payload invariants live and are tested once; a new token kind is one codec, not a fourth copy.
- **Estimated churn:** medium-high; behavior-preserving, existing tests pin correctness.

### C-20: `apps/agent-host/src` programmatic-command lane - `events.commandResult({command,text,ok})` hand-spelled at every reply
- **Symptom:** repeated callsite boilerplate + information leakage + a lane bypassing a deeper boundary that already exists on the other command lane.
- **Evidence:** 51 non-test `events.commandResult({…})` sites, concentrated in `worktrees/commands.ts` (13), `commands/lifecycle.ts` (10), `serial-run/commands.ts` (7), `handoff/orchestrator.ts` (7), `session/session-switch.ts` (6). The command name is re-typed at each site (`"/handoff"` 7× in orchestrator). A `catch { warn(...); emit(commandResult({text: \`Failed to …\`, ok:false})) }` envelope appears 8×; a debug-gate reply 3×. The immediate lane already shapes+emits centrally via `CommandRunResult` (`commands/commands.ts:64-70`, never hand-emits).
- **Proposed deeper boundary:** a `CommandReplier` bound once to `emit` + the command name (`replyFor(command)` where `main.ts` injects `emit`), exposing `.ok(text)` / `.fail(text)` / `.failed(error, verb)` / `.debugGated()`.
- **Expected payoff:** ~51 callsites collapse; the command name, the `command.result` shape, the "Failed to …" phrasing, and the debug-gate wording each get one owner; the programmatic lane converges on what the immediate lane proves.
- **Estimated churn:** ~9 files, mechanical/low-risk (each handler already receives `emit`); no wire change.

### C-22: leak - `_forkOrigin` payload-key contract is documented but never exported
- **Symptom:** information leakage + caller reaching past the API - a cross-package contract whose owner keeps it module-private, so the sole reader re-declares the literal + re-implements the check.
- **Evidence:** owner `packages/session/src/fork.ts:28` `const FORK_ORIGIN_KEY = "_forkOrigin"` (module-private, NOT exported; JSDoc `:14-17` markets it as a contract), written at `:70-79`. Reader `apps/agent-host/src/agent/tangent-isolation.ts:17` re-declares `const FORK_ORIGIN_KEY = "_forkOrigin"` ("see fork.ts") and re-implements `isForkCopied` (`:37-43`). Tests hard-code the literal (`fork.test.ts:62,64`, `tangent-isolation.test.ts:146`, `tangent.test.ts:114`).
- **Proposed deeper boundary:** `export const FORK_ORIGIN_KEY` + export a `hasForkOrigin(event): boolean` predicate from `fork.ts`; `tangent-isolation.ts` imports both.
- **Expected payoff:** the tangent-isolation guarantee (a tangent carries zero fork-copied events) can't silently break - renaming the key becomes a compile change, not a divergence between writer and enforcer.
- **Estimated churn:** tiny - one export + one import swap + one predicate move.

---

## Phase 2: Medium

### C-04: `packages/session/src/transport.ts` - `readSessionLog`/`awaitSessionEvent` are exposed impl + a duplicated Promise machine
- **Symptom:** exposed implementation in the public API + repeated boilerplate (internal).
- **Evidence:** `readSessionLog` (`transport.ts:69-119`) and `awaitSessionEvent` (`:125-178`) are ~50-line near-identical connect/timeout/`finish`/`close` choreographies differing only in the terminal condition; both are exported via `index.ts:42`, yet the only external caller uses the interface methods `transport.readLog`/`awaitEvent` (`:190-200`).
- **Proposed deeper boundary:** make the two helpers module-private and unify into one internal `collectUntil(transport, sessionId, identity, { onEvent?, stop, onTimeout })` that both `readLog` and `awaitEvent` delegate to.
- **Expected payoff:** two fewer public symbols to misuse, ~40 fewer duplicated lines, one owner of the replay/timeout/close dance.
- **Estimated churn:** 1-2 files, fully inside `@trevor/session`; zero app changes.

### C-05: emit-side `PublishInput` splice - every publisher re-attaches `producerId` by hand (one SDK site re-spells the event-type literal)
- **Symptom:** repeated boilerplate across host + sdk + package + a re-spelled event-type literal.
- **Evidence:** `events.*` return `{ type, payload }` (`protocol.ts:448`) while `PublishInput` is `{ type, producerId, payload }` (`transport.ts:28`), so publishers splice `producerId` in: `agent-host/src/main.ts:310`, `handoff/orchestrator.ts:107,109`, `session/tangent-adoption.ts:148`, `packages/session/src/fork.ts:115-117`, `tangent.ts:64-68`, `sdk/{lifecycle.ts:71-75, prompt.ts:53,71,105, capabilities.ts:79}`. `sdk/lifecycle.ts:71-75` hand-writes `type: "session.archived"` while also calling `events.sessionArchived(...)` for the payload.
- **Proposed deeper boundary:** add `toPublishInput(envelope, producerId): PublishInput` in `transport.ts` (or a `publishEvent` overload taking envelope + producerId); publishers call it instead of hand-splicing. Foundational for C-03.
- **Expected payoff:** ~10 splice callsites lose boilerplate; the last hand-spelled emit-side event-type string goes away; the producerId-at-publish seam stays explicit.
- **Estimated churn:** ~6 files across host + sdk + package; low risk.

### C-06: `apps/agent-host/src/mcp/transport.ts` (+ `mcp/framing.ts`) - the protocol-neutral JSON-RPC substrate is owned by the MCP module
- **Symptom:** callers reaching past the API / cross-package internal dependency + information leakage.
- **Evidence:** `mcp/transport.ts` mixes MCP specifics (the `McpTransport` interface, `MCP_PROTOCOL_VERSION`, `performHandshake`) with a fully generic JSON-RPC toolkit (`requestEnvelope` `:79`, `notificationEnvelope` `:88`, `responseEnvelope` `:93`, `decodeRpcError` `:115`, `serverRequestOutcome` `:136`, `armRequestTimeout` `:219`, the RPC/timeout prop shapes). `json-rpc/framed-connection.ts` imports its codec from `../mcp/framing` (`:3`) and envelopes from `../mcp/transport` (`:12`), so `lsp/client.ts:3` transitively depends on the MCP module for generic wire mechanics.
- **Proposed deeper boundary:** relocate the protocol-neutral primitives into `json-rpc/`; leave `mcp/transport.ts` holding only MCP handshake/version/state. `json-rpc/` becomes self-contained, depended on by both `mcp/` and `lsp/` with neither reaching into the other.
- **Expected payoff:** `lsp/` no longer depends on `mcp/`; the neutral connection stops importing an MCP-named type; wire mechanics have one home.
- **Estimated churn:** ~5-6 files; pure moves + import updates, no behavior change - low risk.

### C-07: `apps/agent-host/src/agent/loop.ts` + `turn.ts` - the mid-turn-switch surface is threaded as three separate options through three frames
- **Symptom:** pass-through arguments + configuration sprawl.
- **Evidence:** `switch`, `rebuildProvider`, `initialModel` are three fields on `RunAgentOptions` (`loop.ts:241,246,251`) and on `publishTurn`'s options (`turn.ts:93,96,99`), always produced together (gated on the same `switchCell`) and threaded verbatim with per-field spread guards (`start-turn.ts:220-231`, re-spread `turn.ts:602-604`), consumed together only inside `loop.ts` (`applyPendingSwitch` `:631`, `rebuildForModelSwitch` `:580`).
- **Proposed deeper boundary:** bundle into one `SwitchSurface { cell, rebuildProvider, initialModel }` built once in `start-turn.ts` and passed as a single option through `publishTurn` → `runAgent`; a non-switchable turn passes `undefined`.
- **Expected payoff:** collapses 3 options × 3 frames of `...(x ? {x} : {})` guards to one; the always-set-together invariant becomes structural.
- **Estimated churn:** 3 files; low risk.

### C-08: `packages/sdk/src/prompt.ts` (`streamTurn`) + `capabilities.ts` (`runCommand`) - the stream settle/teardown machine is written twice
- **Symptom:** duplicated non-trivial lifecycle logic.
- **Evidence:** the `settled` guard + `setTimeout` + `connection.close()` on terminal/timeout/status-closed appears in `streamTurn` (`prompt.ts:197-262`) and `runCommand` (`capabilities.ts:53-105`); they differ only in the terminal predicate (`assistant.completed` vs `command.result`) and whether they publish-after-replay.
- **Proposed deeper boundary:** an internal `awaitStreamResult(client, { sessionId, afterSeq, publishAfterReplay?, isTerminal, mapResult, timeoutMs })` that owns connect + timeout + single-settle + close; the two callers supply only predicate + mapping.
- **Expected payoff:** the subtle teardown/settle logic (socket-leak / double-resolve risk) is written and tested once; two of the SDK's trickiest functions shrink to their domain logic.
- **Estimated churn:** SDK-only, 2 callers, both well tested; medium risk.

### C-09: `apps/blob-store/src` + `apps/session-store/src` (`config.ts` ↔ `main.ts`) - each store's identity strings are spelled twice
- **Symptom:** information leakage / configuration sprawl.
- **Evidence:** blob-store's `"blobs"` and `"BLOB_STORE_DIR"` each appear in both `config.ts:9` and `main.ts:23/25`; session-store's `"sessions-db"` / `"SESSION_STORE_DB"` in `config.ts:9` and `main.ts:22/24`. The `config.ts` files are also thin one-ternary wrappers.
- **Proposed deeper boundary:** one colocated store descriptor per app (`{ envPrefix, dataLabel, storageArtifact, overrideEnv, legacyLabel }`) that both the path resolver and `startStore` read, so each string is declared once (natural home in the session/ports neighborhood since the stores don't depend on `@trevor/launcher`).
- **Expected payoff:** a store's identity is read/changed in one place; the `config.ts` micro-wrappers fold in; artifact/env-name can't drift.
- **Estimated churn:** narrow slice = 4 files, low risk.

### C-10: `apps/web/src/hooks/use-model-selection.ts` ↔ `use-active-model.ts` - a thin single-caller wrapper chain with data flowing out and back
- **Symptom:** thin wrapper + pass-through args + a leaky 1:1 layer boundary.
- **Evidence:** `useModelSelection` is consumed only by `useActiveModel` (`use-active-model.ts:79`), consumed only by `app.tsx:757`. `setDefault`/`togglePin` are pure renames of injected commands (`use-model-selection.ts:133-137`); host commands are threaded + renamed twice across the two hooks; `useActiveModel` computes `activeProvider`/`reasoning`, passes them in as `legacyProvider`/`legacyReasoning`, then reads `selection.preferences` back out to recompute `sendModel` (`use-active-model.ts:57-96`).
- **Proposed deeper boundary:** collapse the pair into one `useModel(...)` that owns storage + projection + legacy fallback + reasoning resolution and returns a single model view-model; drop `setDefault`/`togglePin` (callers already hold the commands).
- **Expected payoff:** removes a pass-through frame + two command renames; `app.tsx` wires model deps once against one surface.
- **Estimated churn:** 2 hooks + 2 test files; medium risk (real fallback/reasoning logic to preserve).

### C-18: `apps/web/src/components/chat/compact-display.ts` (`TOOL_SUMMARY_ARG`) vs `apps/web/src/tool-args.ts` (`salientToolArg`)
- **Symptom:** information leakage + caller reaching past the API - `tool-args.ts:1-3` declares itself the "single owner for tool-call argument parsing … so a tool's argument shape is declared once," yet `compact-display.ts` keeps a second, divergent per-tool salient-arg registry.
- **Evidence:** `tool-args.ts:30` `salientToolArg` maps bash→command, grep/glob→pattern, docs→first of [subject,query,url,corpusId], default→path. `compact-display.ts:248` `TOOL_SUMMARY_ARG` independently maps docs→query, ast_grep→pattern, archive_read/unpack→path, and `compactToolSummary` (`:263`) calls `parseToolArgs` directly, only falling back to `toolSummary` at `:280`. The two disagree: `docs` and `ast_grep` render a different one-line summary in a compact row than in the full tool row.
- **Proposed deeper boundary:** fold the archive/ast_grep/multi_edit cases into `salientToolArg` in `tool-args.ts` and have `compactToolSummary` call `toolSummary(name, args)` exclusively; delete `TOOL_SUMMARY_ARG`.
- **Expected payoff:** removes the diverging duplicate registry, fixes the docs/ast_grep compact-vs-full mismatch, restores the "declared once" contract.
- **Estimated churn:** low - extend one function, delete a map + branch, update two summary tests.

### C-19: `apps/web/src/composer/image-token-overlay.tsx` + `paste-token-overlay.tsx` + `components/chat/loop/command-input.tsx` - triplicated mirror-highlight field
- **Symptom:** triplicated scaffolding + a duplicated alignment invariant - three files each re-implement "a transparent-text field with a pixel-aligned highlight mirror," re-declaring the box-model constant and re-stating the geometry invariant.
- **Evidence:** each defines its own `FIELD` constant (`image-token-overlay.tsx:26`, `paste-token-overlay.tsx:25`, `command-input.tsx:14`) whose purpose is that field + mirror share identical typography/padding or the highlight drifts; both overlays duplicate `renderMirror` incl. the trailing-newline placeholder trick (`image-token-overlay.tsx:111-118` ≈ `paste-token-overlay.tsx:186-193`); the span→segment interleave appears a fourth time in `loop/command-token-segments.ts:20`.
- **Proposed deeper boundary:** a `MirrorField` primitive owning the geometry invariant + transparent-text/visible-caret trick + tail placeholder + stacking, taking `{ as: "input"|"textarea"; renderMirror(value); interactiveMirror? }`; a shared `segmentBySpans(value, spans, renderSpan)` helper for the interleave.
- **Expected payoff:** the "mirror must align exactly" invariant lives once instead of copy-pasted in three; new highlighted composers reuse it.
- **Estimated churn:** medium (two overlays currently only in stories/tests, so part of the payoff is forward-looking).

### C-23: leak - the slug rule (`toLowerCase → [^a-z0-9]+ → trim dashes`) re-implemented despite a declared owner
- **Symptom:** information leakage - `identity.ts` documents `idSlug` as the one owner of the slugging rule, yet three modules hand-roll the identical core.
- **Evidence:** owner `packages/session/src/identity.ts:154` `export function idSlug(text, fallback)`. Duplicates: `apps/agent-host/src/worktrees/registry.ts:55` `branchSlug` (byte-for-byte `idSlug(branch,"wt")`), `tools/docs/corpus.ts:220` `slug()` (same + `.slice(0,40)`), `tools/docs/query.ts:103` `slug()` (same + `.slice(0,60)`).
- **Proposed deeper boundary:** route all three through `idSlug` (already the exported owner); `branchSlug` collapses to `idSlug(branch,"wt")`; the docs slugs call `idSlug(x,"…").slice(0,N)` (or `idSlug` gains an optional `maxLength`).
- **Expected payoff:** the safe-character set stops being defined in four places; docs anchors + worktree paths can't drift from session ids.
- **Estimated churn:** low - 3 callsite rewrites.

### C-24: leak - source-recall per-item snippet cap `MAX_SNIPPET_CHARS = 1200` duplicated across two adapters
- **Symptom:** information leakage - the same domain limit + D-003 justification spelled in two sibling adapters that already share a contract module.
- **Evidence:** `apps/agent-host/src/tools/source-recall/source-recall-adapter.ts:51` and `aleutian-adapter.ts:43` both `const MAX_SNIPPET_CHARS = 1200` (same "candidates are cited, not whole files" rationale); both mappers truncate identically (`source-recall-mapping.ts:110-111`, `aleutian-mapping.ts:164-165`).
- **Proposed deeper boundary:** export `MAX_SNIPPET_CHARS` (or a `SOURCE_RECALL_LIMITS` object) from the already-shared `tools/source-recall/contract.ts`; both adapters import it.
- **Expected payoff:** the "cited, not dumped" invariant has one authority across both backends; a new adapter can't pick a different cap.
- **Estimated churn:** trivial - move one constant, two imports.

---

## Phase 3: Low

### C-11: `apps/agent-host/src/agent/turn.ts` `publishTurn` ↔ `loop.ts` `RunAgentOptions` - broad turn option-bag sprawl
- **Symptom:** pass-through + configuration sprawl (general case around C-07).
- **Evidence:** `publishTurn` takes a ~14-field options bag (`turn.ts:70-110`) re-assembled into `runAgent`'s ~13-field `RunAgentOptions` (`turn.ts:594-614`, `loop.ts:217-259`); `toolNames`, `delegate`, `loop`, `seedUsage` are pass-throughs, several threaded from `start-turn.ts:197-232` untouched.
- **Proposed deeper boundary:** group the always-together knobs into a couple of cohesive sub-bundles (e.g. a loop-tuning bundle `{ loop, seedUsage }` alongside C-07's `SwitchSurface`) so each frame forwards named bundles, not a flat bag. Weaker than C-07 because `publishTurn` genuinely inspects `toolNames`/`delegate` (`turn.ts:167`).
- **Expected payoff:** fewer flat knobs per frame; clearer turn-loop-control vs turn-publishing concerns.
- **Estimated churn:** 3 files; medium risk (hot turn path).

### C-12: `apps/agent-host/src/doctor/build.ts` - `DoctorRuntimeFacts` aggregation threaded field-by-field into the snapshot
- **Symptom:** pass-through + configuration sprawl (soft).
- **Evidence:** `DoctorRuntimeFacts` carries ~20 optional subsystem-rollup fields (`build.ts:52-88`), each populated in `host-facts.ts` then re-threaded one-by-one into `buildDoctorSnapshot` with `...(facts.x ? {x} : {})` spreads (`:340-421`).
- **Proposed deeper boundary:** each subsystem contributes its own already-shaped doctor fragment (mcp/lsp/hooks/admission/residency/telemetry return their snapshot slice) so `buildLiveDoctorSnapshot` merges N fragments rather than destructuring 20 named optionals.
- **Expected payoff:** adding a doctor subsystem stops requiring an edit to the central facts type + threading site.
- **Estimated churn:** `build.ts` + `host-facts.ts` + `snapshot.ts` + per-subsystem status modules; medium - opportunistic only.

### C-13: `packages/session/src/capability-manifest-compact.ts` - re-declares the `CHARS_PER_TOKEN` proxy its sibling owns
- **Symptom:** information leakage (same constant + estimator in two modules of the same package).
- **Evidence:** `breakdown.ts:178` owns `export const CHARS_PER_TOKEN = 4` + `estimateTokens` (consumed by host + web); `capability-manifest-compact.ts:21` privately re-declares `const CHARS_PER_TOKEN = 4` + its own `estimateManifestTokens`.
- **Proposed deeper boundary:** import `CHARS_PER_TOKEN` from `breakdown.ts` (the owner); keep the local `Math.ceil` rounding (a budget guardrail wants the conservative estimate).
- **Expected payoff:** the "~4 chars/token" heuristic has exactly one definition; a change can't half-update.
- **Estimated churn:** 1 file; trivial.

### C-14: `apps/web/src/components/panel/panel-host.tsx` → `virtual-transcript.tsx` - transcript handlers double-threaded field-by-field
- **Symptom:** pass-through.
- **Evidence:** `TranscriptView` (`panel-host.tsx:74-95`) carries 7 transcript fields (`onOpenPath`, `onOpenArtifact`, `onOpenDetail`, `onDoctorRefresh`, `onMenuAction`, `showThinking`, `compact`); PanelHost destructures them (`:318-330`) only to re-thread each to `VirtualTranscript` (`:430-442`); `VirtualTranscriptProps` (`virtual-transcript.tsx:20-36`) mirrors the same fields.
- **Proposed deeper boundary:** pass the transcript row-handlers/flags as one object (the shape `TranscriptView` already largely is), so PanelHost forwards a bundle instead of destructure + re-spread.
- **Expected payoff:** ~7 fewer threaded props at one frame; a new transcript-row handler stops needing edits in three signatures.
- **Estimated churn:** 2 files; low risk.

### C-15: `apps/web/src/components/command-menu/use-command-menu.ts` - a third composer menu hand-rolls arrow/enter/escape routing
- **Symptom:** repeated boilerplate.
- **Evidence:** `use-command-menu.ts:92-124` re-implements `ArrowDown`/`ArrowUp`/`Enter`/`Escape`/`ArrowLeft`; the shared `useAutocompleteMenuKeys` (`hooks/use-autocomplete-menu-keys.ts:34-82`) already owns that routing for `use-slash-menu.ts:79` and `use-file-mention-menu.ts:103`. The nested `/style` menu adds submenu-navigate + clamp-not-wrap, so it opted out and duplicated the core.
- **Proposed deeper boundary:** extend `useAutocompleteMenuKeys` (or extract a list-nav primitive under it) to cover the nested/back case so all three menus route keys through one owner.
- **Expected payoff:** one place defines composer-menu key behavior; wrap-vs-clamp and Enter-fallthrough can't diverge.
- **Estimated churn:** 1-2 files; low-to-medium risk (nested-menu semantics need a careful option surface).

### C-16: node-side service-URL resolution - `<SVC>_URL ?? serviceUrl(name)` re-derived per callsite; CLI silently can't override
- **Symptom:** information leakage.
- **Evidence:** the env-var ↔ service-name pairing is re-derived at `supervisor/main.ts:30`, `trevor-cli/main.ts:30-31`, `launcher/platform.ts:32-33`; trevor-cli calls `serviceUrl("store")`/`serviceUrl("blob")` with NO env override (`main.ts:30-31`) while supervisor/host honor it, so `trevor prompt`/`list` can't point at a remote store.
- **Proposed deeper boundary:** a node-side `resolveServiceUrl(name)` (natural home `@trevor/session/ports`) that owns the conventional `<SVC>_URL` override; every node caller uses one call and gains override-ability uniformly (Vite keeps its `VITE_`-name callsite override).
- **Expected payoff:** removes per-service env-name knowledge from 3+ callsites and closes the CLI override gap.
- **Estimated churn:** small, crosses into the session package; low priority.

### C-21: leak - `clipLine`/`boundedText` (bounded one-line preview) re-implemented across host subsystems
- **Symptom:** information leakage - the "collapse whitespace → cap → append `…`" preview invariant re-coded in modules that never reach the existing owner (`tools/shared.ts`).
- **Evidence:** owner `apps/agent-host/src/tools/shared.ts:44-47` (`clipLine`) + `:31-39` (`boundedText`); hand-rolled again in `loop/runner.ts:55-58`, `agent/recall/corpus.ts:26`, `agent/recall/search.ts:82`, `providers/failure-record-schema.ts:38`, `providers/observation-envelope.ts:82`, `subagents/discovery.ts:148`, `skills/skills.ts:197,303`, `agent/conversation-log.ts:68` (some use `…`, some `…[truncated]`).
- **Proposed deeper boundary:** lift `clipLine`/`boundedText` out of the tools-scoped `@host/tools/shared` into a host-wide text-preview util (or `@trevor/session`); route the ~8 reimplementations through it (each passing its own cap).
- **Expected payoff:** one owner for the preview format; the whitespace-collapse + ellipsis convention stops drifting.
- **Estimated churn:** ~8 files, low risk, modest per-file payoff (variants differ: collapse-only vs cap-only), so Low.

### C-25: leak - web "cap + ellipsis" truncation: two modules each claim sole ownership (off-by-one)
- **Symptom:** information leakage within `apps/web` - two utilities each documented as THE single owner of cap+ellipsis, disagreeing by one character, plus a third inline copy.
- **Evidence:** `apps/web/src/derive.ts:137` `truncate(text,max)` → `slice(0,max)+"…"` ("the one owner…"; callers `compact-display.ts:269,297`). `apps/web/src/tool-args.ts:25` `truncateText(text,max=60)` → `slice(0,max-1)+"…"` ("the single 'cap + ellipsis' implementation, shared with action-label.ts"; callers `tool-args.ts:60`, `action-label.ts:28`). Third inline copy: `tangent/foldback.ts:24`.
- **Proposed deeper boundary:** collapse to one web-local `truncate(text,max)` (keep `derive.ts`'s, which already claims ownership); `tool-args.ts` imports it, `foldback.ts` calls it; pick one max-vs-max-1 semantics deliberately.
- **Expected payoff:** 5 callsites converge on one cap semantics; removes the silent off-by-one divergence.
- **Estimated churn:** low - delete one impl, redirect ~5 callers.

### C-26: `apps/agent-host/src/tools/video-inspect/errors.ts` - a `Data.TaggedError` hierarchy wider than its handling
- **Symptom:** exposed/over-modeled errors - 7 tagged error classes + a `VideoInspectError` union, but every consumer collapses them to two outcomes: "is it `VideoCancelledError`? propagate : degrade to a `.message` string in `warnings: string[]`." The `_tag` + structured fields (`missing`, `frameIndex`, `timeoutMs`) never reach a branching handler.
- **Evidence:** `errors.ts:76-83` `type VideoInspectError` (7 members) referenced nowhere (grep = 0 hits outside `errors.ts`); `VideoBinaryMissingError` (`:12-18`) never constructed, its message hand-duplicated at `processor.ts:87`; `continuation.ts:114` `void new VideoContinuationError(...)` built and discarded; `processor.ts:100,104,133,146` construct variants only to `.message` them into `warnings`; only `VideoCancelledError` (`processor.ts:97,130`) drives control flow.
- **Proposed deeper boundary:** narrow the vocabulary to what handlers distinguish - keep `VideoCancelledError` (propagates) and fold the six "degrade to a warning" variants into one `VideoDegraded` carrying the pre-formatted message; delete the unreferenced union, the unused `VideoBinaryMissingError`, and the `void`-constructed `VideoContinuationError`.
- **Expected payoff:** removes a dead union + two degenerate classes + a duplicated literal; the remaining two-way distinction matches the consuming code, so a reader isn't misled that `_tag`/`frameIndex` are handled.
- **Estimated churn:** small, one self-contained tool (`errors.ts` ~40→~2 classes + ~10 `processor.ts` sites + 1 `continuation.ts`); no cross-package callers.

---

## Considered and rejected (do not re-add)

- `packages/server-kit/src` - already the deep shared HTTP kit (`createService` owns CORS/OPTIONS/health/404; `startServer`/`startStore` own bind + banner + legacy migration). Not shallow.
- `apps/agent-host/src/providers/pi-ai-base.ts` + adapters - exemplary base-owns-logic + adapters-are-config; depth done right.
- `apps/agent-host` provider failure/observation cluster, residency cluster, `mcp/runtime.ts` - large domains where each file owns a distinct concern with a clear "Not for" line; small ≠ shallow.
- `apps/agent-host/src/tools/lsp-*.ts` - shared pipeline already extracted into `lsp-shared.ts`.
- `packages/session/src/protocol.ts` / `protocol-decode.ts` emit-vs-decode split - deliberate direction split behind a deep interface; huge churn, no win.
- `packages/session` telemetry cluster - genuinely deep; JSONL writer shared, `redactSecrets` single-owner.
- `apps/session-store/src/session-hub.ts` - cohesive owner of the two coupled maps; deep.
- `apps/web` `useSessionActions` (25 intent-methods), `useInventory`, `RowChooserModal`/`CommandModal` adapters, `useScrollFollow`, composer-storage - deliberate deep splits / textbook deepenings.
- `packages/launcher/src/launch.ts` + `platform.ts` - wide DI interface but every member is real IO behind a deep orchestrator; wide-but-deep.
- `apps/trevor-cli/src/lifecycle.ts` - deliberate single-source facade re-exporting SDK selectors.

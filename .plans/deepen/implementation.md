# Deepen — Implementation Plan

## Architecture

<!-- D-001 --> This plan is a **standing deepening backlog**: a durable home for
shallow-module candidates surfaced by repeated design audits. It does not change
product behavior. Each audit round appends a **phase** of ranked candidates; a
candidate is a milestone. The deliverable of any milestone is the *same observable
behavior* behind a deeper interface.

The work is organized by **subsystem audit round**:

- **Phase 1 — the host (`apps/agent-host`).** Seeded in Round 1.
- **Phase 2 — the web frontend (`apps/web`).** Seeded in Round 2.
- **Phase 3 — transport / session / stores.** Seeded in Round 3.

<!-- D-012 --> Phases target different surfaces; candidates do not repeat across
rounds. The one cross-surface overlap (token breakdown) is deliberately split:
host **M6** (D-009) hides the category schema *within* the host accumulator;
web **M9** (D-013) centralizes the category *metadata + rollup* in
`@trevor/session` so both surfaces consume one source. They compose; they do
not duplicate.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Behavior-preserving | <!-- D-002 --> Existing unit/integration/conformance tests must pass unchanged; behavior is pinned before a boundary moves. |
| Provider interface stable | <!-- D-003 --> The `Provider` interface and `services.ts` Effect Layer composition must not churn while provider internals are reshaped. |
| Independently shippable | Each milestone lands behind green tests; no big-bang refactor. |
| No scope creep | Each milestone is bounded to one boundary; "while I'm here" rewrites are out of scope. |

### Boundaries

The target seams for Phase 1, justified by responsibility (not line count):

- **Turn lifecycle** owns *when* turns run and the sequencing of completion /
  compaction. Callers (`main.ts`) should not orchestrate that state machine.
- **Provider credential + transport** is one responsibility shared by the
  pi-ai-backed providers; the credential *strategy* is the only legitimate
  variation point.
- **Tool definition** owns workspace resolution, validation, error enveloping,
  and output capping; an individual tool should supply only its unique core.
- **Token accounting** owns category math; callers should ask for totals, not
  reconstruct them from the category schema.

New target files (e.g. a provider base, a tool primitive, a credential resolver)
should carry a module-level comment stating what they own and why they exist.

### Observability

Most milestones are pure-refactor and do not change runtime/transport behavior,
so they inherit existing observability. Two touch provider runtime behavior and
must preserve it: **M2** (provider base) and **M4** (pi-ai adapter) must keep the
existing auth-error / overflow classification observable - the extracted
`ProviderErrorClassifier` must surface the same typed errors and log payloads the
inline code does today. **M5** (lmstudio split) must preserve `debugInfo()` output
used by `/doctor`.

---

## Phases

### Phase 1: The host — `apps/agent-host` (Round 1)

**Goal:** The host's shallow boundaries (turn scheduler, duplicated providers,
per-tool boilerplate, leaked accounting/provider policy) are replaced by deeper
interfaces, with all existing host tests green and no behavior change.

**Gate from previous:** none (first phase).

#### M1: Collapse the turn-scheduler surface

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Boundary:** <!-- D-004 --> Replace the 13 mutation methods with lifecycle
  entry points - `processCompletion(runId, seq)` (recordAnswer+drain+maybeCompact)
  and `noteTurn(event)` (submit+noteAttempt) - fold compaction gating inside, keep
  `cancel`/`clearPending`/`resetForReconnect`.
- **Tasks:**
  1. RED: Add a characterization test asserting completion implies drain +
     compaction gate evaluation (pin the implicit `recordAnswer → drain →
     maybeCompact` ordering) via `turn-scheduler.test.ts`.
  2. GREEN: Add `processCompletion`/`noteTurn` that internally call the existing
     mutations in the correct order; leave old methods in place.
  3. REFACTOR: Migrate `main.ts` call sites (14) onto the new entry points.
  4. RED: Assert old micro-mutations are no longer part of the public surface
     (type-level / no external callers).
  5. GREEN: Make former mutations private; delete now-dead public methods.
  6. REFACTOR: Verify `main.ts` event-dispatch reads as lifecycle calls.

#### M2: Extract `PiAiProviderBase` + `CredentialResolver`

- **Dependencies:** none
- **Effort:** M
- **Boundary:** <!-- D-005 --> A base owning the `stream`/`readiness`/
  `capabilities` template, parameterized by a pluggable `CredentialResolver`;
  codex = OAuth strategy, pi-key = static-key + model-synthesis strategy; one
  shared `AUTH_PATH`.
- **Tasks:**
  1. RED: Characterization tests for codex and pi-key `readiness`/`capabilities`
     covering the auth-present and auth-missing paths.
  2. GREEN: Introduce `CredentialResolver` interface + `PiAiProviderBase`;
     implement the two strategies; keep concrete classes delegating.
  3. REFACTOR: Reduce `codex.ts`/`pi-key.ts` to strategy + config; dedupe
     `AUTH_PATH`.
  4. RED: Test the model-synthesis path (pi-key models not yet in the registry)
     against the base.
  5. GREEN/REFACTOR: Confirm provider roster test (`roster.test.ts`) is green;
     `Provider` interface unchanged.

#### M3: Deeper tool-definition primitive

- **Dependencies:** none
- **Effort:** L (1-2w)
- **Boundary:** <!-- D-006 --> A tool primitive owning workspace resolution,
  input validation, error envelope, and `cap()`; a shared search iterator
  (predicate + max) for glob/grep; a confine-and-replace helper for
  edit/multi-edit; collapse `bash.ts`.
- **Tasks:**
  1. RED: Lock current tool outputs/errors with `tools/index.test.ts` and
     per-tool tests (glob, grep, edit, replace, shared) as characterization.
  2. GREEN: Add the tool primitive + search iterator + confine-and-replace helper
     alongside existing tools.
  3. REFACTOR: Port `glob`/`grep` onto the iterator; `edit`/`multi-edit` onto the
     helper; collapse `bash.ts` to registration over `runShell`.
  4. RED: Assert error envelope/`cap()` behavior is identical across tools (one
     policy).
  5. GREEN/REFACTOR: Remove per-tool error/cap duplication; `shared.ts` owns the
     error-type decision.

#### M4: Make `pi-ai.ts` a thin adapter

- **Dependencies:** M2 (shared provider base in place)
- **Effort:** M
- **Boundary:** <!-- D-007 --> Extract a `ProviderErrorClassifier` (auth + overflow
  constants and the `promptTooBig` format) and pass `systemPrompt` in from the
  turn-runner; `pi-ai.ts` becomes a normalized adapter.
- **Tasks:**
  1. RED: Tests pinning auth-error classification and overflow detection (the
     three `promptTooBig` sites collapse to one).
  2. GREEN: Introduce `ProviderErrorClassifier`; route classification through it.
  3. REFACTOR: Thread `systemPrompt` as a parameter from `turn.ts`; stop building
     it inside `piAiEvents`.
  4. GREEN/REFACTOR: `pi-ai.ts` reduces to setup + delegation; observability
     (typed errors, log payloads) preserved.

#### M5: Split `LmStudioClient` from `LmStudioProvider`

- **Dependencies:** none
- **Effort:** M
- **Boundary:** <!-- D-008 --> `LmStudioClient` owns the load lifecycle (dedup,
  ring buffer, last-error); `LmStudioProvider` is the interface shim; env
  resolution (`LMSTUDIO_*`) moves to a config factory in `index.ts`.
- **Tasks:**
  1. RED: Characterization test for `ensureMaxContext` dedup + reload state and
     for `debugInfo()` shape used by `/doctor`.
  2. GREEN: Extract `LmStudioClient`; `LmStudioProvider` delegates.
  3. REFACTOR: Move env reads to a config factory; constructor takes explicit
     config.
  4. GREEN: `debugInfo()` output preserved; provider tests green.

#### M6: Hide the breakdown category schema

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Boundary:** <!-- D-009 --> Replace raw `snapshot()` exposure with
  category-driven accessors (e.g. `poolTotal(pool)`); callers stop iterating
  `BREAKDOWN_CATEGORIES` to hand-sum.
- **Tasks:**
  1. RED: `breakdown.test.ts` / `breakdown-categories.test.ts` pin per-pool totals
     through the new accessor.
  2. GREEN: Add accessors; keep `snapshot()` for the wire envelope only.
  3. REFACTOR: Port `logUsageBreakdown` and `turn.ts` onto accessors; new
     categories no longer require caller edits.

#### M7: Narrow `commands.ts`, own `/skills` in `skills.ts`

- **Dependencies:** none
- **Effort:** S
- **Boundary:** <!-- D-010 --> Command-specific input types instead of a wide
  `CommandContext`; `/skills` construction moves into `skills.ts`
  (`buildSkillCommand`) so `commands.ts` stops importing `SKILLS_DIR`/
  `discoverSkills`.
- **Tasks:**
  1. RED: `commands.test.ts` covers `/skills` output via the relocated builder.
  2. GREEN: Add `buildSkillCommand()` in `skills.ts`; register it from
     `commands.ts`.
  3. REFACTOR: Give each command a narrow input; drop the cross-module reach-in.

#### M8: Provider registry builder

- **Dependencies:** M2, M5 (provider internals settled)
- **Effort:** S
- **Boundary:** <!-- D-011 --> A registry builder / per-provider static factory so
  env-var resolution lives with each provider and registration is one line in
  `buildProviders()`.
- **Tasks:**
  1. RED: `roster.test.ts` pins the built registry (keys, labels, models).
  2. GREEN: Add per-provider factory; `buildProviders()` becomes registry wiring.
  3. REFACTOR: Move each provider's env defaults into its factory.

### Gate 1→2

- [ ] All Phase 1 milestone tests pass (`pnpm test` unit + integration green)
- [ ] Host e2e hermetic lane green (behavior unchanged)
- [ ] `Provider` interface and `services.ts` Layer composition unchanged
- [ ] `main.ts` no longer orchestrates turn-scheduler internals

### Phase 2: The web frontend — `apps/web` (Round 2)

**Goal:** The web frontend's shallow boundaries (duplicated breakdown math,
per-tool render scaffolding, duplicated diff prep, scattered loop grammar, UI
reaching past the parse API, thin session client, the App shell) are replaced by
deeper interfaces, with the `web` Vitest project and Storybook green and no UI
behavior change.

**Gate from previous:** Phase 1 is independent; Phase 2 may proceed in parallel.
The only coupling is **M9 ↔ host M6**: do M9 (centralize breakdown) so host M6 can
consume the centralized accessors rather than re-deriving.

#### M9: Centralize token-breakdown metadata + rollup in `@trevor/session`

- **Dependencies:** none (enables host M6)
- **Effort:** M (3-7d)
- **Boundary:** <!-- D-013 --> Move category metadata (label, color, `isOverhead`)
  and the rollup math into `@trevor/session` as the single source; web
  `components/panel/breakdown.ts` and host `usage/breakdown.ts` consume it instead
  of each walking `BREAKDOWN_CATEGORIES` with hardcoded colors.
- **Tasks:**
  1. RED: Test the centralized rollup against current web `panelBreakdown` output
     and host `logUsageBreakdown` totals (parity fixtures).
  2. GREEN: Add category metadata + `rollupBreakdown()` to `@trevor/session`.
  3. REFACTOR: Port web `breakdown.ts` (collapse to an adapter) and host
     `usage/breakdown.ts` onto the shared rollup; remove hardcoded color/label maps.
  4. GREEN: Treemap/SidePanel props unchanged; colors/labels now canonical.

#### M10: One tool-row rendering primitive

- **Dependencies:** none
- **Effort:** M
- **Boundary:** <!-- D-014 --> A single tool-row / tool-view-model primitive owning
  header + status + collapse + border; each renderer supplies only its body. Collapse
  the `ToolShell` pass-through and the `flat`/`bordered` dual-prop pattern; reuse the
  primitive in `ConcurrentToolRow`; one status→color/icon config replaces the
  duplicate maps in `message.tsx` and `concurrent-tools.tsx`.
- **Tasks:**
  1. RED: `tool-output.test.tsx` + a status-mapping test pin current rendering and
     status colors across single + concurrent contexts.
  2. GREEN: Add the tool-row primitive + shared status config.
  3. REFACTOR: Port `tool-output`/`tool-diff`/`web-search`/`multi-edit-diff` and
     `ConcurrentToolRow` onto it; remove `ToolShell` and the dual-prop bodies.
  4. GREEN: Storybook tool stories render identically.

#### M11: Diff-preparation view-model

- **Dependencies:** M10 (renderers settled)
- **Effort:** S (1-3d)
- **Boundary:** <!-- D-015 --> A `generateToolDiff(old, new, context)` owning
  `createTwoFilesPatch` + `withNewline` + `countChanges`, returning
  `{ patch, added, removed }`; `tool-diff` and `multi-edit-diff` call it once;
  `DiffViewer` stays display-only and its `parsePatch`/`computeDiff` become internal.
- **Tasks:**
  1. RED: Pin patch + change-count output for representative single/multi edits.
  2. GREEN: Add `generateToolDiff`; route both renderers through it.
  3. REFACTOR: Stop exporting `DiffViewer` parse helpers; one patch-prep path.

#### M12: Single-source the loop grammar

- **Dependencies:** none
- **Effort:** S
- **Boundary:** <!-- D-016 --> `loop.ts` owns the grammar; `loop-parser.ts` derives
  its `Set`/`Map` structures via a factory instead of rebinding `LOOP_*` constants;
  drop `LOOP_FAMILY.legendKeywords` (= `keywords.map(k => k.keyword)`); merge/remove
  the unused `commands/registry.ts`.
- **Tasks:**
  1. RED: `loop-parser.test.ts` already pins grammar end-to-end; add a test that the
     legend derives from `keywords`.
  2. GREEN: Add the grammar factory in `loop.ts`; parser imports it.
  3. REFACTOR: Remove `legendKeywords` and `registry.ts`; parser stops rebinding.

#### M13: Command parse → presentation view-model

- **Dependencies:** M12
- **Effort:** M
- **Boundary:** <!-- D-017 --> The parser emits a presentation view-model (display
  keyword chips, builder rows with labels precomputed) so loop/doctor UI stops
  reaching past `CommandParseResult`/`CommandFamilyDescriptor` fields per render.
- **Tasks:**
  1. RED: Snapshot current loop builder / keyword chip / doctor row output.
  2. GREEN: Add the view-model builder consuming parse-result + descriptor.
  3. REFACTOR: Port `loop-builder`/`loop-keywords`/`loop-inventory`/doctor panels
     onto the view-model; components stop unpacking raw fields.

#### M14: Fold the session client; split receive from act

- **Dependencies:** none
- **Effort:** S
- **Boundary:** <!-- D-018 --> Fold the thin `session/client.ts` pass-through into
  `use-session.ts`; split `useSession` into an event-accumulator and a
  `useSessionActions` hook (publish/cancel/command/openInEditor) so receiving and
  acting are separate boundaries.
- **Tasks:**
  1. RED: `use-send-queue.test.tsx` + a session-hook test pin publish + accumulate.
  2. GREEN: Inline client init into `use-session`; extract `useSessionActions`.
  3. REFACTOR: Update `App.tsx` to consume the two hooks; delete `client.ts` exports.

#### M15: Decompose the App shell

- **Dependencies:** M10, M14 (renderers + session hooks settled)
- **Effort:** L (1-2w)
- **Boundary:** <!-- D-019 --> Decompose `App.tsx` by responsibility: extract
  `<PanelControls>`, a composer-state hook (draft/attachments/send), and a
  `<PanelHost>` consuming the panel view-model; `App` becomes the composition root.
  Seams justified by concern, not line count; new files carry module-level comments.
- **Tasks:**
  1. RED: Component/hook tests for `PanelControls` and the composer-state hook.
  2. GREEN: Extract the hook + components alongside `App`.
  3. REFACTOR: Move `App` onto them; `App` holds wiring only; `web` project green.

### Gate 2→3

- [ ] `web` Vitest project green; Storybook builds with no visual regressions
- [ ] `@trevor/session` is the single source of breakdown metadata + rollup
- [ ] No component reaches past the parse/session view-models to raw fields
- [ ] `App.tsx` is a composition root (no inline panel/composer orchestration)

### Phase 3: Transport / session / stores (Round 3)

**Goal:** The shared wire layer's leaky boundaries (a URL codec split from its
owner, duplicated store server harness, a server that knows the frame schema, a
false transport seam) are tightened, with the parameterized transport-conformance
suite and both stores green and no behavior change.

**Gate from previous:** Independent of Phases 1-2. M16/M18 touch the
`@trevor/session` ↔ `session-store` contract, so run the conformance suite
(`packages/session/test/`, parameterized over `session-store` + Richter) as the lock.

#### M16: Co-locate the stream-param codec with its owner

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Boundary:** <!-- D-021 --> Move `encodeStreamParams`/`decodeStreamParams` (the
  URL identity + cursor wire contract) into `identity.ts` beside `SessionIdentity`/
  `PRODUCER_IDS`/`RUNTIME_KIND`; `session-store/server.ts` consumes the shared codec
  so renaming an identity field fails to compile on both sides.
- **Tasks:**
  1. RED: A round-trip test (encode → decode) plus a conformance assertion that the
     store reads exactly what the client encodes.
  2. GREEN: Move the codec into `identity.ts`; re-export from `stream-transport.ts`
     for API continuity.
  3. REFACTOR: `session-store/server.ts` imports the codec; drop hand-extraction.

#### M17: Shared server-kit for the stores

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Boundary:** <!-- D-022 --> Extract a server-kit (`cors`/`json`/`readBody`/
  `readJson` + a `startServer`/`RunningServer` bootstrap) used by `session-store`,
  `blob-store`, and `test-kit`; remove the duplicated HTTP helpers and the
  listen/log/shutdown pattern from both stores.
- **Tasks:**
  1. RED: Store integration tests (ephemeral port boot/teardown) stay green via the
     kit; add a kit unit test for `cors`/`json`/`readJson`.
  2. GREEN: Add the server-kit; port both stores' `server.ts` onto the helpers.
  3. REFACTOR: Route both `main.ts` and `test-kit` boot through `startServer`;
     production and test share one lifecycle path.

#### M18: `SessionLog` owns the wire framing

- **Dependencies:** M17 (store internals settled)
- **Effort:** S
- **Boundary:** <!-- D-023 --> `SessionLog` gains `readFrames(sessionId, afterSeq)`
  returning wire frames so `server.ts` stops calling `frames.event()` at the
  broadcast site and becomes dumb fan-out; frame/schema changes localize to the log.
- **Tasks:**
  1. RED: Test `readFrames` mirrors `readAfter` + `frames.event` for a replay set.
  2. GREEN: Add `readFrames`; the broadcast site calls it once.
  3. REFACTOR: Confirm conformance suite green; server holds only fan-out.

#### M19: Resolve the transport / Richter false seam

- **Dependencies:** none
- **Effort:** S
- **Boundary:** <!-- D-024 --> Collapse the types-only `transport.ts` + single-impl
  `stream-transport.ts`, making backend selection a URL knob; fold the 13-line
  `richter/client.ts` pass-through until Richter adds real concerns.
  **Escape hatch:** if the team wants `packages/richter` reserved as the divergence
  point, keep it but give it real logic (auth / reconnect / backpressure) instead of
  an empty wrapper.
- **Tasks:**
  1. RED: Conformance suite (already parameterized over Richter + session-store) is
     the behavior lock.
  2. GREEN: Merge `stream-transport` into the transport module; backend = URL.
  3. REFACTOR: Update the two callers (`host main.ts`, `web session/client.ts`);
     remove the empty richter indirection or replace it with real logic.

#### M20: `events.raw()` for forward-compat tests

- **Dependencies:** none
- **Effort:** S
- **Boundary:** <!-- D-025 --> Add `events.raw(type, payload)` for tests emitting
  arbitrary/forward-compat events; route `fake-provider.ts` through it so the test
  path shares the production envelope pipeline.
- **Tasks:**
  1. RED: Test that `events.raw` stamps the same envelope as typed builders.
  2. GREEN: Add the builder to `protocol.ts`.
  3. REFACTOR: Port `apps/agent-host/test/support/fake-provider.ts` onto it.

### Gate 3→done

- [ ] Transport-conformance suite green against both `session-store` and Richter
- [ ] Both stores' integration lanes green; no behavior change
- [ ] The stream-param wire contract is compile-checked on both client and store
- [ ] No duplicated HTTP bootstrap across `session-store`, `blob-store`, `test-kit`

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Behavioral regression while moving a boundary | high | medium | Characterize-first; existing test tiers must stay green | host |
| Effect Layer churn from provider work | medium | low | Keep `Provider` interface stable (D-003) | host |
| Lost provider observability (auth/overflow classification) | medium | medium | M2/M4 must preserve typed errors + log payloads | host |
| Scope creep into rewrites | medium | medium | One boundary per milestone; rewrites out of scope | host |
| Breakdown parity drift when centralizing (M9) | high | medium | Parity fixtures vs current web + host output before porting | web |
| UI visual regression from render-primitive port (M10/M13) | medium | medium | Storybook stories as visual lock; web project green | web |
| App-shell decomposition (M15) churns many imports | medium | medium | Land after M10/M14; extract behind green tests, one seam at a time | web |
| Wire-contract change (M16/M18) desyncs client and store | high | low | Conformance suite (parameterized over both impls) is the lock; codec is compile-checked | transport |
| Collapsing the richter seam (M19) is the wrong call if Richter diverges | medium | low | Escape hatch: keep `packages/richter` and give it real logic instead of folding | transport |

---

## Escape Hatches

1. **If M2's strategy abstraction proves leaky** (a third provider needs more than
   credential variation): stop at deduping `AUTH_PATH` + shared `readiness`
   helper, leave the classes separate.
2. **If M3's primitive can't cover bash safety cleanly:** keep `bash.ts` as-is and
   ship only the glob/grep iterator + edit/multi-edit helper.
3. **If a milestone's characterization reveals under-tested behavior:** add the
   test first as its own commit before touching the boundary.
4. **If collapsing the Richter seam (M19) proves premature:** keep
   `packages/richter` and deepen it with real transport concerns instead.

---

## Audit exclusions (do not re-flag)

<!-- D-026 --> The `HEX64` regex duplicated in `apps/blob-store/src/store.ts` is
**intentional**: blob-store is a standalone leaf with zero workspace dependencies,
so it must not import `@trevor/session`. This is isolation by design, not leakage -
future deepening audits should skip it.

---

## Progress Report Accounting

See `progress-report.md`. Current cutoff = Phase 1 (the host). Phases 2-3 are
appended by later audit rounds and are not current blockers until seeded.

---

## Validation Commands

```bash
pnpm test            # all Vitest projects (unit | integration | web | e2e)
pnpm test --project unit
pnpm test --project integration
pnpm typecheck
pnpm lint            # Biome
```

---

## Decisions

Canonical decisions are in `.plans/deepen/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.claude/skills/planner/scripts/plan-db.ts query-decisions --plan "deepen"
```

Key decisions: D-001 (purpose), D-002 (discipline), D-003 (provider stability),
D-004…D-011 (per-milestone boundaries).

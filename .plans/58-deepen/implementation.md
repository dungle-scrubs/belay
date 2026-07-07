# Deepen Repository Boundaries - Implementation Plan

## Architecture

This plan turns the repository-wide deepen audit into a staged boundary-refactor program. The work is intentionally ordered from shared contracts outward:

1. Protocol grammar and projections first, because they define what every runtime consumes.
2. Host composition and provider/tool boundaries next, because they sit on top of the protocol and feed the user-visible turn pipeline.
3. Harness, artifact, and CLI boundaries last, because they should consume the deeper APIs rather than invent their own.

The target shape is not "smaller files". The target is fewer places where callers reconstruct product meaning from low-level arrays, switches, and process globals. Each phase must leave behavior unchanged except where a milestone explicitly adds missing tests or stricter validation around an existing contract.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Trevor is a private pnpm monorepo | Do not change visibility, package publishing, or external distribution while doing this work. |
| Existing protocol compatibility matters | Wire event names and payload shapes remain compatible unless a milestone explicitly documents a migration. |
| `@trevor/session` is the protocol source of truth | Web, SDK, CLI, host, e2e, and test-kit must import protocol concepts from it instead of re-deriving them. |
| Host turn pipeline is Effect | Host runtime boundaries that participate in turns, providers, tools, or cancellation stay inside Effect and use typed errors. |
| Tests are organized by scope | Unit tests are colocated, package integration tests live in package `test/`, and cross-service flows live in top-level `e2e/`. |
| No new root storage policy | Artifact/runtime changes must reuse existing storage root policy and blob-store URL configuration. |
| Plan docs live on `main` | Commit plan docs to `main` before starting implementation worktrees. Implementation source changes happen on the plan branch. |

### Boundaries

#### Protocol Event Grammar

Owner: `packages/session`.

Target boundary:

- `packages/session/src/protocol/registry.ts` owns the registry shape, event-family registration, lookup, and decode dispatch.
- Event-family modules own constructor, decoder, payload type, decoded event type, defaults, and compatibility notes for one cohesive family.
- `packages/session/src/protocol.ts` becomes a compatibility facade over the registry-backed constructors and exported event unions.
- `packages/session/src/protocol-decode.ts` becomes a compatibility facade over registry decode APIs, then can shrink further once imports migrate.
- `packages/session/src/index.ts` exports stable public surfaces deliberately; implementation-only registry internals are not exported from the package root.

Callers may emit and decode events through public protocol APIs. Callers must not switch on raw event names to recover concepts that a deeper API owns.

#### Web Session Read Models

Owner: `apps/web/src/session`.

Target boundary:

- `apps/web/src/session/projection.ts` folds a `SessionEvent` stream into one `SessionReadModel`.
- `apps/web/src/session/selectors.ts` exposes named selectors for transcript, host status, source state, pending question, tasks, and panels.
- UI components consume selectors or read-model fields instead of raw `readonly SessionEvent[]`.
- Existing pure folds in `derive.ts` and `transcript.ts` either move behind the projection boundary or become private helpers for it.

The projection can initially recompute from a full log for compatibility. Incremental folding is a later optimization inside the same boundary once selector behavior is covered.

#### Host Session Worker

Owner: `apps/agent-host/src/session`.

Target boundary:

- `session-worker.ts` owns per-session subscription, replay/live handling, turn scheduling, Emit layer creation, active-run lifecycle, cancellation, reconnect, and teardown.
- Main host wiring and tangent adoption provide policy hooks for leader gating, command handling, compaction, child delegation, and host-level lifecycle logging.
- Tangent and main-session workers share the same cancellation and reconnect machinery by construction.

Runtime behavior stays inside the existing host Effect program where it touches turns, tools, providers, and emit services. Imperative transport callbacks remain at process edges.

#### Tool Registry

Owner: `apps/agent-host/src/tools`.

Target boundary:

- `registry.ts` exposes a `ToolRegistry` builder and runtime registry interface: `defs()`, `offered()`, `execute()`, `readOnlySet()`, and `toolsets()`.
- Tool contribution modules provide typed definitions plus explicit dependencies.
- Runtime singleton construction moves out of tool definition code and into the host composition root or a small tool-runtime factory.
- `tool_script` dispatch receives an explicit registry capability instead of reaching back through global module state.

Tests construct minimal registries without importing every tool.

#### Provider Model-Source Resolver

Owner: `apps/agent-host/src/providers`.

Target boundary:

- `model-source-resolver.ts` is the single turn-time provider selection API.
- Catalog-visible source rows, user preferences, defaults, compatibility aliases, and concrete provider construction all resolve through the same typed selection path.
- `providers/index.ts` remains a compatibility barrel only for stable adapter contracts and the resolver API.

Legacy provider keys continue to work by becoming aliases that the resolver normalizes.

#### Cross-Service Workflow Drivers

Owner: `packages/test-kit` plus `apps/agent-host/test/support`.

Target boundary:

- `packages/test-kit` owns generic service boot, transport recording, wait/subscribe helpers, and workflow-level client drivers that do not depend on host internals.
- `@trevor/agent-host/testing` owns fake-provider host attachment and typed host-only fixtures.
- E2E tests use workflow drivers for common flows: hermetic host stack, prompt-to-completion, ask-user round trip, command dispatch, tangent flow, and tool-detail flow.

Cross-service tests should not import host internals unless the test is explicitly validating host internals.

#### Artifact Runtime

Owner: shared artifact modules split by runtime.

Target boundary:

- A shared artifact runtime contract owns artifact refs, kind policy, blob URL resolution, upload/download operations, image eligibility, frame storage, and model inlining adapters.
- Browser binding handles file upload and UI-facing previews.
- Host binding handles model-visible image resolution and video-inspect frame upload.
- Existing `@trevor/session` blob client remains the wire client; the artifact runtime owns policy around how callers use it.

No new storage root is introduced. Blob-store URLs and artifact bytes continue to flow through the existing blob-store.

#### CLI Command Router

Owner: `apps/trevor-cli/src`.

Target boundary:

- `command-router.ts` owns command table execution.
- Each command family owns parse, validate, run, and usage text.
- `main.ts` owns process wiring only: environment, URL binding, SDK construction, lifecycle IO, host-control IO, and invoking the command table.

Usage text is generated from command table metadata so dispatch and help cannot drift silently.

### Observability

This plan touches transport, turn lifecycle, providers, tools, artifacts, and test harnesses. Runtime milestones must preserve or add these inspection points:

- Protocol decode failures keep event name, producer, session id when available, and a redacted payload class, not full sensitive payloads.
- Session-worker lifecycle logs include session id, worker role (`main` or `tangent`), replay/live transition, reconnect attempt, active-run id, and cancellation reason.
- Tool execution failures continue to render one model-facing error line while retaining typed host-side failure details.
- Provider resolution logs record requested selection, normalized source/model, fallback reason, and provider adapter without exposing tokens.
- Artifact resolution logs record artifact id, kind, source URL class, validation outcome, and model-inlining decision.
- Workflow drivers expose enough failure context for e2e debugging: services started, ports, session id, awaited event predicate, last matching event, and timeout.

No milestone may add best-effort diagnostics that can fail a user turn.

---

## 0. Hard Dependencies

None.

---

## Phases

### Phase 0: Make The Audit Plan Implementable

**Goal:** The plan is canonical, actionable, and ready for an implementation branch.

**Gate from previous:** Existing `.plans/58-deepen` artifacts exist and `plan-db status --plan "58-deepen"` can read them.

#### M0: Normalize Planner State

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Run `plan-db check-progress --plan "58-deepen"` and capture any accounting drift.
  2. GREEN: Update `progress-report.md` so the current focus is the first unchecked active milestone.
  3. GREEN: Ensure `implementation.md` describes executable architecture, milestones, gates, risks, and validation commands.
  4. REFACTOR: Keep the original audit candidate evidence in the plan so implementers can trace each boundary back to concrete files.

### Gate 0->1

- [ ] `plan-db check-progress --plan "58-deepen"` passes.
- [ ] `plan-db status --plan "58-deepen"` lists the implementation and progress report documents.
- [ ] The plan docs are committed to `main` before any source implementation branch starts.

### Phase 1: Protocol And Read-Model Foundations

**Goal:** Shared protocol and web read-model boundaries own event meaning before host, SDK, CLI, and e2e callers are migrated further.

**Gate from previous:** Gate 0->1 complete.

#### M1: Deepen `@trevor/session` Protocol Into A Registry-Backed Event Grammar

- **Dependencies:** M0
- **Effort:** XL
- **Evidence from audit:**
  - `packages/session/src/index.ts` exports nearly every module from the package root.
  - `packages/session/src/protocol.ts` documents constructor and decoder halves as one protocol while they are maintained separately.
  - `packages/session/src/protocol-decode.ts` owns local coercion helpers and the central `decodeTrevorEvent` switch.
- **Tasks:**
  1. RED: Add protocol unit tests proving each currently exported constructor round-trips through `decodeTrevorEvent` with the same decoded event type and payload semantics.
  2. RED: Add a package-boundary test that fails if new event-family implementation internals are exported from `packages/session/src/index.ts`.
  3. GREEN: Introduce a registry shape that can register one event family with constructor, decoder, decoded type, wire name, and compatibility metadata while leaving existing public APIs intact.
  4. GREEN: Migrate the smallest event family to the registry and route `decodeTrevorEvent` through registry lookup for that family.
  5. RED: Add tests for unknown event names, malformed payloads, optional defaults, and compatibility aliases.
  6. GREEN: Migrate remaining event families in small batches, keeping compatibility facades for old imports.
  7. GREEN: Update host, web, SDK, test-kit, and e2e imports only where they depend on implementation internals or broad package-root exports.
  8. REFACTOR: Collapse duplicated decode helpers into registry-owned helpers and document the event-family module pattern.

#### M2: Deepen Web Event-Log Projection Into Session Read Models And Selectors

- **Dependencies:** M1
- **Effort:** L
- **Evidence from audit:**
  - `apps/web/src/derive.ts` defines generic log folds and host-status derivation.
  - `apps/web/src/transcript.ts` owns a separate transcript fold.
  - `apps/web/src/session/use-session.ts` exposes raw stream state broadly.
  - `apps/web/src/app.tsx` composes several projections from the same event array.
- **Tasks:**
  1. RED: Add web tests for current transcript, host status, source state, pending question, task, and panel derivations from representative event logs.
  2. GREEN: Introduce `SessionReadModel` and selectors that reproduce the existing derivations from a full event log.
  3. RED: Add a regression test that a component can render from selectors without receiving the raw event array.
  4. GREEN: Migrate `use-session` to expose the read model and selectors while temporarily preserving raw events for compatibility.
  5. GREEN: Move `app.tsx` and nearby UI modules to selectors.
  6. REFACTOR: Make raw event access private to the session data boundary except for explicit debug or developer surfaces.

### Gate 1->2

- [ ] `pnpm --filter @trevor/session typecheck` passes.
- [ ] `pnpm --filter @trevor/web typecheck` passes.
- [ ] `pnpm test:unit` passes for protocol and pure projection tests.
- [ ] `pnpm test:web` passes.
- [ ] No new broad package-root protocol exports are introduced.

### Phase 2: Host Runtime Boundaries

**Goal:** Host session lifecycle, tools, and provider selection become explicit runtime boundaries over the deeper protocol foundation.

**Gate from previous:** Gate 1->2 complete.

#### M3: Deepen Host Session-Worker Composition For Main Sessions And Tangents

- **Dependencies:** M1
- **Effort:** XL
- **Evidence from audit:**
  - `apps/agent-host/src/session/tangent-adoption.ts` states each worker mirrors main single-session composition.
  - Tangent adoption constructs log, turn state, emit layer, scheduler, start-turn, cancellation, event handling, and reconnect behavior.
- **Tasks:**
  1. RED: Add host unit/integration tests that assert main-session and tangent cancellation emit the same completion/cancel semantics.
  2. RED: Add a reconnect/replay test for tangent workers that captures current behavior before extraction.
  3. GREEN: Introduce a `SessionWorker` factory with injected policy hooks and no behavior change for tangent adoption.
  4. GREEN: Move tangent adoption onto `SessionWorker` while keeping main host untouched.
  5. RED: Add a parity test that main-session and tangent workers share the same active-run lifecycle guarantees.
  6. GREEN: Move main host per-session composition onto `SessionWorker`.
  7. REFACTOR: Remove duplicated cancellation, reconnect, and emit-layer setup from tangent adoption and main host wiring.

#### M4: Deepen Host Tool Registration Into A Composable `ToolRegistry`

- **Dependencies:** M3
- **Effort:** L
- **Evidence from audit:**
  - `apps/agent-host/src/tools/index.ts` imports all tools and runtime singletons.
  - The same file assembles the registry, derives provider definitions, executes tools, and wires `tool_script` back into `executeTool`.
- **Tasks:**
  1. RED: Add tool registry tests for definitions, offered toolsets, read-only flags, dispatch success, typed failure rendering, and unknown tool names.
  2. GREEN: Introduce `ToolRegistry` interface and builder using the existing global registry data.
  3. RED: Add a test that constructs a minimal registry with one fake tool and no unrelated tool imports.
  4. GREEN: Move individual tool contributions into local modules with explicit dependencies.
  5. GREEN: Make provider-facing tool definitions and `executeTool` consume a registry instance.
  6. GREEN: Rework `tool_script` so recursive dispatch is an explicit registry capability.
  7. REFACTOR: Shrink `tools/index.ts` to a compatibility facade or remove it if no public surface requires it.

#### M5: Deepen Provider Selection And Catalog Into One Model-Source Resolver

- **Dependencies:** M3
- **Effort:** M
- **Evidence from audit:**
  - `apps/agent-host/src/providers/index.ts` owns legacy `ProviderRegistry`, `DEFAULT_PROVIDER`, `buildProviders`, and `pickProvider`.
  - `apps/agent-host/src/providers/catalog.ts` owns source rows and source-to-provider dispatch.
  - Web publishes model selection and host-side preference commands.
- **Tasks:**
  1. RED: Add resolver tests for explicit source/model selection, default fallback, legacy provider-key aliasing, unknown model, unavailable source, and preference persistence inputs.
  2. GREEN: Introduce `model-source-resolver.ts` that wraps existing catalog and legacy registry behavior without changing call sites.
  3. GREEN: Move turn-time provider selection to the resolver.
  4. RED: Add a compatibility test proving old provider keys normalize through the resolver.
  5. GREEN: Collapse `buildProviders` and `pickProvider` into compatibility adapters over the resolver.
  6. REFACTOR: Narrow `providers/index.ts` exports to adapter contracts, provider errors, and resolver API.

### Gate 2->3

- [ ] `pnpm --filter @trevor/agent-host typecheck` passes.
- [ ] `pnpm test:unit` passes for host session, tool, and provider tests.
- [ ] `pnpm test:integration` passes for host turn/tool/provider flows.
- [ ] `pnpm test:e2e` passes for hermetic host stack, tangent, command, and ask-user flows.
- [ ] Host logs retain session id, run id, provider selection, and cancellation context.

### Phase 3: Cross-Service Harness And Artifact Policy

**Goal:** Tests and artifact handling consume shared runtime boundaries instead of repeating low-level boot and blob policy.

**Gate from previous:** Gate 2->3 complete.

#### M6: Deepen Cross-Service Test Harnesses Into Workflow Drivers

- **Dependencies:** M2, M3, M4, M5
- **Effort:** M
- **Evidence from audit:**
  - `packages/test-kit` exports useful primitives, but e2e tests still repeat boot, subscribe, wait, fake-host, publish-turn, and decode shapes.
  - `apps/agent-host/test/support/index.ts` exposes many host internals for e2e access.
- **Tasks:**
  1. RED: Add tests for a workflow driver that boots a hermetic stack, submits a prompt, and waits for completion with useful timeout diagnostics.
  2. GREEN: Add generic workflow drivers in `packages/test-kit` for boot, subscribe, wait, prompt-to-completion, command dispatch, and event inspection.
  3. RED: Add host testing tests for fake-provider attachment through `@trevor/agent-host/testing` without leaking unrelated internals.
  4. GREEN: Move e2e golden path, ask-user, command-file dispatch, tangent, and tool-detail tests onto drivers one by one.
  5. REFACTOR: Remove duplicate boot/wait/decode helpers from e2e files and narrow `apps/agent-host/test/support/index.ts` exports.

#### M7: Deepen Blob And Artifact IO Into A Shared Artifact Runtime

- **Dependencies:** M1, M2, M5
- **Effort:** L
- **Evidence from audit:**
  - Web, host image resolution, and video-inspect tool each resolve blob-store URL policy independently.
  - Turn execution wires frame resolution directly.
- **Tasks:**
  1. RED: Add tests for artifact kind classification, blob URL resolution, upload/download, image eligibility, invalid image rejection, and frame artifact creation.
  2. GREEN: Introduce a shared artifact runtime contract using the existing `@trevor/session` blob client.
  3. GREEN: Add browser binding and migrate web upload/kind classification to it.
  4. GREEN: Add host binding and migrate image resolution to it.
  5. RED: Add video-inspect tests proving sampled frames are stored through the artifact runtime and returned as artifact refs.
  6. GREEN: Move video-inspect frame upload and turn-time model inlining onto the host binding.
  7. REFACTOR: Remove duplicated blob URL resolution and local artifact policy from web and host modules.

### Gate 3->4

- [ ] `pnpm --filter @trevor/test-kit typecheck` passes.
- [ ] `pnpm --filter @trevor/web typecheck` passes.
- [ ] `pnpm --filter @trevor/agent-host typecheck` passes.
- [ ] `pnpm test:integration` passes.
- [ ] `pnpm test:e2e` passes.
- [ ] Artifact diagnostics are best-effort and cannot fail a user turn.

### Phase 4: CLI Command Surface

**Goal:** CLI command behavior is table-driven, testable, and aligned with SDK/session boundaries.

**Gate from previous:** Gate 3->4 complete.

#### M8: Deepen CLI Command Dispatch Into A Command Table And Router

- **Dependencies:** M1, M6, M7
- **Effort:** M
- **Evidence from audit:**
  - `apps/trevor-cli/src/main.ts` mixes URL binding, SDK construction, flag parsing, MIME lookup, command dispatch, lifecycle IO, host-control IO, usage text, and launcher execution.
- **Tasks:**
  1. RED: Add CLI parser/router unit tests for existing commands, flags, artifact subcommands, usage output, invalid commands, and MIME inference.
  2. GREEN: Introduce a command table with parse, validate, run, and usage metadata for one command family.
  3. GREEN: Migrate remaining command families into table entries.
  4. RED: Add a test proving usage output is generated from command metadata and includes every registered command.
  5. GREEN: Reduce `main.ts` to process wiring, dependency construction, command table execution, and process exit handling.
  6. REFACTOR: Move shared parser helpers and MIME inference into owned CLI modules with focused tests.

### Gate 4->5

- [ ] `pnpm --filter @trevor/cli typecheck` passes.
- [ ] `pnpm test:unit` passes for CLI parser/router tests.
- [ ] `pnpm test:e2e` passes for headless CLI and command-file dispatch flows.
- [ ] CLI usage output is generated from command table metadata.

### Phase 5: Repository-Wide Cutover And Verification

**Goal:** All deepened boundaries are the active path, compatibility facades are either justified or removed, and the full gate passes.

**Gate from previous:** Gate 4->5 complete.

#### M9: Remove Boundary Drift And Finish The Cutover

- **Dependencies:** M1, M2, M3, M4, M5, M6, M7, M8
- **Effort:** M
- **Tasks:**
  1. RED: Add or update boundary tests that fail on direct raw-event projection in UI modules, direct host-internal imports from e2e, broad protocol exports, duplicated blob URL resolution, and ad hoc CLI command dispatch.
  2. GREEN: Remove or narrow compatibility facades that no longer have external callers.
  3. GREEN: Update package barrels and aliases to expose only intentional public surfaces.
  4. GREEN: Update architecture docs or module headers that describe the new boundaries.
  5. REFACTOR: Run repo-wide import cleanup and remove dead helpers made obsolete by the new boundaries.
  6. REFACTOR: Re-run the deepen audit manually against touched areas and record any deferred follow-up as a new plan, not as unchecked work in this plan.

### Final Gate

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm test:e2e:browser` passes or is explicitly recorded as skipped with the reason.
- [ ] `plan-db check-progress --plan "58-deepen"` passes.
- [ ] `plan-db check-convergence --plan "58-deepen" --streak 3` passes, or any non-convergence is explained by accepted follow-up plans.
- [ ] `.plans/58-deepen/` is deleted only after implementation is complete and merged into `main` according to repo policy.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Protocol registry changes alter wire compatibility | high | medium | Start with round-trip tests for every existing constructor and decoded event before moving decode logic. | M1 implementer |
| Web projection migration drops rare UI states | high | medium | Build representative event-log fixtures before moving components and keep raw events temporarily available at the session boundary. | M2 implementer |
| Session-worker extraction changes cancellation or reconnect timing | high | medium | Add parity tests for main and tangent workers before extraction, then migrate one worker at a time. | M3 implementer |
| Tool registry extraction breaks provider-facing schema generation | high | medium | Test provider definitions and offered toolsets against current snapshots before changing dispatch. | M4 implementer |
| Provider resolver changes default or legacy provider behavior | high | medium | Cover explicit selections, defaults, aliases, and unavailable source cases before moving turn-time selection. | M5 implementer |
| Workflow drivers hide useful e2e failure detail | medium | medium | Driver errors must include awaited predicate, session id, service ports, and recent relevant events. | M6 implementer |
| Artifact runtime accidentally introduces a new storage root or blocking diagnostics | high | low | Reuse existing blob-store and root policy; diagnostics remain best-effort. | M7 implementer |
| CLI command table changes help text or exit behavior | medium | medium | Add parser/router/usage tests before reducing `main.ts`. | M8 implementer |
| One implementation branch becomes too large to review | high | high | Complete and gate phases sequentially. If review size becomes unmanageable, stop at the next gate and split remaining phases into follow-up numbered plans. | Plan owner |

---

## Escape Hatches

1. **If M1 registry migration becomes too large:** Keep compatibility facades and migrate event families in separate follow-up plans. The current phase can finish when the registry supports at least one family and all old APIs are still green.
2. **If M2 selector migration exposes missing product decisions:** Keep raw events available only inside `use-session`, document the unresolved selector, and split that selector into a follow-up plan.
3. **If M3 session-worker extraction changes runtime behavior:** Revert only the worker adoption step, keep the characterization tests, and re-plan the factory shape from the failing parity cases.
4. **If M4 or M5 cannot be completed without broad host churn:** Land the tested compatibility wrapper first, then split the call-site migration into a follow-up plan.
5. **If M6 driver migration obscures failures:** Keep the low-level helper for that one e2e flow and require the driver to expose the missing diagnostic before retrying migration.
6. **If M7 artifact runtime conflicts with browser/host bundling:** Keep runtime-specific bindings separate behind one shared contract and avoid a single universal implementation module.
7. **If M8 command-router migration changes CLI compatibility:** Keep the existing command path for the failing command and migrate the rest of the table first.

---

## Progress Report Accounting

The progress report is the implementation resume state. It must use normalized accounting:

- Current blockers count only active unchecked work.
- Accepted or deferred follow-up is excluded from current blockers.
- Superseded checklist debt is struck through or moved out of current accounting with a decision or gate reference.
- The current focus marker must match the first unchecked current-cutoff checkbox.
- Future-phase references must point to concrete progress-report sections and checkboxes.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58-deepen"
```

---

## Validation Commands

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts status --plan "58-deepen"
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58-deepen"
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "58-deepen" --streak 3

pnpm --filter @trevor/session typecheck
pnpm --filter @trevor/web typecheck
pnpm --filter @trevor/agent-host typecheck
pnpm --filter @trevor/test-kit typecheck
pnpm --filter @trevor/cli typecheck

pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:web
pnpm test:integration
pnpm test:e2e
pnpm test
pnpm test:e2e:browser
```

---

## Decisions

Canonical decisions are in the plan database (`.plans/58-deepen/plan.db`). Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "58-deepen"
```

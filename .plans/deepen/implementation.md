# Deepen — Implementation Plan (Deepening Backlog)

## 0. Hard Dependencies

None. Each candidate below is independent; acting on one never requires another.

## Architecture

This is a **standing deepening backlog**, not a feature plan. It is produced and
maintained by the `deepen-plan` skill: repeated whole-repository `deepen` audits
fold their findings here, deduped against what is already recorded.

Each milestone is ONE shallow-module / leaky-abstraction / pass-through candidate
surfaced by the audit. A milestone records the symptom, the evidence, a proposed
deeper boundary, the expected payoff, and the estimated churn — it does **not**
redesign or implement the change. Acting on a candidate is a separate, later step:
the user picks one milestone and runs `planner` with that candidate as the brief
(and `observability` to instrument the new boundary once redesigned).

Candidates carry a stable `DC-NNN` id (Deepen Candidate) so later audit passes can
dedup against this list. Ranking follows the deepen convention:
`(callers benefiting) × (clarity of proposed boundary) ÷ (estimated churn)`,
bucketed High / Medium / Low. Ranking precision is not the point — the buckets are
a triage aid, and milestones within a bucket are unordered.

### Boundaries

The backlog spans three surfaces:

- **`apps/agent-host`** — the host runtime (agent loop, providers, tools).
- **`apps/web`** — the React UI (chat, panels, command surfaces).
- **`packages/*`** — the shared session protocol and transport kit.

A candidate names exactly the files whose boundary moves. Candidates do not cross
surfaces unless the symptom is cross-surface information leakage.

---

## Phases

> "Phases" here are rank buckets, not a sequence. There is no gate between them and
> no dependency ordering — a milestone may be picked from any bucket at any time.

### Phase H: High-priority candidates

#### M-DC-001: Collapse the `ToolMessage` thin wrapper
<!-- DC-001 -->
- **Target:** `apps/web/src/components/chat/tool-message.tsx`
- **Rank:** High
- **Symptom:** Thin wrapper (#1) — forwards to a single underlying call, adds nothing.
- **Evidence:** `tool-message.tsx:265-271` `ToolMessage` is a pass-through that renders
  `<ToolRenderer {...props} />` with an identical prop signature and no added logic.
  Single callsite: `apps/web/src/components/chat/transcript-row-view.tsx:94`.
- **Proposed deeper boundary:** Delete `ToolMessage`; export `ToolRenderer` as the
  public entry point and have the one caller use it directly.
- **Expected payoff:** Removes one indirection layer; `ToolRenderer` becomes the clear
  entry point for rendering tool messages.
- **Estimated churn:** 1 caller updated, 1 import changed. Negligible risk.

#### M-DC-002: Centralize duplicated markdown-body rendering
<!-- DC-002 -->
- **Target:** `apps/web/src/components/chat/{message,transcript-row-view,queued-prompts}.tsx`
- **Rank:** High
- **Symptom:** Information leakage (#7) — the same markdown-wrapper abstraction is
  re-implemented in three files.
- **Evidence:** `message.tsx:235-240` `MarkdownBody`; `transcript-row-view.tsx:22-28`
  local `Md`; `queued-prompts.tsx:7-17` local `Md` — same structure, ~7 callsites total.
- **Proposed deeper boundary:** Extract one shared `MarkdownBody` (own module or exported
  from `message.tsx`); the other two import it instead of redeclaring.
- **Expected payoff:** One source of truth for markdown rendering; class/wrapper changes
  propagate automatically; 3 copies → 1.
- **Estimated churn:** 3 files, 2 imports. Low risk (pure refactor).

#### M-DC-009: Single owner for reserved service ports
<!-- DC-009 -->
- **Target:** `apps/trevor-cli/src/services.ts` (owner) + `apps/web/src/blob.ts`, `apps/web/vite.config.ts`,
  `apps/agent-host/src/artifacts.ts`, `apps/session-store/src/main.ts`, `apps/blob-store/src/main.ts`
- **Rank:** High
- **Symptom:** Information leakage (#7) — the reserved port numbers are declared once and then
  re-hardcoded across packages.
- **Evidence:** `services.ts:13` `RESERVED_PORTS = { web:17420, blob:17423, store:17424 }` (source of
  truth), but the same literals are hardcoded as fallbacks/targets in `web/src/blob.ts:9` (17423),
  `web/vite.config.ts:28` (17420) + `:32` (17424), `agent-host/src/artifacts.ts:19` (17423),
  `session-store/src/main.ts:14` (17424), `blob-store/src/main.ts:13` (17423).
- **Proposed deeper boundary:** A shared constant (exported from a package importable by all surfaces)
  owns the reserved ports; every fallback imports it instead of hardcoding. Env-var overrides still win,
  but no literal shadows the source of truth.
- **Expected payoff:** A port change edits one place; fallbacks stay in sync across host/web/stores.
- **Estimated churn:** ~5 files; care needed since stores are separate packages (the constant must live
  somewhere all of them already depend on, e.g. `packages/session` or a small shared config module).

#### M-DC-012: Re-export provider error types from `providers/index.ts`
<!-- DC-012 -->
- **Target:** `apps/agent-host/src/providers/index.ts` (+ ~6 callers of `providers/errors`)
- **Rank:** High
- **Symptom:** Callers reaching past the API (#4) — `providers/index.ts` re-exports `types.ts` but not
  `errors.ts`, so callers import the error classes from the internal module.
- **Evidence:** 6 callsites import `ProviderUnavailable`/`ProviderAuthError`/`ModelLoadError` straight
  from `providers/errors`: `turn.ts:8`, `agent/loop.ts`, plus tests `turn.test.ts`,
  `agent/reconnect.test.ts`, `agent/delegate.test.ts`, `agent/recall/engine.test.ts`.
- **Proposed deeper boundary:** Re-export the provider error classes from `providers/index.ts`; callers
  import them through the package entry point, making `errors.ts` internal.
- **Expected payoff:** Error internals can be refactored without breaking callsites; one public surface.
- **Estimated churn:** ~6 import lines. Negligible risk.

#### M-DC-013: Complete the `tools/index.ts` public surface
<!-- DC-013 -->
- **Target:** `apps/agent-host/src/tools/index.ts` (+ `processes.ts`, `skills.ts`, `tasks.ts`)
- **Rank:** High
- **Symptom:** Callers reaching past the API (#4) — `tools/index.ts` does not re-export the error types
  or the `Tool` interface, so consumers reach into `tools/errors` and `tools/types`.
- **Evidence:** `processes.ts:6,8`, `skills.ts`, `tasks.ts` import `ToolExecutionError`/`ToolInputError`/
  `ProcessError`/`ToolError`/`Tool` directly from `tools/errors` and `tools/types` (4 + 3 callsites).
- **Proposed deeper boundary:** Re-export the tool error classes AND the `Tool`/`ToolError` types from
  `tools/index.ts`; consumers import everything tool-related through one entry point (mirrors providers).
- **Expected payoff:** `errors.ts`/`types.ts` become internal; tool-defining modules use one import path.
- **Estimated churn:** ~7 import lines across 3 files. Negligible risk.

#### M-DC-014: `createService(routes)` lifecycle helper in `server-kit`
<!-- DC-014 -->
- **Target:** `packages/server-kit/src/**` (owner) + `apps/blob-store/src/server.ts` (+ `apps/session-store`)
- **Rank:** High
- **Symptom:** Repeated boilerplate at callsites (#5) — `blob-store` re-implements the whole HTTP request
  lifecycle (CORS, OPTIONS, `/health`, JSON, body-reading, method/path dispatch, 404) that `server-kit`
  already partly provides and `session-store` consumes.
- **Evidence:** `blob-store/src/server.ts:98-126` redeclares `cors()`/`json()`/`readBody()` identical to
  `server-kit/src/http.ts:15-19,22-25,45-61`, plus inline OPTIONS/`/health`/404 lifecycle. `session-store`
  avoids this by using server-kit helpers. (This is the pass-1 held "blob-store dup" item, now with a clear
  deeper boundary.)
- **Proposed deeper boundary:** `server-kit` exposes `createService(routes)` that owns the full request
  lifecycle (CORS from route methods, OPTIONS, `/health`, dispatch, 404); each store declares a `Route[]`
  of `{ method, match, handler }` and writes only domain logic.
- **Expected payoff:** ~40-50 lines of HTTP plumbing removed per service; new stores get the lifecycle free;
  CORS/health/404 behavior is written once.
- **Estimated churn:** server-kit gains the helper; blob-store handlers reshaped into routes (~50-70 lines
  moved); session-store optionally migrated. Moderate, low risk (behavior preserved).

#### M-DC-015: Shared `raceTimeout` abort+timeout utility
<!-- DC-015 -->
- **Target:** shared util (e.g. `packages/session` or a small shared module) + `apps/trevor-cli/src/platform.ts`,
  `apps/agent-host/src/connectivity/node-io.ts`
- **Rank:** Medium
- **Symptom:** Repeated boilerplate at callsites (#5) — the AbortController + timer + `finally`-clear protocol
  is re-implemented in two packages.
- **Evidence:** `trevor-cli/src/platform.ts:49-59` `fetchWithTimeout` and
  `agent-host/src/connectivity/node-io.ts:24-28` `withTimeout` both create an `AbortController`, abort after
  `ms`, run with the signal, and clear the timer in `finally`.
- **Proposed deeper boundary:** One `raceTimeout(fn(signal), ms)` util in a package both already depend on;
  both callers import it.
- **Expected payoff:** Abort/cleanup semantics live once; easy to add metrics/abort-reasons later.
- **Estimated churn:** new util + 2 callers. Low risk (pure extraction). (Medium: only 2 implementation sites.)

### Phase M: Medium-priority candidates

#### M-DC-003: Provider metadata registry behind `pi-key`
<!-- DC-003 -->
- **Target:** `apps/agent-host/src/providers/pi-key.ts` (+ `catalog.ts`, `protocol-anomaly.ts`)
- **Rank:** Medium
- **Symptom:** Thin wrappers (#1) + configuration sprawl (#6) + information leakage (#7).
- **Evidence:** `pi-key.ts:98-128` three near-identical factories (`deepseekProvider`,
  `glmProvider`, `minimaxProvider`). The `{id, piProvider, authName}` mapping is duplicated
  in `pi-key.ts`, `catalog.ts:54-66` (SOURCES), and `protocol-anomaly.ts:36-66` (RULES).
- **Proposed deeper boundary:** One provider-registry constant (id, piProvider, authName,
  env var, default model); a single parameterized factory reads it; the three named factories
  shrink to one-line lookups. Catalog and anomaly rules read the same registry.
- **Expected payoff:** Adding a pi-ai provider edits one registry, not three modules; removes
  cross-module duplication of provider config.
- **Estimated churn:** ~1 file refactored, 2 readers re-pointed. Low risk (signatures unchanged).

#### M-DC-004: Finish deprecating the `ToolGroup` wrapper
<!-- DC-004 -->
- **Target:** `apps/web/src/components/assistant-ui/tool-group.tsx`
- **Rank:** Medium
- **Symptom:** Thin wrapper (#1) — already `@deprecated`, composes three subcomponents.
- **Evidence:** `tool-group.tsx:182-200` `ToolGroupImpl` composes `ToolGroupRoot/Trigger/Content`
  and is marked deprecated, directing callers to compose directly. Still used at `thread.tsx:335`.
- **Proposed deeper boundary:** Complete the deprecation — remove `ToolGroup` and have the
  `thread.tsx` override compose the three subcomponents directly.
- **Expected payoff:** Removes a documented dead layer; subcomponents are composed where used.
- **Estimated churn:** 1-2 files. Low risk (deprecation already documented).

#### M-DC-005: Collapse the twin `ResumeModal` / `WorktreeModal` wrappers
<!-- DC-005 -->
- **Target:** `apps/web/src/resume/ResumeModal.tsx`, `apps/web/src/worktrees/WorktreeModal.tsx`
- **Rank:** Medium
- **Symptom:** Thin wrapper (#1) — two near-identical wrappers around `CommandModal`.
- **Evidence:** Both take ~7 props, `useMemo` a row list, hardcode footer hints, and forward
  nearly everything to `CommandModal` (`ResumeModal.tsx:30-56`, `WorktreeModal.tsx:30-56`).
  One callsite each: `PanelHost.tsx:408` and `:418`.
- **Proposed deeper boundary:** Let `CommandModal` accept a domain adapter (row builder +
  footer hints) directly; the two wrappers collapse into adapter configs at the callsite.
- **Expected payoff:** ~50 lines of mirrored boilerplate removed; `CommandModal` becomes the
  single entry point for domain-specific row choosers.
- **Estimated churn:** 3-4 files (both modals, `CommandModal`, `PanelHost`). Low risk
  (`CommandModal` already takes domain-agnostic rows).

#### M-DC-006: Remove the `richterTransport` pass-through
<!-- DC-006 -->
- **Target:** `packages/richter/src/client.ts`
- **Rank:** Medium
- **Symptom:** Thin wrapper (#1) + pass-through (#3) — entire public API forwards to one call.
- **Evidence:** `client.ts:11-13` `richterTransport(url) => streamTransport(url)`, 13 lines,
  1 export. Two callsites: `apps/web/src/session/use-session.ts:1`, `apps/agent-host/src/main.ts`.
- **Proposed deeper boundary:** Inline `streamTransport` at the two callsites; re-introduce a
  richter adapter only once it has real work (auth, cert pinning, telemetry, pooling).
- **Expected payoff:** Removes a zero-value seam; callsites name what they actually use.
- **Estimated churn:** Remove 13 lines + 2 callsite imports. No behavior change.

#### M-DC-010: Export a runtime `RECALL_KINDS` array from `packages/session`
<!-- DC-010 -->
- **Target:** `packages/session/src/recall.ts` (owner) + `apps/agent-host/src/tools/session-recall.ts`
- **Rank:** Medium
- **Symptom:** Information leakage (#7) — the recall-kind values exist as a type union in session and as
  a hardcoded runtime array in the host tool.
- **Evidence:** `packages/session/src/recall.ts:13` `type RecallKind = "user"|"assistant"|"tool"|"fold"`;
  `apps/agent-host/src/tools/session-recall.ts:18` `const KINDS = ["user","assistant","tool","fold"] as const`.
- **Proposed deeper boundary:** Export a `RECALL_KINDS` const array from `packages/session` (with the type
  derived from it); the tool imports it for its schema + validation.
- **Expected payoff:** Adding a recall kind updates the tool's schema/validation automatically; type and
  runtime list cannot drift.
- **Estimated churn:** 2 files. Low risk.

### Phase L: Low-priority candidates

#### M-DC-011: Import `PRODUCER_IDS` in host tests instead of hardcoding
<!-- DC-011 -->
- **Target:** `packages/session/src/identity.ts` (owner) + `apps/agent-host/src/agent/*.test.ts`
- **Rank:** Low (test-scope)
- **Symptom:** Information leakage (#7) — producer-id literals duplicated in test fixtures.
- **Evidence:** `identity.ts:32` `PRODUCER_IDS = { host:"trevor-host", web:"trevor-web" }`; hardcoded as
  `"trevor-host"`/`"trevor-web"` in `agent/compactor.test.ts:16-17`,
  `agent/history-projection.test.ts:25-26`, `agent/recall/corpus.test.ts:14-15`.
- **Proposed deeper boundary:** Test helpers import `PRODUCER_IDS.host`/`.web` from `@trevor/session`.
- **Expected payoff:** Fixtures stay in sync if producer ids are renamed. (Low: test-only.)
- **Estimated churn:** 3 test files. Negligible risk.

#### M-DC-016: Fold doctor status→color logic into `DOCTOR_STATUS_META`
<!-- DC-016 -->
- **Target:** `apps/web/src/components/chat/doctor/doctor-status.tsx` (owner) + `doctor-area-row.tsx`,
  `doctor-finding.tsx`
- **Rank:** Low
- **Symptom:** Information leakage (#7) + repeated boilerplate (#5) — the status→color switch is re-derived
  in multiple components even though `DOCTOR_STATUS_META` already centralizes status styling.
- **Evidence:** `doctor-status.tsx:22-51` `DOCTOR_STATUS_META`; `doctor-area-row.tsx:41-80` `spine()`/
  `iconTint()`/`factTint()`; `doctor-finding.tsx:9-18` `messageTint()` — all map error→red / warn→yellow /
  default→muted independently.
- **Proposed deeper boundary:** Add `spine`/`factTint` fields to `DOCTOR_STATUS_META`; the two components
  read from it and delete their local switch functions.
- **Expected payoff:** One source of truth for doctor status colors; icon/message/fact rendering cannot drift.
- **Estimated churn:** 3 files, 4 local functions removed. Negligible risk.

#### M-DC-017: One owner for doctor status→headline strings
<!-- DC-017 -->
- **Target:** `packages/session/src/doctor.ts` (owner) + `apps/web/src/components/chat/doctor/doctor-summary.tsx`
- **Rank:** Low
- **Symptom:** Information leakage (#7) — the status→headline mapping is declared identically on the
  host/shared side and the web side.
- **Evidence:** `packages/session/src/doctor.ts:196-201` `REPORT_HEADLINE` (used by the plain-text report)
  and `apps/web/src/components/chat/doctor/doctor-summary.tsx:9-14` `OVERALL_HEADLINE` (UI summary strip) are
  identical: `ok→"Healthy"`, `warn→"Degraded"`, `error→"Problems found"`, `not_checked→"Not checked"`.
- **Proposed deeper boundary:** Export a shared `DOCTOR_STATUS_HEADLINE` from `packages/session/src/doctor.ts`
  (rename `REPORT_HEADLINE`); the text report and the web summary both import it.
- **Expected payoff:** The copyable text report and the UI summary headline can't drift apart.
- **Estimated churn:** 1 export + 2 imports. Negligible risk.

#### M-DC-007: Inline the `useInventory` query-mapping hook
<!-- DC-007 -->
- **Target:** `apps/web/src/resume/use-inventory.ts`
- **Rank:** Low
- **Symptom:** Thin wrapper (#1) — maps a `useQuery` result to a trivial shape.
- **Evidence:** `use-inventory.ts:17-30` wraps `useQuery` and maps to `{ sessions, loading,
  error }` with trivial conditionals. One callsite: `App.tsx:213`.
- **Proposed deeper boundary:** Inline the mapping at the callsite, or export the query options
  and let the caller use `useQuery` + mapping directly.
- **Expected payoff:** Removes one indirection; the mapping is explicit where used.
- **Estimated churn:** 1 file. Negligible risk.

#### M-DC-008: Inline the `PanelControls` prop pass-through
<!-- DC-008 -->
- **Target:** `apps/web/src/components/panel/panel-controls.tsx`
- **Rank:** Low
- **Symptom:** Pass-through component (#3) — forwards ~10 props with one gating conditional.
- **Evidence:** `panel-controls.tsx:13-85` extracts 10 props and mostly forwards them
  (`SplitModelControl` + reasoning + thinking controls). One callsite: `App.tsx:730`.
- **Proposed deeper boundary:** Move the control grouping inline where `panelControls` is built
  in `App.tsx`; the grouping is layout-contextual, not a reusable abstraction.
- **Expected payoff:** Removes ~90 lines of prop forwarding; control wiring is visible in context.
- **Estimated churn:** 1-2 files. Low risk.

---

## Considered and rejected

Recorded so later passes don't re-surface them.

**Pass 2 confirmation:** a skeptical second re-audit of the `agent-host` agent loop / recall / context
and of the `tools` + `providers` internals (looking specifically for exposed-impl-in-signatures #9,
temporal decomposition #8, config sprawl #6, pass-through #3) returned NO NEW CANDIDATES. The host
internals are genuinely deep — orchestration steps are pure/testable, internal structures (`FoldPlan`,
SDK shapes) stay private, and threaded `deps`/`ctx` objects are real dependencies, not forwarded knobs.

**Pass 3 confirmation:** a skeptical re-audit of the web state flow (`App.tsx`, hooks, `use-session`,
panel bindings) found NO new candidates — `App.tsx` is dense but appropriately layered, prop bindings are
cohesive grouped view-models, and prop threading is narrow (no unused-intermediate drilling). The session
transport split (`envelope` → `stream-transport` → store emission) is decomposition by concern, not a
temporal anti-pattern. Web shell and transport chain are genuinely deep.

**Pass 4 confirmation:** a deep dive on all 17 `packages/session` modules (challenging the "cohesive"
verdict, focused on exposed-impl-in-signatures #9) found NO new candidates — constants are centralized
(`PRODUCER_IDS`, `RUNTIME_KIND`, `BREAKDOWN_CATEGORIES`, `DOCTOR_AREA_ORDER`), exports are `readonly`,
and consumers go through typed decoders, not raw payloads. The shared protocol package is deep.

**Pass 5 confirmation:** the final catch-all (`e2e`, `test-kit`, `richter`, `server-kit`, host root files)
found NO new candidates — these corners are well-factored. The doctor cross-surface check confirmed the
connectivity vocabulary (`InternetSnapshot`/`InternetStatus`/`isSnapshotStale`), `BREAKDOWN_CATEGORIES`,
and `DOCTOR_AREA_ORDER` are already owned by `packages/session` and imported by both host and web (deep).

Pass 1 rejections (still rejected):

- **`agent-host` agent loop / recall / context** — interfaces proportional to substantial
  private logic (recall engine, import expansion, turn scheduling). Deep, not shallow.
- **`agent-host` tools** — `defineTool` + `tools/shared.ts` already hide the
  registration/validation/output-capping protocol. `ProcessSupervisor` hand-rolls `Tool`
  intentionally (multi-action dispatch).
- **`providers/observation-store.ts`, `codex.ts`, `reasoning-policy.ts`, `error-classifier.ts`** —
  over-exported or thin-by-design (strategy pattern), but not shallow.
- **`packages/session`, `server-kit`, `test-kit`** — focused, cohesive; envelope vs
  stream-transport split is by concern, not temporal.
- **`assistant-ui/tooltip-icon-button.tsx`, `use-collapsible-disclosure.ts`,
  `panel/SidePanel.tsx`, `panel/PanelHost.tsx`** — wrappers that earn their keep (reuse,
  non-trivial logic, or cohesive grouped view-models).
- **`blob-store/src/server.ts`** — duplicates `cors`/`json`/`readBody` from `server-kit`, but
  it is a dependency-wiring gap, not a shallow boundary. Held; revisit if it re-surfaces with a
  clean information-leakage framing.

---

## Progress Report Accounting

Each candidate is one unchecked item in `progress-report.md`. A candidate is checked only
when its deepening has actually been implemented (via a separate `planner` redesign session) and
merged — not when it is merely recorded here. There is no current-cutoff sequencing: the backlog
is pick-any.

## How to act on a candidate

> To redesign one of these, run `planner` with the candidate (its `DC-NNN` block) as the brief.
> To instrument the new boundary once redesigned, run `observability` on the affected module.

## Decisions

Canonical candidate records are in `.plans/deepen/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "deepen"
```

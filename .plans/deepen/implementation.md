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

### Phase L: Low-priority candidates

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

## Considered and rejected (this pass)

Recorded so later passes don't re-surface them:

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

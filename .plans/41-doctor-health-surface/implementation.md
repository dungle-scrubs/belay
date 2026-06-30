# Doctor Health Surface - Implementation Plan

## 0. Hard Dependencies

- [x] `.plans/03-filesystem-root-taxonomy` defines Trevor storage roots so `/doctor` storage and root checks do not invent paths.
- [x] `.plans/17-loop-command-surface` defines immediate host-command behavior and keeps `/doctor` out of model-turn execution.
- [x] `.plans/13-telemetry-observability` defines diagnostic artifacts and telemetry hooks that `/doctor` may summarize without becoming raw telemetry output.
- [x] Existing `packages/session/src/doctor.ts` defines the shared `doctor.current` read model and report formatting helpers.
- [x] Existing `apps/agent-host/src/doctor` builds structured snapshots and bounded probes.
- [x] Existing `apps/agent-host/src/tools/doctor.ts` exposes the read-only model-facing `doctor` diagnostic tool.
- [x] Existing `apps/web/src/components/chat/doctor` renders a Storybook-backed Doctor panel from fixture snapshots.
- [ ] `.plans/09.1-mid-turn-model-switch` lets a turn switch model/reasoning mid-turn and records `model.switched`; Doctor's Session/Run and Providers/Models/Auth areas treat the active model/reasoning as mid-turn-mutable and may summarize a per-turn switch count, without becoming raw telemetry. <!-- D-006 -->

## Architecture

Trevor's Doctor surface is the user-facing health report for Trevor itself. It answers: what is healthy, what is degraded, what is broken, why it matters, and what the user can do next. It is separate from `host.debugInfo`: Doctor is structured diagnostics and repair guidance; debug info is sanitized runtime internals for inspection.

This is a rebaseline plan, not a greenfield build. V2 already has the main pieces:

- shared `DoctorSnapshot`, areas, findings, summary rollups, and copyable report formatting in `packages/session/src/doctor.ts`
- host snapshot builders and bounded probes under `apps/agent-host/src/doctor`
- `/doctor` command-result rendering through `apps/web/src/components/chat/doctor`
- a read-only model-facing `doctor` tool for Trevor health questions
- Storybook fixtures for healthy, degraded, stale, loading, long-path, mobile, tablet, and desktop states

The remaining work is to audit those pieces against the intended D-073 behavior, close gaps, harden validation, and make the surface complete across command variants, prompt guidance, and end-to-end behavior.

### Key Constraints

| Constraint | Impact |
|---|---|
| `/doctor` is a host-owned immediate command | It must not start a model turn and must be available when the model/provider path is unhealthy. |
| Default Doctor output is actionable, not raw | The default transcript result renders a health dashboard or concise report; raw JSON/details stay behind explicit affordances. |
| Probes are bounded and non-mutating | Each live check needs timeout behavior, clear `not_checked`/degraded findings, and no repair side effects. |
| Doctor and debug info are separate | `host.debugInfo` may expose sanitized internals; Doctor shows health, evidence, and next actions. |
| Storybook-first UI | New Doctor UI states are developed and reviewed in Storybook before live app wiring changes. |
| Prompt guidance is narrow | The model may use `doctor` for Trevor health/setup/failure questions, not routine coding context. |

### Boundaries

- `packages/session/src/doctor.ts` owns the protocol/read model, pure aggregation helpers, report formatting, and decode behavior.
- `apps/agent-host/src/doctor` owns live fact collection, snapshot assembly, probe timeout handling, and command variants.
- `apps/agent-host/src/tools/doctor.ts` owns the model-facing diagnostic tool over the same sanitized snapshot source.
- `apps/web/src/components/chat/doctor` owns presentation only: summary, filters, area rows, findings, actions, JSON/detail view, and responsive layout.
- Provider, storage, internet, MCP, LSP, hooks, update, and workspace integrations expose facts to Doctor through bounded read APIs. Doctor should not reach through those modules for private implementation details.

### Observability

Doctor is itself a user-visible observability surface. Implementation should make every check explainable without dumping internal objects:

- stable check/finding ids for regression tests and later support references
- per-check status, message, evidence, source, and next action
- probe timing and timeout classification in tests, with only bounded user-facing output in the snapshot
- optional raw/sanitized JSON view for explicit inspection and copied reports
- no secrets, credentials, raw environment dumps, or provider request bodies in findings or evidence

## Phases

### Phase 1: Rebaseline Current Doctor Behavior

**Goal:** The plan, tests, and current implementation agree on what Doctor already does and what remains.

**Gate from previous:** Hard dependencies above are present.

#### M1: Inventory Existing Doctor Surfaces

- **Dependencies:** Hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add or update a focused gap checklist test/document that names the required D-073 surfaces.
  2. GREEN: Map current files, command behavior, web rendering, and Storybook stories against the checklist.
  3. REFACTOR: Remove stale references that still describe Doctor as only a debug-style text dump.

#### M2: Freeze the Shared Snapshot Contract

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Assert stable area ids, finding ids, severity rollup, decode behavior, and copy-report formatting.
  2. GREEN: Adjust the shared session contract only where the audit finds drift from the intended health model.
  3. RED: Add redaction-oriented tests for report and JSON surfaces.
  4. GREEN: Ensure sanitized evidence is the only evidence available to web, copy, and tool output.
  5. REFACTOR: Keep aggregation helpers pure and owned by the session package.

### Gate 1-2

- [ ] Current-state audit is reflected in implementation notes and progress-report accounting.
- [ ] Snapshot contract tests cover stable ids, rollup, decode, report formatting, and redaction.
- [ ] No active plan text claims Doctor is still only a raw debug dump.

### Phase 2: Complete Health Checks and Probe Semantics

**Goal:** Doctor covers the intended health areas with bounded, non-mutating checks and useful next actions.

#### M3: Normalize Diagnostic Areas

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for the canonical area set: Core, Session/Run, Providers/Models/Auth, Internet, Tools/Search, Web/Docs, MCP, LSP, Hooks, Storage/Roots, Workspace, Updates/Version. Under `.plans/09.1-mid-turn-model-switch` the Providers/Models/Auth active model can change mid-turn and Session/Run may summarize the per-turn switch count. <!-- D-006 -->
  2. GREEN: Fill missing areas or mark them explicitly `not_checked` with a concise reason.
  3. RED: Add representative degraded/error cases for each area that can currently be observed.
  4. GREEN: Emit stable findings with labels, messages, evidence/source where useful, and next actions.
  5. REFACTOR: Keep area construction localized and avoid duplicate health vocabulary across host modules.

#### M4: Enforce Bounded Non-Mutating Probes

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Cover per-check timeout, overall timeout, dependency unavailable, and probe-threw cases.
  2. GREEN: Return degraded or `not_checked` findings without throwing the whole Doctor command.
  3. RED: Add tests proving `/doctor` does not perform repair or mutation.
  4. GREEN: Keep probes read-only and route repair guidance into `nextAction` only.
  5. REFACTOR: Make probe runner boundaries easy to inspect from tests.

### Gate 2-3

- [ ] Every canonical area has an intentional healthy/degraded/not-checked representation.
- [ ] Probe timeout and failure cases remain bounded.
- [ ] Doctor still succeeds when one probe fails.
- [ ] No Doctor check mutates app, provider, workspace, or storage state.

### Phase 3: Command, Tool, and Prompt Surfaces

**Goal:** `/doctor`, model-facing `doctor`, and command variants expose the same sanitized health report with the right defaults.

#### M5: Command Variants and Actions

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Cover default `/doctor`, `/doctor refresh`, `/doctor full`, `/doctor json`, and legacy/plain text fallback behavior where supported.
  2. GREEN: Implement or align parsing and output selection so the default stays dashboard-friendly.
  3. RED: Prove `/doctor` is an immediate host command that creates no model turn.
  4. GREEN: Wire refresh/copy/view JSON actions through host and web surfaces without broadening default output.
  5. REFACTOR: Keep variant parsing private to the Doctor command boundary.

#### M6: Model-Facing Diagnostic Guidance

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Add prompt/tool-description tests for when `doctor` is appropriate and inappropriate.
  2. GREEN: Ensure the model-facing tool returns formatted health guidance from the same snapshot source.
  3. RED: Add a regression showing normal coding tasks do not eagerly invoke Doctor as context gathering.
  4. GREEN: Keep tool metadata narrow: Trevor health, setup, connectivity, provider readiness, or failed turn diagnosis only.

### Gate 3-4

- [ ] Command variants are tested and documented.
- [ ] `/doctor` remains immediate and no-model-turn.
- [ ] Model guidance allows Doctor for Trevor health questions and discourages routine use.
- [ ] Default output remains concise and non-raw.

### Phase 4: Storybook-First Dashboard Hardening

**Goal:** The web Doctor panel is polished, responsive, edge-aware, and complete before live app reliance grows.

#### M7: Storybook State Matrix

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add missing stories for every required healthy, warning, error, stale, refreshing, missing-provider, offline, missing-tool, unavailable-MCP/LSP/hooks, storage-root, long-path, mobile, tablet, and desktop state.
  2. GREEN: Fill fixture snapshots using the shared Doctor contract, not ad hoc UI-only shapes.
  3. RED: Add interaction stories/tests for issues-only, evidence expansion, copy, refresh, JSON view, and next action.
  4. GREEN: Keep interactions visible and accessible in Storybook.
  5. REFACTOR: Keep fixtures realistic and reusable by tests.

#### M8: Responsive Dashboard Polish

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add jsdom or visual checks for long messages, paths, evidence, mobile width, tablet width, and desktop density.
  2. GREEN: Adjust layout so warnings/errors/next actions cannot be hidden by filters, overflow, or narrow viewports.
  3. RED: Cover copy report and JSON detail output with sanitized payloads.
  4. GREEN: Keep default dashboard quiet but actionable, with raw details behind explicit controls.
  5. REFACTOR: Preserve the established Trevor UI patterns and avoid nested card layouts.

### Gate 4-5

- [ ] Storybook covers the required state matrix.
- [ ] Responsive checks pass for mobile, tablet, and desktop.
- [ ] Accessibility and keyboard interaction for filters/details/actions are covered.
- [ ] Copy/JSON actions expose only sanitized snapshot data.

### Phase 5: End-to-End Validation and Documentation

**Goal:** Doctor is reliable as a real troubleshooting surface across app, host, command, and model-facing paths.

#### M9: E2E and Operator Documentation

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for `/doctor` with fake provider, degraded provider, offline internet, missing optional tools, and storage-root problems.
  2. GREEN: Make those scenarios render the dashboard or report with correct severity and next actions.
  3. RED: Add live-model-gated or provider-gated checks only where prerequisites can skip with stated reasons.
  4. GREEN: Keep live checks out of default CI unless explicitly gated.
  5. REFACTOR: Document how users and agents should read Doctor output and when to use `host.debugInfo` instead.

### Done Gate

- [ ] Unit, integration, web, and hermetic e2e tests pass for Doctor behavior.
- [ ] Storybook states are complete and reviewed.
- [ ] `/doctor` default, refresh/full/json, copy report, JSON view, and model-facing `doctor` behavior are covered.
- [ ] Redaction tests prove no secrets or raw internals leak through Doctor surfaces.
- [ ] The umbrella plan points here and no duplicate Doctor backlog remains active in `.plans/trevor-v2`.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Doctor becomes a noisy debug dump again | high | medium | Keep default dashboard/report concise; raw details behind explicit full/json/detail controls. | host + web |
| Live probes make Doctor slow or flaky | high | medium | Per-check and overall timeouts, non-throwing degraded findings, and hermetic tests. | host |
| Redaction drift leaks secrets | high | low | Shared sanitized snapshot contract and report/JSON redaction tests. | session + host |
| UI filters hide serious findings | medium | medium | Issues-only must keep all warn/error areas, with tests for visibility. | web |
| Model overuses the `doctor` tool | medium | medium | Narrow tool descriptions, prompt tests, and evals showing normal coding work does not invoke it. | provider |

## Escape Hatches

1. **If `/doctor full` is too broad for the cutoff:** keep only default and JSON view, and defer full output as an explicit follow-up.
2. **If a live dependency is too flaky to probe:** mark that area `not_checked` with a next action and expose raw health in `host.debugInfo` only.
3. **If Storybook visual automation is not ready:** keep Storybook fixtures as the review source and add focused jsdom/layout tests for overflow and visibility.

## Progress Report Accounting

The progress report is the resume state. It separates completed current-state dependencies from remaining cutoff blockers. Existing Doctor implementation files are counted only as hard dependencies/current state, not as completed milestones until the corresponding audit and validation work lands under this plan.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "41-doctor-health-surface"
```

## Validation Commands

```bash
pnpm test -- --project unit --run apps/agent-host/src/doctor packages/session/src/doctor.ts
pnpm test -- --project web --run apps/web/src/components/chat/doctor
pnpm test -- --project e2e --run e2e
pnpm storybook
```

## Decisions

Canonical decisions are in `.plans/41-doctor-health-surface/plan.db`.

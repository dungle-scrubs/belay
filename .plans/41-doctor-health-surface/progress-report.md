# Doctor Health Surface - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 7
- **Accepted/deferred follow-up:** 2
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Done - all milestones landed.

Rebaseline outcome: the existing Doctor surface (shared contract, host builders +
bounded probes, the `/doctor` command + variants, the model-facing tool, and the
web dashboard + stories) was audited, normalized, and hardened rather than
rewritten. Gate green in the worktree: `lint`, `typecheck`, and `test` (528 files,
4233 passed, 3 skipped for the gated live lane).

## Completed Current State / Hard Dependencies

- [x] `.plans/03-filesystem-root-taxonomy` defines Trevor storage roots so Doctor storage checks have canonical roots.
- [x] `.plans/17-loop-command-surface` defines immediate host-command behavior for `/doctor`.
- [x] `.plans/13-telemetry-observability` defines telemetry and diagnostic artifacts Doctor may summarize.
- [x] `packages/session/src/doctor.ts` defines the shared Doctor read model and report helpers.
- [x] `apps/agent-host/src/doctor` builds structured snapshots and bounded probes.
- [x] `apps/agent-host/src/tools/doctor.ts` exposes the read-only model-facing Doctor diagnostic tool.
- [x] `apps/web/src/components/chat/doctor` renders a Storybook-backed Doctor panel.

## Current Cutoff Blockers

### M1 - Inventory Existing Doctor Surfaces

- [x] RED: Add or update a focused gap checklist test/document that names the required D-073 surfaces.
- [x] GREEN: Map current files, command behavior, web rendering, and Storybook stories against the checklist.
- [x] REFACTOR: Remove stale references that still describe Doctor as only a debug-style text dump.

### M2 - Freeze the Shared Snapshot Contract

- [x] RED: Assert stable area ids, finding ids, severity rollup, decode behavior, and copy-report formatting.
- [x] GREEN: Adjust the shared session contract only where the audit finds drift from the intended health model.
- [x] RED: Add redaction-oriented tests for report and JSON surfaces.
- [x] GREEN: Ensure sanitized evidence is the only evidence available to web, copy, and tool output.
- [x] REFACTOR: Keep aggregation helpers pure and owned by the session package.

### Gate 1-2

- [x] Current-state audit is reflected in implementation notes and progress-report accounting.
- [x] Snapshot contract tests cover stable ids, rollup, decode, report formatting, and redaction.
- [x] No active plan text claims Doctor is still only a raw debug dump.

### M3 - Normalize Diagnostic Areas

- [x] RED: Add tests for the canonical area set.
- [x] GREEN: Fill missing areas or mark them explicitly `not_checked` with a concise reason.
- [x] RED: Add representative degraded/error cases for each area that can currently be observed.
- [x] GREEN: Emit stable findings with labels, messages, evidence/source where useful, and next actions.
- [x] REFACTOR: Keep area construction localized and avoid duplicate health vocabulary across host modules.

### M4 - Enforce Bounded Non-Mutating Probes

- [x] RED: Cover per-check timeout, overall timeout, dependency unavailable, and probe-threw cases.
- [x] GREEN: Return degraded or `not_checked` findings without throwing the whole Doctor command.
- [x] RED: Add tests proving `/doctor` does not perform repair or mutation.
- [x] GREEN: Keep probes read-only and route repair guidance into `nextAction` only.
- [x] REFACTOR: Make probe runner boundaries easy to inspect from tests.

### Gate 2-3

- [x] Every canonical area has an intentional healthy/degraded/not-checked representation.
- [x] Probe timeout and failure cases remain bounded.
- [x] Doctor still succeeds when one probe fails.
- [x] No Doctor check mutates app, provider, workspace, or storage state.

### M5 - Command Variants and Actions

- [x] RED: Cover default `/doctor`, `/doctor refresh`, `/doctor full`, `/doctor json`, and legacy/plain text fallback behavior where supported.
- [x] GREEN: Implement or align parsing and output selection so the default stays dashboard-friendly.
- [x] RED: Prove `/doctor` is an immediate host command that creates no model turn.
- [x] GREEN: Wire refresh/copy/view JSON actions through host and web surfaces without broadening default output.
- [x] REFACTOR: Keep variant parsing private to the Doctor command boundary.

### M6 - Model-Facing Diagnostic Guidance

- [x] RED: Add prompt/tool-description tests for when `doctor` is appropriate and inappropriate.
- [x] GREEN: Ensure the model-facing tool returns formatted health guidance from the same snapshot source.
- [x] RED: Add a regression showing normal coding tasks do not eagerly invoke Doctor as context gathering.
- [x] GREEN: Keep tool metadata narrow.

### Gate 3-4

- [x] Command variants are tested and documented.
- [x] `/doctor` remains immediate and no-model-turn.
- [x] Model guidance allows Doctor for Trevor health questions and discourages routine use.
- [x] Default output remains concise and non-raw.

### M7 - Storybook State Matrix

- [x] RED: Add missing stories for every required healthy, warning, error, stale, refreshing, missing-provider, offline, missing-tool, unavailable-MCP/LSP/hooks, storage-root, long-path, mobile, tablet, and desktop state.
- [x] GREEN: Fill fixture snapshots using the shared Doctor contract, not ad hoc UI-only shapes.
- [x] RED: Add interaction stories/tests for issues-only, evidence expansion, copy, refresh, JSON view, and next action.
- [x] GREEN: Keep interactions visible and accessible in Storybook.
- [x] REFACTOR: Keep fixtures realistic and reusable by tests.

### M8 - Responsive Dashboard Polish

- [x] RED: Add jsdom or visual checks for long messages, paths, evidence, mobile width, tablet width, and desktop density.
- [x] GREEN: Adjust layout so warnings/errors/next actions cannot be hidden by filters, overflow, or narrow viewports.
- [x] RED: Cover copy report and JSON detail output with sanitized payloads.
- [x] GREEN: Keep default dashboard quiet but actionable, with raw details behind explicit controls.
- [x] REFACTOR: Preserve the established Trevor UI patterns and avoid nested card layouts.

### Gate 4-5

- [x] Storybook covers the required state matrix.
- [x] Responsive checks pass for mobile, tablet, and desktop.
- [x] Accessibility and keyboard interaction for filters/details/actions are covered.
- [x] Copy/JSON actions expose only sanitized snapshot data.

### M9 - E2E and Operator Documentation

- [x] RED: Add hermetic e2e coverage for `/doctor` with fake provider, degraded provider, offline internet, missing optional tools, and storage-root problems.
- [x] GREEN: Make those scenarios render the dashboard or report with correct severity and next actions.
- [x] RED: Add live-model-gated or provider-gated checks only where prerequisites can skip with stated reasons.
- [x] GREEN: Keep live checks out of default CI unless explicitly gated.
- [x] REFACTOR: Document how users and agents should read Doctor output and when to use `host.debugInfo` instead.

### Done Gate

- [x] Unit, integration, web, and hermetic e2e tests pass for Doctor behavior.
- [x] Storybook states are complete and reviewed.
- [x] `/doctor` default, refresh/full/json, copy report, JSON view, and model-facing `doctor` behavior are covered.
- [x] Redaction tests prove no secrets or raw internals leak through Doctor surfaces.
- [x] The umbrella plan points here and no duplicate Doctor backlog remains active in `.plans/trevor-v2` (umbrella retired; no duplicate Doctor backlog exists).

## Accepted / Deferred Follow-Up

- [ ] **D-010 per-model quantization/arch + capabilities in the Providers area.** The
  Providers/Models/Auth area reflects the live catalog at the SOURCE level
  (`SourceSummary`: ready/needs-setup counts, auth state, total model count) and
  residency (D-009) is fully surfaced in the Local-admission area (resident models,
  context caps, live claim counts, last eviction). Per-model quantization/arch and
  live capabilities live on `CatalogEntry`, which the doctor read boundary
  (`DoctorRuntimeFacts.catalog: SourceSummary[]`) does not carry; surfacing them
  would need a new per-model plumb and reads as chooser-surface detail rather than a
  health signal. Deferred as an intentional health-surface boundary, not a bug.
- [ ] **D-006 per-turn mid-turn-switch count in Session/Run.** The active model is
  mid-turn-mutable (09.1 merged), but the per-turn `switchCount` is a loop-local
  observability counter (logged behind the `agent` debug scope), not exposed to the
  doctor read boundary or the scheduler `debug()` snapshot. The "may summarize a
  per-turn switch count" requirement is optional; surfacing it needs new plumbing
  out of the turn loop and is deferred.

## Superseded / Obsolete Checklist Debt

None.

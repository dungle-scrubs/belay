# Doctor Health Surface - Progress Report

## Summary

- **Current cutoff blockers:** 62
- **Completed current work:** 7
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Inventory Existing Doctor Surfaces

## Completed Current State / Hard Dependencies

- [x] `.plans/03-filesystem-root-taxonomy` defines Trevor storage roots so Doctor storage checks have canonical roots.
- [x] `.plans/15-loop-command-surface` defines immediate host-command behavior for `/doctor`.
- [x] `.plans/16-telemetry-observability` defines telemetry and diagnostic artifacts Doctor may summarize.
- [x] `packages/session/src/doctor.ts` defines the shared Doctor read model and report helpers.
- [x] `apps/agent-host/src/doctor` builds structured snapshots and bounded probes.
- [x] `apps/agent-host/src/tools/doctor.ts` exposes the read-only model-facing Doctor diagnostic tool.
- [x] `apps/web/src/components/chat/doctor` renders a Storybook-backed Doctor panel.

## Current Cutoff Blockers

### M1 - Inventory Existing Doctor Surfaces

- [ ] RED: Add or update a focused gap checklist test/document that names the required D-073 surfaces.
- [ ] GREEN: Map current files, command behavior, web rendering, and Storybook stories against the checklist.
- [ ] REFACTOR: Remove stale references that still describe Doctor as only a debug-style text dump.

### M2 - Freeze the Shared Snapshot Contract

- [ ] RED: Assert stable area ids, finding ids, severity rollup, decode behavior, and copy-report formatting.
- [ ] GREEN: Adjust the shared session contract only where the audit finds drift from the intended health model.
- [ ] RED: Add redaction-oriented tests for report and JSON surfaces.
- [ ] GREEN: Ensure sanitized evidence is the only evidence available to web, copy, and tool output.
- [ ] REFACTOR: Keep aggregation helpers pure and owned by the session package.

### Gate 1-2

- [ ] Current-state audit is reflected in implementation notes and progress-report accounting.
- [ ] Snapshot contract tests cover stable ids, rollup, decode, report formatting, and redaction.
- [ ] No active plan text claims Doctor is still only a raw debug dump.

### M3 - Normalize Diagnostic Areas

- [ ] RED: Add tests for the canonical area set.
- [ ] GREEN: Fill missing areas or mark them explicitly `not_checked` with a concise reason.
- [ ] RED: Add representative degraded/error cases for each area that can currently be observed.
- [ ] GREEN: Emit stable findings with labels, messages, evidence/source where useful, and next actions.
- [ ] REFACTOR: Keep area construction localized and avoid duplicate health vocabulary across host modules.

### M4 - Enforce Bounded Non-Mutating Probes

- [ ] RED: Cover per-check timeout, overall timeout, dependency unavailable, and probe-threw cases.
- [ ] GREEN: Return degraded or `not_checked` findings without throwing the whole Doctor command.
- [ ] RED: Add tests proving `/doctor` does not perform repair or mutation.
- [ ] GREEN: Keep probes read-only and route repair guidance into `nextAction` only.
- [ ] REFACTOR: Make probe runner boundaries easy to inspect from tests.

### Gate 2-3

- [ ] Every canonical area has an intentional healthy/degraded/not-checked representation.
- [ ] Probe timeout and failure cases remain bounded.
- [ ] Doctor still succeeds when one probe fails.
- [ ] No Doctor check mutates app, provider, workspace, or storage state.

### M5 - Command Variants and Actions

- [ ] RED: Cover default `/doctor`, `/doctor refresh`, `/doctor full`, `/doctor json`, and legacy/plain text fallback behavior where supported.
- [ ] GREEN: Implement or align parsing and output selection so the default stays dashboard-friendly.
- [ ] RED: Prove `/doctor` is an immediate host command that creates no model turn.
- [ ] GREEN: Wire refresh/copy/view JSON actions through host and web surfaces without broadening default output.
- [ ] REFACTOR: Keep variant parsing private to the Doctor command boundary.

### M6 - Model-Facing Diagnostic Guidance

- [ ] RED: Add prompt/tool-description tests for when `doctor` is appropriate and inappropriate.
- [ ] GREEN: Ensure the model-facing tool returns formatted health guidance from the same snapshot source.
- [ ] RED: Add a regression showing normal coding tasks do not eagerly invoke Doctor as context gathering.
- [ ] GREEN: Keep tool metadata narrow.

### Gate 3-4

- [ ] Command variants are tested and documented.
- [ ] `/doctor` remains immediate and no-model-turn.
- [ ] Model guidance allows Doctor for Trevor health questions and discourages routine use.
- [ ] Default output remains concise and non-raw.

### M7 - Storybook State Matrix

- [ ] RED: Add missing stories for every required healthy, warning, error, stale, refreshing, missing-provider, offline, missing-tool, unavailable-MCP/LSP/hooks, storage-root, long-path, mobile, tablet, and desktop state.
- [ ] GREEN: Fill fixture snapshots using the shared Doctor contract, not ad hoc UI-only shapes.
- [ ] RED: Add interaction stories/tests for issues-only, evidence expansion, copy, refresh, JSON view, and next action.
- [ ] GREEN: Keep interactions visible and accessible in Storybook.
- [ ] REFACTOR: Keep fixtures realistic and reusable by tests.

### M8 - Responsive Dashboard Polish

- [ ] RED: Add jsdom or visual checks for long messages, paths, evidence, mobile width, tablet width, and desktop density.
- [ ] GREEN: Adjust layout so warnings/errors/next actions cannot be hidden by filters, overflow, or narrow viewports.
- [ ] RED: Cover copy report and JSON detail output with sanitized payloads.
- [ ] GREEN: Keep default dashboard quiet but actionable, with raw details behind explicit controls.
- [ ] REFACTOR: Preserve the established Trevor UI patterns and avoid nested card layouts.

### Gate 4-5

- [ ] Storybook covers the required state matrix.
- [ ] Responsive checks pass for mobile, tablet, and desktop.
- [ ] Accessibility and keyboard interaction for filters/details/actions are covered.
- [ ] Copy/JSON actions expose only sanitized snapshot data.

### M9 - E2E and Operator Documentation

- [ ] RED: Add hermetic e2e coverage for `/doctor` with fake provider, degraded provider, offline internet, missing optional tools, and storage-root problems.
- [ ] GREEN: Make those scenarios render the dashboard or report with correct severity and next actions.
- [ ] RED: Add live-model-gated or provider-gated checks only where prerequisites can skip with stated reasons.
- [ ] GREEN: Keep live checks out of default CI unless explicitly gated.
- [ ] REFACTOR: Document how users and agents should read Doctor output and when to use `host.debugInfo` instead.

### Done Gate

- [ ] Unit, integration, web, and hermetic e2e tests pass for Doctor behavior.
- [ ] Storybook states are complete and reviewed.
- [ ] `/doctor` default, refresh/full/json, copy report, JSON view, and model-facing `doctor` behavior are covered.
- [ ] Redaction tests prove no secrets or raw internals leak through Doctor surfaces.
- [ ] The umbrella plan points here and no duplicate Doctor backlog remains active in `.plans/trevor-v2`.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

# Assistant-UI Pattern Audit - Progress Report

**Plan:** `58.6-assistant-ui-pattern-audit`
**Stage:** ready for research implementation
**Current focus:** M1 - Documentation Corpus Map (3/3)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 29 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 29 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Documentation Corpus Map (3/3)

- [ ] RED: Create an audit worksheet under this plan's `artifacts/` directory with the categories
      from `llms.txt` and `llms-full.txt`, explicitly excluding virtualization by reference to plan
      58.4.
- [ ] GREEN: Read the relevant official markdown pages and summarize each pattern in one row with
      source URL, API/package names, maturity/stability notes, and whether it is UI-only, runtime,
      persistence, protocol, tool, or cloud.
- [ ] REFACTOR: Merge duplicate docs rows where a guide, primitive, UI component, and API reference
      all describe the same adoption decision.

### M2 - Trevor Equivalent Survey (4/4)

- [ ] RED: Add a second worksheet section that requires each row to cite a Trevor file, test, plan,
      or `CONTEXT.md` entry before it can receive an adoption verdict.
- [ ] GREEN: Survey `apps/web`, `apps/agent-host`, `packages/session`, `e2e`, and live numbered plans
      for each pattern's current owner.
- [ ] GREEN: Mark rows with no Trevor equivalent as `no current surface` rather than stretching a
      weak analogy.
- [ ] REFACTOR: Group rows by Trevor ownership boundary: transcript, composer, tools, artifacts,
      model selection, session/thread list, diagnostics, MCP, delegation/tangents, and future-only
      surfaces.

### M3 - Case-By-Case Adoption Recommendations (5/5)

- [ ] RED: Add an explicit verdict rubric to the worksheet: source-of-truth fit, local-first fit,
      accessibility, testability, bundle/runtime cost, API stability, and migration blast radius.
- [ ] GREEN: Fill the adoption matrix for every row in section 3 with the five-way verdict and
      rationale.
- [ ] GREEN: For every `adopt` or `adapt` verdict, add a follow-up candidate with a proposed numbered
      plan title, dependency, and smallest shippable slice.
- [ ] GREEN: For every `reject` verdict, state the architectural reason so it is not reopened as
      vague library skepticism.
- [ ] REFACTOR: Collapse weak recommendations. If a pattern only saves a few lines while weakening a
      Trevor invariant, mark it `keep Trevor-owned`.

### M4 - Highest-Leverage Follow-Up Plan Set (4/4)

- [ ] RED: Add a ranked shortlist section that limits immediate follow-ups to the few
      recommendations with clear payoff and low architectural risk.
- [ ] GREEN: Rank candidates by long-term simplicity, robustness, and product leverage, not
      development cost.
- [ ] GREEN: Identify conflicts with live plans, especially 58.2, 58.3, 58.4, 58.5, 50, and any plan
      that owns session/thread behavior.
- [ ] REFACTOR: Split `adopt UI primitive` candidates from `protocol/runtime migration` candidates
      so implementation plans do not mix unrelated risk classes.

### M5 - Validate Research Against Running Trevor UI (4/4)

- [ ] RED: Define a browser inspection checklist for the current Trevor UI surfaces that overlap
      assistant-ui: composer, slash/file menus, quote toolbar, model selector, tool rows, reasoning,
      markdown/diffs, attachments, session sidebar, context panel, and artifact panel.
- [ ] GREEN: Run the local app or Storybook and inspect the overlapping surfaces. Use Codex
      computer-use if browser automation is helpful.
- [ ] GREEN: Update any recommendation that looks wrong once the actual UI behavior is observed.
- [ ] REFACTOR: Attach screenshots or concise notes only when they change a verdict; avoid turning
      the plan artifact into a visual archive.

### M6 - Final Report And Plan Closure (5/5)

- [ ] RED: Add a final report under `artifacts/assistant-ui-pattern-audit.md` with the full matrix,
      ranked recommendations, rejected patterns, deferred patterns, and source links.
- [ ] GREEN: Cross-check the report against the assistant-ui docs index so no relevant pattern
      category is missing except virtualization.
- [ ] GREEN: Cross-check report recommendations against Trevor code/plans so every verdict has local
      evidence.
- [ ] GREEN: Record follow-up plan candidates in the progress report's accepted/deferred section.
- [ ] REFACTOR: Update `CONTEXT.md` only if the research introduces stable Trevor vocabulary that
      later plans should share.

## Current Cutoff Gate

- [ ] The final report includes every relevant assistant-ui docs category except thread virtualization.
- [ ] Every recommendation cites at least one assistant-ui source and one Trevor source, plan, or
      explicit `no current surface` finding.
- [ ] Every pattern has exactly one verdict: `adopt`, `adapt`, `keep Trevor-owned`, `defer`, or
      `reject`.
- [ ] Every `adopt` or `adapt` recommendation has a follow-up plan candidate with scope and
      dependency notes.
- [ ] Assistant Cloud, external hosted persistence, auth integrations, and runtime replacements are
      evaluated against Trevor's local-first protocol/storage ownership rather than treated as generic
      conveniences.
- [ ] Plan 58.4 remains the sole owner of assistant-ui thread virtualization.
- [ ] Running-UI inspection has either confirmed the high-leverage recommendations or corrected them.
- [ ] Planner progress and convergence checks pass.

## Accepted/Deferred Follow-Up

None yet. M4 and M6 will populate this section with concrete follow-up plan candidates discovered
during research.

## Superseded/Obsolete Checklist Debt

None.

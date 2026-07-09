# Assistant-UI Pattern Audit - Progress Report

**Plan:** `58.6-assistant-ui-pattern-audit`
**Stage:** ready for research implementation
**Current focus:** M1 - Documentation Corpus Map (4/4)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 32 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 32 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Documentation Corpus Map (4/4)

- [ ] RED: Create an audit worksheet under this plan's `artifacts/` directory with the categories
      from `llms.txt` and `llms-full.txt`, explicitly excluding virtualization adoption by reference
      to plan 58.4 while still noting any non-virtualization performance lessons from the
      virtualization docs.
- [ ] GREEN: Read the official markdown pages deeply enough to classify every `llms.txt` entry. Each
      entry must either receive its own comparison row, be grouped into a named comparison family, or
      be marked out of scope with a reason.
- [ ] GREEN: Summarize each compared pattern with source URL, API/package names, maturity/stability
      notes, performance claims or implications, and whether it is UI-only, runtime, persistence,
      protocol, tool, performance, or cloud.
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

### M3 - Case-By-Case Adoption Recommendations (6/6)

- [ ] RED: Add an explicit verdict rubric to the worksheet: source-of-truth fit, local-first fit,
      accessibility, testability, bundle/runtime cost, streaming and scroll performance, reconnection
      or resumability behavior, API stability, and migration blast radius.
- [ ] GREEN: Fill the adoption matrix for every row in section 3 with the five-way verdict and
      rationale.
- [ ] GREEN: For every high-value assistant-ui capability, especially performance-related
      capabilities, state why Trevor should adopt, adapt, keep, defer, or reject it. Tie each
      performance claim to a concrete Trevor surface and expected effect.
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

- [ ] RED: Add the final report at repo root as `ASSISTANT_UI_OPPORTUNITIES.md` with the full matrix,
      ranked recommendations, rejected patterns, deferred patterns, performance opportunities,
      source links, uncertainty notes, and contrarian-review prompts for later model passes.
- [ ] GREEN: Cross-check the report against the assistant-ui docs index so every docs page is
      accounted for as compared, grouped, or explicitly out of scope. Virtualization adoption remains
      delegated to plan 58.4, but broader performance lessons from that docs area must still be
      recorded.
- [ ] GREEN: Cross-check report recommendations against Trevor code/plans so every verdict has local
      evidence.
- [ ] GREEN: Record follow-up plan candidates in the progress report's accepted/deferred section.
- [ ] REFACTOR: Update `CONTEXT.md` only if the research introduces stable Trevor vocabulary that
      later plans should share.

## Current Cutoff Gate

- [ ] The final report exists at repo root as `ASSISTANT_UI_OPPORTUNITIES.md`.
- [ ] The final report accounts for every assistant-ui docs page from `llms.txt` as compared,
      grouped, or explicitly out of scope.
- [ ] The final report includes a dedicated performance opportunities section covering rendering,
      streaming, state management, reconnection/resumability, persistence, bundle/runtime cost, and
      scheduling where assistant-ui has relevant docs.
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
- [ ] The report preserves uncertainty and contrarian-review prompts for later model passes.
- [ ] Running-UI inspection has either confirmed the high-leverage recommendations or corrected them.
- [ ] Planner progress and convergence checks pass.

## Accepted/Deferred Follow-Up

None yet. M4 and M6 will populate this section with concrete follow-up plan candidates discovered
during research.

## Superseded/Obsolete Checklist Debt

None.

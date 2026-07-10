# Tool-Row Render Audit + ToolFallback - Implementation Plan

## 0. Hard Dependencies

- [x] Plan 58.6 (assistant-ui pattern audit) is complete; these are its second-tier
  Track A follow-ups (rows F5, F7). <!-- D-002 -->
- [ ] Plan 58.6.1 M2 lands `ToolMessage.startedAt` (sourced from `event.createdAt`)
  and the `useElapsedLabel` wiring for running tool rows. F7 reuses that field and
  hook instead of the vendored `useToolCallElapsed`, so F7 (M2 here) must land after
  58.6.1 M2. F5 (M1 here) has no such dependency. <!-- D-003 -->

## 1. Objective

Two second-tier adopt/adapt items from the 58.6 audit, both on the web tool-row
render path:

1. **F5 - null-until-complete audit.** Confirm every arm in the `TOOL_RENDERERS`
   registry returns null until its result is ready, so a row does not remount/churn
   as its arguments stream in. Fix any arm that does not. <!-- D-004 -->
2. **F7 - ToolFallback for the flat-text arms.** Trevor vendored
   `assistant-ui/tool-fallback.tsx` but it is dead; `mcp`, every `lsp_*`, and `bash`
   currently render through `renderOutput` as always-expanded, capped monospace text.
   Wire a collapsible Args/Result/Error block with a shimmer instead, cutting
   on-screen DOM for long tool output. <!-- D-001 -->

## 2. Relevant Surfaces (verified)

- `apps/web/src/components/chat/tool-message.tsx:361` - `TOOL_RENDERERS` registry
  (compile-time exhaustive over `ToolName`).
- `renderDiff` (`:105-110`) and `renderMultiEdit` (`:83-89`) already `return null`
  until complete - the reference behavior for F5.
- `renderOutput` (`:328`) - the arm used by `mcp` (`:393`), all `lsp_*`
  (`:396-401`), `bash` (`:406`), and most text tools; the F5 audit centers here.
- `apps/web/src/components/assistant-ui/tool-fallback.tsx` - vendored, currently dead.
  Two runtime couplings verified present:
  - `useToolCallElapsed` (`:6`, `:76`) - assistant-ui runtime elapsed hook.
  - `ToolFallbackApproval` (`:291-319`) - drives `addResult`/`resume`/
    `respondToApproval`, which have no effect outside the assistant-ui runtime.
- `apps/web/src/hooks/use-elapsed-label.ts` - Trevor's leaf clock (the replacement).

## 3. Milestones

### M1: Null-until-complete audit across TOOL_RENDERERS (F5)

**Testing:** test-first (render behavior under streaming status is behavior-bearing;
assert no premount output).

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. Seams under test: each `RenderArm` given an incomplete/streaming `status`.
  2. RED: Add tests asserting every arm (`renderOutput`, `renderDiff`,
     `renderMultiEdit`, and any others) renders nothing until its result/args are
     ready - a streaming-status render yields null, matching `renderDiff`/
     `renderMultiEdit`.
  3. GREEN: Fix any arm that emits partial/placeholder output mid-stream (guard it
     null-until-ready). If all arms already hold, record that as the finding and add
     the regression tests as the durable guard.
  4. REFACTOR: If the null-until-ready guard is duplicated per arm, hoist a shared
     helper so new arms inherit it.
  5. Verify: `pnpm --filter web test`.

### M2: ToolFallback for flat-text tool rows (F7)

**Testing:** test-after (frontend rendering; interaction/snapshot after wiring, with
a behavioral test for collapse/expand).

- **Dependencies:** M1 (new render path must honor null-until-complete), 58.6.1 M2
  (provides `ToolMessage.startedAt` + `useElapsedLabel` wiring). <!-- D-003 -->
- **Effort:** M
- **Tasks:**
  1. Strip the two couplings from the vendored `tool-fallback.tsx`: remove the
     `ToolFallbackApproval` sub-part (`:291-319`) and its `addResult`/`resume`/
     `respondToApproval` props; replace `useToolCallElapsed` (`:6`, `:76`) with
     `useElapsedLabel` fed by `ToolMessage.startedAt` (per 58.6.1 M2).
  2. Add a `renderFallback` arm: collapsible Args/Result/Error with a shimmer while
     running; must return null-until-complete per M1.
  3. Point the flat-text arms at it: replace `renderOutput` with `renderFallback` for
     `mcp`, `lsp_*`, and `bash` in `TOOL_RENDERERS` (keep `renderOutput` for the arms
     where always-expanded short text reads better; decide per-tool, do not blanket).
  4. RED/behavioral: test collapse/expand, running shimmer, and that a completed row
     shows its result.
  5. REFACTOR: ensure no dead assistant-ui-runtime props remain on the component.
  6. Verify: `pnpm --filter web test` + a story showing a long `lsp_diagnostics` /
     `mcp` result collapsed by default.

## 4. Non-Goals

- No structured/parsed MCP tables (that was audit item 4, dropped in 58.6.1 D-003);
  F7 renders the existing flat text inside a collapsible shell, it does not parse it.
- No change to the diff/multi-edit renderers beyond the F5 audit guard.
- No re-introduction of the assistant-ui runtime approval/addResult path.

## 5. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Stripping ToolFallbackApproval breaks a real approval path | medium | low | Trevor approvals run through its own surfaces, not this component (it is dead today); M2 task 1 confirms no live approval routes through it | impl |
| Collapsing tool output by default hides info users rely on | medium | medium | Collapse only the long flat-text arms; keep short-output arms on `renderOutput`; decide per-tool (task 3) | impl |
| F7 lands before 58.6.1 M2 and has no `startedAt` | medium | low | Hard dependency recorded (D-003); M2 gated on 58.6.1 M2 | impl |
| "All arms already null-safe" makes M1 look empty | low | medium | The regression tests are the deliverable even if no fix is needed | impl |

## 6. Validation Commands

```sh
pnpm --filter web test
pnpm --filter web typecheck
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.6.2-tool-fallback-and-render-audit"
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "58.6.2-tool-fallback-and-render-audit" --streak 3
```

## 7. Decisions

Canonical decisions are in `plan.db`.

- D-001: scope = F5 (null-until-complete audit) + F7 (ToolFallback for flat-text arms).
- D-002: numbered 58.6.2 (second-tier audit follow-ups).
- D-003: F7 strips two ToolFallback couplings and depends on 58.6.1 M2.
- D-004: F5 audits `renderOutput`; `renderDiff`/`renderMultiEdit` are the reference.

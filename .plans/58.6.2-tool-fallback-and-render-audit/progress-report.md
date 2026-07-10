# Progress Report - Tool-Row Render Audit + ToolFallback

**Plan:** `58.6.2-tool-fallback-and-render-audit`
**Stage:** ready for implementation
**Current focus:** M1 - Null-until-complete audit across TOOL_RENDERERS (4)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 10 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 10 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Null-until-complete audit across TOOL_RENDERERS (4)

- [x] RED: Tests asserting every `RenderArm` (`renderOutput`, `renderDiff`,
      `renderMultiEdit`, others) renders nothing under an incomplete/streaming status -
      matching `renderDiff` (`:110`) / `renderMultiEdit` (`:89`).
- [x] GREEN: Fix any arm that emits partial output mid-stream (guard null-until-ready);
      if all already hold, keep the regression tests as the durable guard. FINDING: all
      arms already hold - `renderDiff`/`renderMultiEdit` defer on `path`, and the flat-text
      arms hold a stable running row with no partial result. No code change; the 4 new
      tests in `tool-message.test.tsx` are the durable guard.
- [x] REFACTOR: Hoist a shared null-until-ready helper if the guard is duplicated. Not
      needed - each deferring arm guards on its own distinct arg shape (`path` vs
      `edits[].path`); no duplicated guard to hoist.
- [x] Verify: `pnpm --filter web test`.

### M2 - ToolFallback for flat-text tool rows (6)

- [x] Strip couplings from vendored `tool-fallback.tsx`: remove `ToolFallbackApproval`
      (`:291-319`) + its `addResult`/`resume`/`respondToApproval`; replace
      `useToolCallElapsed` (`:6`,`:76`) with `useElapsedLabel` fed by
      `ToolMessage.startedAt` (58.6.1 M2). Component now takes Trevor's own `ToolStatus`
      + `startedAt`; no assistant-ui runtime imports remain.
- [x] Add a `renderFallback` arm: collapsible Args/Result/Error + running shimmer;
      returns null-until-complete per M1 (Result block is undefined while running).
- [x] Point the flat-text arms at it - replace `renderOutput` with `renderFallback`
      for `mcp`, `lsp_*` (all 6), `bash`. Kept `renderOutput` for `grep`, `doctor`,
      `trevor_expert`, `migrate_claude_md`, `tool_script`, `task_list`, `skills_list`
      (short/already-preview-capped). Decided per-tool, no blanket swap.
- [x] RED/behavioral: test collapse/expand, running shimmer, completed-row result +
      error routing (4 new M2 tests in `tool-message.test.tsx`).
- [x] REFACTOR: remove any remaining assistant-ui-runtime props from the component -
      `ToolFallback` is a plain component; only `useElapsedLabel` + Trevor status remain.
- [x] Verify: `pnpm --filter web test` + a story showing a long `lsp_diagnostics` /
      `mcp` result collapsed by default (`tool.stories.tsx`: LspDiagnosticsCollapsed,
      McpCollapsed, FallbackRunning, FallbackError).

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

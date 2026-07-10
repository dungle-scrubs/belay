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

- [ ] RED: Tests asserting every `RenderArm` (`renderOutput`, `renderDiff`,
      `renderMultiEdit`, others) renders nothing under an incomplete/streaming status -
      matching `renderDiff` (`:110`) / `renderMultiEdit` (`:89`).
- [ ] GREEN: Fix any arm that emits partial output mid-stream (guard null-until-ready);
      if all already hold, keep the regression tests as the durable guard.
- [ ] REFACTOR: Hoist a shared null-until-ready helper if the guard is duplicated.
- [ ] Verify: `pnpm --filter web test`.

### M2 - ToolFallback for flat-text tool rows (6)

- [ ] Strip couplings from vendored `tool-fallback.tsx`: remove `ToolFallbackApproval`
      (`:291-319`) + its `addResult`/`resume`/`respondToApproval`; replace
      `useToolCallElapsed` (`:6`,`:76`) with `useElapsedLabel` fed by
      `ToolMessage.startedAt` (58.6.1 M2).
- [ ] Add a `renderFallback` arm: collapsible Args/Result/Error + running shimmer;
      returns null-until-complete per M1.
- [ ] Point the flat-text arms at it - replace `renderOutput` with `renderFallback`
      for `mcp`, `lsp_*`, `bash` (keep `renderOutput` where short always-expanded text
      reads better; decide per-tool, no blanket swap).
- [ ] RED/behavioral: test collapse/expand, running shimmer, completed-row result.
- [ ] REFACTOR: remove any remaining assistant-ui-runtime props from the component.
- [ ] Verify: `pnpm --filter web test` + a story showing a long `lsp_diagnostics` /
      `mcp` result collapsed by default.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

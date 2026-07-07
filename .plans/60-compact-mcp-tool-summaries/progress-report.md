# Compact MCP Tool Summaries - Progress Report

**Plan:** `60-compact-mcp-tool-summaries`
**Stage:** ready (authored; not yet implemented)
**Current focus:** M1 - Characterize the current gap (0/5)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 19 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 19 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All three milestones and the done gate are current-cutoff. Nothing is deferred or superseded.

---

## M1 - Characterize the Current Gap (0/5)

- [ ] RED: Add failing compact-summary tests showing gateway `mcp` calls currently lack summaries for
  `search`, `call`, `resources`, `prompt`, and `status`.
- [ ] GREEN: Confirm the failures are from missing `mcp` salient-argument handling, not compact row layout.
- [ ] RED: Add malformed and incomplete `mcp` arg cases that must not throw and must not render raw JSON.
- [ ] GREEN: Keep the current unknown-tool fallback test passing: no recognized salient field still returns
  `null`.
- [ ] REFACTOR: Group MCP fixture helpers in the compact-summary test so expected labels read as a table.

## M2 - Add Gateway-Aware Salient Labels (0/5)

- [ ] RED: Add direct `tool-args` coverage for the `mcp` gateway label helper or
  `salientToolArg("mcp", ...)` if that is the chosen public seam.
- [ ] GREEN: Implement `mcp` action label derivation in `apps/web/src/tool-args.ts` using only the safe,
  known schema fields.
- [ ] RED: Add tests for priority and fallback within `resources` and `prompt` labels (`name` before
  `server`, `server` before bare action where applicable).
- [ ] GREEN: Route `compactToolSummary("mcp", args)` through the shared salient path and existing truncation.
- [ ] REFACTOR: Keep string formatting small, pure, and isolated enough to reuse from future non-compact
  tool labels without importing React/UI code.

## M3 - Verify Compact Transcript Behavior (0/5)

- [ ] RED: Add or extend a compact transcript/row test showing a rendered `mcp` row includes both `mcp` and
  the action summary.
- [ ] GREEN: Wire any missing projection path so the row displays the new secondary text without layout
  changes.
- [ ] RED: Add a regression for malformed `mcp` args rendering a safe fallback row.
- [ ] GREEN: Ensure malformed args still produce an inspectable tool row and never crash compact rendering.
- [ ] REFACTOR: Remove duplicate test setup and keep MCP cases alongside existing per-tool compact summary
  coverage.

---

## Gate 1->done

- [ ] Gateway `mcp` compact rows show action-specific secondary text.
- [ ] Unknown tools without recognized salient args still render no noisy raw JSON.
- [ ] Malformed or incomplete `mcp` args do not throw.
- [ ] Focused web tests pass for `tool-args`, compact summary, and compact row/projection behavior.

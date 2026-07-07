# Compact MCP Tool Summaries - Progress Report

**Plan:** `60-compact-mcp-tool-summaries`
**Stage:** ready (authored; not yet implemented)
**Current focus:** Complete - focused verification passed (19/19)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 19 |
| Checked (done) | 19 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All three milestones and the done gate are current-cutoff. Nothing is deferred or superseded.

---

## M1 - Characterize the Current Gap (5/5)

- [x] RED: Add failing compact-summary tests showing gateway `mcp` calls currently lack summaries for
  `search`, `call`, `resources`, `prompt`, and `status`.
- [x] GREEN: Confirm the failures are from missing `mcp` salient-argument handling, not compact row layout.
- [x] RED: Add malformed and incomplete `mcp` arg cases that must not throw and must not render raw JSON.
- [x] GREEN: Keep the current unknown-tool fallback test passing: no recognized salient field still returns
  `null`.
- [x] REFACTOR: Group MCP fixture helpers in the compact-summary test so expected labels read as a table.

## M2 - Add Gateway-Aware Salient Labels (5/5)

- [x] RED: Add direct `tool-args` coverage for the `mcp` gateway label helper or
  `salientToolArg("mcp", ...)` if that is the chosen public seam.
- [x] GREEN: Implement `mcp` action label derivation in `apps/web/src/tool-args.ts` using only the safe,
  known schema fields.
- [x] RED: Add tests for priority and fallback within `resources` and `prompt` labels (`name` before
  `server`, `server` before bare action where applicable).
- [x] GREEN: Route `compactToolSummary("mcp", args)` through the shared salient path and existing truncation.
- [x] REFACTOR: Keep string formatting small, pure, and isolated enough to reuse from future non-compact
  tool labels without importing React/UI code.

## M3 - Verify Compact Transcript Behavior (5/5)

- [x] RED: Add or extend a compact transcript/row test showing a rendered `mcp` row includes both `mcp` and
  the action summary.
- [x] GREEN: Wire any missing projection path so the row displays the new secondary text without layout
  changes.
- [x] RED: Add a regression for malformed `mcp` args rendering a safe fallback row.
- [x] GREEN: Ensure malformed args still produce an inspectable tool row and never crash compact rendering.
- [x] REFACTOR: Remove duplicate test setup and keep MCP cases alongside existing per-tool compact summary
  coverage.

---

## Gate 1->done

- [x] Gateway `mcp` compact rows show action-specific secondary text.
- [x] Unknown tools without recognized salient args still render no noisy raw JSON.
- [x] Malformed or incomplete `mcp` args do not throw.
- [x] Focused web tests pass for `tool-args`, compact summary, and compact row/projection behavior.

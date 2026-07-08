# Inline-Agent Compact Exemption - Progress Report

**Plan:** `58.1-inline-agent-compact-exemption`
**Stage:** ready (authored; not yet implemented)
**Current focus:** Complete

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 15 |
| Checked (done) | 15 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All three milestones and the final gate are current-cutoff. No follow-up scope is accepted.

---

## M1 - Exempt inline-agent from compact mode (4/4)

- [x] RED: Add a `compact-display` test asserting `staysFullInCompact` returns `true` for an `inlineAgent` message and `isCompactEligible(inlineAgent)` returns `false`.
- [x] GREEN: Add `kind === "inlineAgent"` to `staysFullInCompact` so the discriminator exempts inline-agent delegations.
- [x] RED: Add a `virtual-transcript`/`transcript-row-view` test that, in compact mode, an inline-agent delegation with multiple children renders one `InlineAgentRow` per child (each clickable via `onOpen`), not a single `CompactRow` summary.
- [x] GREEN: Confirm the compact rendering branch now routes `inlineAgent` through the full `InlineAgentGroup` path (via the exemption); no extra wiring needed.

## M2 - Remove dead compact-inline-agent code (3/3)

- [x] RED: Add a characterization assertion (grep/import test) that `inlineAgentCompact`, `compactInlineAgentAction`, the `inlineAgent` case in `compactDisplayFor`, and the `inlineAgent` branch in `compactRowAction` no longer exist.
- [x] GREEN: Delete those four code paths and their dedicated tests.
- [x] REFACTOR: Collapse any compact-display test scaffolding that only existed for the inline-agent case; ensure `compactDisplayFor` has no `inlineAgent` arm.

## M3 - Spacing and visual verification (5/5)

- [x] RED: Add a spacing test that a full `inlineAgent` block adjacent to compact rows (tool/user) produces correct `compactLeadingGaps`/`compactAbove` boundaries - no doubled or missing gaps.
- [x] GREEN: Adjust compact-spacing logic only if the exemption introduces a gap regression; otherwise leave as-is.
- [x] RED: Add a Storybook story for inline-agent rows in compact mode showing one clickable subagent per line (single + parallel >=4) matching the normal-view story.
- [x] GREEN: Wire the story to the compact-mode flag so it exercises the exempted path.
- [x] REFACTOR: Share fixtures between the compact-mode and normal-view inline-agent stories so the two cannot drift.

## Gate 1 (done) (3/3)

- [x] All `web` project tests green (`compact-display`, `virtual-transcript`, `transcript-row-view`, `inline-agent-row`).
- [x] Storybook: compact-mode inline-agent story shows one clickable row per agent, identical to the normal view.
- [x] No references to `inlineAgentCompact`/`compactInlineAgentAction` remain.

# Live Output Scroll Parity - Progress Report

**Plan:** `58.3-tangent-transcript-scroll-parity`
**Stage:** implemented, awaiting merge authorization

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 42 |
| Checked (done) | 42 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

**Current focus:** Complete - implementation and verification finished on the feature branch.

---

## M1 - Characterize non-virtual live-output scroll behavior (5/5)

- [x] RED: Add a focused web/component characterization proving a non-virtual live-output surface at
      bottom follows when a new item is appended.
- [x] RED: Add a focused web/component characterization proving the same surface preserves `scrollTop`
      and visible item id when unpinned and a new item is appended.
- [x] RED: Add a focused web/component characterization proving streaming text/output growth preserves
      the visible anchor while unpinned.
- [x] GREEN: Extract or introduce the smallest shared live-scroll surface that passes those
      characterizations by reusing `createScrollFollowController` and `useScrollFollow`.
- [x] REFACTOR: Keep `VirtualTranscript`'s existing behavior intact while sharing only the reusable
      controller/DOM surface contract.

## M2 - Replace local bottom-follow copies in consuming surfaces (5/5)

- [x] RED: Add a test proving the shared scroll-to-bottom arrow is visible when a covered surface is
      unpinned and hidden when pinned.
- [x] GREEN: Move the jump-to-bottom button and unseen-content presentation into the shared live-scroll
      surface, preserving the main transcript's visual states where they apply.
- [x] RED: Add a test proving passive incoming updates do not re-pin after the user has scrolled up.
- [x] GREEN: Replace each covered surface's local `atBottom`, direct `scrollTop = scrollHeight`, and local
      arrow with the shared primitive.
- [x] REFACTOR: Make surface-specific components own only their domain chrome and content rendering.

## M3 - Tangent integration and UX polish (5/5)

- [x] RED: Add/extend tangent shell tests proving at-bottom follow, unpinned anchor preservation, and
      scroll-to-bottom arrow behavior.
- [x] GREEN: Wire `TangentShell` to the shared live-scroll surface; `LiveTangentShell` supplies only the
      shared scroll state and tangent turn data.
- [x] RED: Add a tangent shell test or story assertion for a bright `TANGENT` badge in the header.
- [x] GREEN: Replace the muted text-only header label with a brighter `TANGENT` badge and change the busy
      shimmer label from `Working in the tangent` to `Working...`.
- [x] REFACTOR: Keep tangent-specific rendering limited to header, source quote, turn row, fold-back, and
      composer concerns.

## M4 - Delegated subagent detail integration (5/5)

- [x] RED: Add `AgentDetailShell` tests proving child transcript append follows only when pinned and
      preserves the visible row while unpinned.
- [x] GREEN: Replace `AgentDetailShell`'s local `useBoolean(atBottom)`, `scrollRef`, direct scroll writes,
      and local arrow with the shared live-scroll surface.
- [x] RED: Add a test proving streaming child output growth uses the same revision signal without forcing
      a reader back to the bottom.
- [x] GREEN: Keep delegated detail non-virtualized but controller-backed; do not introduce
      `VirtualTranscript` unless a performance fixture requires it.
- [x] REFACTOR: Keep `LiveAgentDetail` as projection-only (`toTranscript` / `buildTranscriptRows`) and
      keep `AgentDetailShell` as read-only chrome plus row rendering.

## M5 - Tool and promoted-job detail integration (5/5)

- [x] RED: Add `ToolDetailView` tests proving growing shell/tool output follows only when pinned and
      preserves manual reading position while unpinned.
- [x] GREEN: Wrap the live detail body/output region in the shared live-scroll surface without changing
      `DetailBody` dispatch semantics.
- [x] RED: Add a promoted-job detail test proving live `job.tail` updates behave like running shell output.
- [x] GREEN: Keep `jobToDetailModel` projection unchanged; the scroll policy belongs in `ToolDetailView`.
- [x] REFACTOR: Ensure static tool details do not show unnecessary jump controls when content does not
      overflow.

## M6 - Deterministic browser reproduction and regression coverage (5/5)

- [x] RED: Add deterministic browser scenarios for tangent, delegated subagent detail, and tool/job detail
      with enough mixed-height content to overflow each scroll well.
- [x] GREEN: Instrument those scenarios to capture `scrollTop`, `scrollHeight`, `clientHeight`, bottom
      distance, visible item ids where applicable, and pinned/at-bottom state before and after
      append/stream actions.
- [x] RED: Assert that while unpinned, appending new items and growing streaming output do not change the
      visible anchor beyond a small pixel tolerance.
- [x] GREEN: Make the browser scenarios pass using the shared live-scroll surface.
- [x] REFACTOR: Align the browser helper names with existing transcript scroll tests so future main,
      tangent, agent-detail, and tool/job-detail scroll regressions share fixtures.

## Current-Cutoff Gates

- [x] Gate 1->2: Main transcript scroll tests still pass unchanged.
- [x] Gate 1->2: Shared non-virtual live-scroll component tests prove append and streaming growth preserve
      the viewport while unpinned.
- [x] Gate 1->2: No covered surface has a tangent/agent/tool-specific bottom-follow state machine.
- [x] Gate 2->3: Tangent has the shared jump arrow, `TANGENT` badge, and `Working...` copy.
- [x] Gate 2->3: Delegated subagent detail uses the shared live-scroll primitive and remains
      non-virtualized.
- [x] Gate 2->3: Tool detail and promoted-job detail share the same live-output scroll behavior.
- [x] Gate 2->3: No unrelated transcript row styling changes are included.
- [x] Final: `pnpm lint`
- [x] Final: `pnpm typecheck`
- [x] Final: Relevant `pnpm test --project web` tests for live-scroll, tangent, agent-detail, and
      tool-detail behavior.
- [x] Final: Browser E2E live-output reproduction showing before/after scroll metrics for at-bottom follow
      and unpinned anchor preservation across tangent, delegated subagent detail, and tool/job detail.
- [x] Final: Manual visual check confirms the `TANGENT` badge and shared scroll-to-bottom arrow are
      legible in each covered takeover.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

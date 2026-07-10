# Progress Report - Assistant-UI Audit Follow-Ups

**Plan:** `58.6.1-assistant-ui-audit-followups`
**Stage:** ready for implementation
**Current focus:** M1 - Prune the dead assistant-ui markdown stack (6)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 18 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 18 |
| Accepted/deferred follow-up | 2 |
| Superseded/obsolete | 1 |

## Current Cutoff

### M1 - Prune the dead assistant-ui markdown stack (6)

- [ ] RED: Characterization test/story - the live reasoning path renders through `MarkdownBody`
      (the `marked` stack) via `chat/reasoning-trace.tsx`, proving the prune does not touch live
      rendering.
- [ ] GREEN: Delete `assistant-ui/thread.tsx`, `assistant-ui/markdown-text-lazy.tsx`,
      `assistant-ui/markdown-text.tsx`.
- [ ] GREEN: Trim `assistant-ui/reasoning.tsx` - drop `MarkdownText` import (`:16`), `ReasoningImpl`
      (`:315`), the `Reasoning` memo + export (`:351-355`), and the unused
      `ReasoningMessagePartComponent` type import (`:15`); KEEP `ReasoningGroup`/`reasoningVariants`.
- [ ] GREEN: Remove `remark-gfm` from `apps/web/package.json`; reduce `@assistant-ui/react-markdown`
      to a type-only dependency (`SyntaxHighlighterProps` in `diff-viewer.tsx:4`).
- [ ] REFACTOR: Confirm `preload-on-idle.ts` stays (used by `diff-viewer-lazy.tsx`); verify the
      `marked`-stack render path is untouched.
- [ ] Verify: `pnpm --filter web typecheck` + `build`; bundle check that the `markdown-text` /
      `remark-gfm` chunk no longer ships.

### M2 - Running-tool elapsed clock (6)

- [ ] RED: Failing projector test - a `tool.started` event yields a `ToolMessage` whose `startedAt`
      equals `Date.parse(event.createdAt)`; a malformed `createdAt` leaves `startedAt` undefined.
- [ ] GREEN: Add `startedAt?: number` to `ToolMessage` (`transcript.ts:63`).
- [ ] GREEN: Populate it in the `tool.started` fold (`transcript.ts:1039-1046`) via
      `Date.parse(event.createdAt)` with the `Number.isNaN` guard.
- [ ] GREEN: Thread `startedAt` through `chat/tool-message.tsx` → `StatusAwareToolRendererProps` →
      the running-branch `ActionShimmer` (`status-aware-tool-renderer.tsx:70`), only while running.
- [ ] REFACTOR: De-duplicate the `Date.parse(createdAt)`+guard against the `InlineAgent` fold if a
      shared helper reads cleaner.
- [ ] Verify: story/snapshot of a running tool row rendering the elapsed meta; completed rows
      unaffected.

### M3 - assistant-ui dependency governance (6)

- [ ] GREEN: Pin `@assistant-ui/react` + `@assistant-ui/react-markdown` to exact versions in
      `apps/web/package.json` (drop carets); update the lockfile.
- [ ] RED: Render smoke tests - reasoning-trace row and the tool diff / multi-edit-diff viewers
      render their expected structure (the tests that must survive an assistant-ui bump).
- [ ] GREEN: Add the stability-ledger table to `CONTEXT.md` (every live assistant-ui import with its
      stability tier + pin).
- [ ] GREEN: Add an `assistant-ui add --dry` vendored-component drift check over
      `components/assistant-ui/`.
- [ ] REFACTOR: Cross-link the ledger from the vendored dir so the next editor finds the policy.
- [ ] Verify: `pnpm --filter web test` green; `pnpm install` clean against the exact pins.

## Accepted/Deferred Follow-Up

- **Structured MCP result rows** (audit item 4, D-003): deferred. Not this plan - needs a tool-result
  contract change or fragile parsing. Revisit only as its own read-only MCP status-panel plan over
  `statusSnapshot()` if a real need appears.
- **Audit Track B** (ExternalStore adapter spike, persistence/thread-adapter mapping study):
  research-only, sequenced against live plan 50; out of scope here.

## Superseded/Obsolete Checklist Debt

- ~~Content-visibility paint-skipping (audit item 5)~~ - superseded by shipped 58.4 virtual
  transcript, which already unmounts off-screen rows (D-004). Not implemented; recorded so it is not
  reopened.

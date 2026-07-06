# 09.4 Inline-Agent Transcript Row — Progress Report

**Stage:** ready

**Current focus:** Phase 1 · M1 (first RED — single inline-agent row story/test, no `└`, distinct from tool cards)

Implementation resume state. Milestones ordered by phase; check each box as its behavior lands
(not batched at the end). All items are current-cutoff blockers — no deferred/superseded buckets yet.

## Summary

- **Milestones:** 7 (M1, M7 in Phase 1; M2 in Phase 2; M3–M6 in Phase 3)
- **Current-cutoff tasks:** 33 total · 0 checked · 33 remaining
- **Deferred/superseded:** none

---

## Phase 1 — Web-only inline-agent surface (Storybook-first)

### M1 — InlineAgentRow / InlineAgentGroup component (presentational)

- [ ] RED: story + test — single running inline agent renders `agent · model · thinking · (elapsed · ↓ tokens)` as a bare row (no `└`), distinct from a tool-call row
- [ ] GREEN: implement `InlineAgentRow` (props in), full variant
- [ ] RED: story + test — parallel agents render under a header with the `└` tree-indent (reused from `tasks-panel.tsx:45`); 1 = no glyph, N = grouped
- [ ] GREEN: implement `InlineAgentGroup` grouping + shared indent helper
- [ ] RED: story + test — status tones running/done/failed/interrupted, and the compact variant
- [ ] GREEN: implement tones + compact variant
- [ ] REFACTOR: extract shared glyph/indent helper with `tasks-panel`; module comment on the new file

### M7 — Elapsed-timer drift fix (shared hook)

- [ ] RED: reproduce — test asserting `useElapsedLabel` advances ~1s per real second; pin the actual cause
- [ ] GREEN: fix the drift at its root in the shared hook
- [ ] REFACTOR: confirm turn-status header + inline row read the corrected timer; no double-ticking

**Gate 1→2:** M1 + M7 stories/tests pass; row + group render from fixtures (full + compact); timer at wall-clock.

---

## Phase 2 — Protocol + host live metadata

### M2 — delegated.to payload extension + host stamping/mirror

- [ ] RED: protocol test — `events.delegatedTo` round-trips optional `model`, `reasoningLevel`, `tokens`; decode test
- [ ] GREEN: extend the `delegated.to` payload (optional, backward-compatible)
- [ ] RED: host test — `seedChildSession` stamps `model` + `reasoningLevel` on the running link (inline only); background unchanged
- [ ] GREEN: wire the stamping in `delegate.ts`
- [ ] RED: host test — throttled token mirror emits `delegated.to{running, tokens}` with the child's cumulative output tokens; terminal fold-back carries final tokens
- [ ] GREEN: implement the throttled, running-only token mirror + final-token fold-back
- [ ] REFACTOR: consolidate the mirror; assert no mirror for background children

**Gate 2→3:** protocol round-trips new fields; a real inline delegation stamps model/reasoning + streams throttled tokens; background delegation unchanged.

---

## Phase 3 — Web wiring (projection, panel, status line, details)

### M3 — Transcript projection + tool-chip suppression

- [ ] RED: `transcript.ts` test — inline link reduces to an `inlineAgent` message with `agent/model/reasoningLevel/tokens/startedAt/status`; parallel children from one `parentRunId` group into one block; running→terminal advances the same block
- [ ] GREEN: add `InlineAgentMessage` + inline grouping in the reducer
- [ ] RED: test — `delegate_inline`/`delegate_background` tool call is suppressed (no tool-card row); `mode:"background"` still renders the existing block
- [ ] GREEN: suppress the delegation tool-call rows; route inline→new row, background→existing block
- [ ] REFACTOR: naming/dedupe; retire the inline branch of the old delegation renderer

### M4 — Support panel — inline excluded from BACKGROUND

- [ ] RED: `support-panel` test — `runningSubagents` returns only `mode === "background"`; a running inline child is absent; background present
- [ ] GREEN: add the mode filter in `runningSubagents` (`support-panel.ts:142`); verify the `subagents` prop path in `app.tsx:607`
- [ ] REFACTOR: update the panel doc comment (BACKGROUND = async only)

### M5 — Turn-status headline

- [ ] RED: `derive.ts` test — running inline delegation yields `delegating to {agent}…`, never `running delegate_inline`
- [ ] GREEN: map the delegation tool to the friendly headline in `turnStatusHeaderFrom`
- [ ] REFACTOR: same friendly treatment at background-delegation start

### M6 — Details view — child live transcript takeover

- [ ] RED: story/test — clicking a row opens the detail-takeover (replaces transcript, back button upper-left) rendering the child session's transcript; running streams
- [ ] GREEN: new "agent" detail surface; subscribe the web to the child session by `childSessionId` on open; render via existing row components; back restores parent
- [ ] RED: test — done/failed/interrupted child detail shows the final transcript + result
- [ ] GREEN: implement terminal detail + subscription teardown on close
- [ ] REFACTOR: share takeover chrome with the tool-detail takeover; module comment on the new detail body

**Gate 3→done:** end-to-end in the app — one compact row (no chip, no purple block, not in BACKGROUND), `(elapsed · ↓ tokens)` at wall-clock, click → child live transcript with back button, parallel agents group with `└`, background delegation unchanged.

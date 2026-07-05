# 50 Live Turn-Status Header - Progress Report

**Stage:** ready

> **Current focus:** Phase 1 · M1 - `TurnStatusHeader` component + `↓` token cell

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 15 |
| Checked (done) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

Milestones: M1-M3 (3). All current-cutoff; web-only; no deferred or superseded
debt at authoring time.

---

## Phase 1 - Presentational header (Storybook-first)

### M1: `TurnStatusHeader` component + `↓` token cell

- [x] RED: `TurnStatusHeader` stories with a frozen `startedAt` -
      task-active (`Adding schemas and tests… (2m 37s · ↓ 2.6k tokens · thinking)`),
      no-task (`thinking (2m 37s · ↓ 2.6k tokens)`), tool-running
      (`reading src/foo.ts (12s · ↓ 340 tokens)`), no-tokens-yet (cell hidden)
      (`apps/web/src/components/chat/turn-status-header.stories.tsx`).
- [x] GREEN: Implement `TurnStatusHeader` (`{headline, startedAt, outputTokens?,
      state?}`): `·`-joined line, `↓` glyph, elapsed via `useElapsedLabel`, token
      cell hidden when `outputTokens` is undefined.
- [x] RED: Unit test the redundancy rule (state cell omitted when `state` equals
      the headline) and `↓`/`fmtTokens` formatting.
- [x] GREEN: Implement the redundancy + formatting rules.
- [x] REFACTOR: Extract `formatOutputTokenCell`; carry over `ActionShimmer`
      `aria-hidden`/`motion-reduce` a11y (lifted `useElapsedLabel` into the shared
      `hooks/use-elapsed-label.ts`, reused `ShimmerText`); module comment.

**Gate 1→2**

- [x] Storybook renders all four variants; token cell hidden when absent.
- [x] Redundancy rule and `↓` formatting unit-covered.

---

## Phase 2 - Live derive + pinned placement

### M2: `turnStatusHeaderFrom` derive + mount pinned + retire scrolling row

- [ ] RED: `turnStatusHeaderFrom(events, session)` fixture tests - task-active ->
      in-progress `activeForm`; no task -> `turnActionLabel`; tool-running ->
      tool-verb; `usage.output` from newest `assistant.progress`; `undefined`
      after `assistant.completed` (`apps/web/src/derive.test.ts`).
- [ ] GREEN: Implement the derive composing `activeTurnStartedAt`, `liveCallFrom`,
      `turnActionLabel` (active-turn `warm`/`streaming`/`steering` evidence),
      `tasksFrom(...).find(in_progress)`.
- [ ] RED: `panel-host` story/integration - pinned header above the task list for
      an active turn, absent after completion, and no `working` row appended to
      the transcript.
- [ ] GREEN: Mount `TurnStatusHeader` atop `SupportPanel`/`TasksPanel`
      (`panel-host.tsx:462`); remove the `working` row (`transcript-rows.ts`,
      `transcript-row-view.tsx`); relocate `esc to interrupt`.
- [ ] REFACTOR: One `activeTurn` selector driving header presence + interrupt
      affordance; module comments.

**Gate 2→3**

- [ ] Pinned header appears for active turns (task and no-task) and disappears on
      completion; exactly one live indicator.
- [ ] `esc to interrupt` works from its new home.

---

## Phase 3 - Rows to `subject`, edge cases, docs

### M3: Task rows render `subject` + edge cases + CONTEXT.md

- [ ] RED: `tasks-panel` stories/tests expect rows rendering `subject`; active
      row `subject` distinct from the header `activeForm` (no duplication).
- [ ] GREEN: Render `subject` in `tasks-panel.tsx:54` (fall back to `activeForm`
      only when `subject` is unset).
- [ ] RED: Edge-case tests - no-task fallback drops the trailing state cell; token
      cell hidden until first snapshot and monotonic within a turn; `motion-reduce`
      disables the shimmer.
- [ ] GREEN: Implement edge-case handling.
- [ ] REFACTOR: Consolidate `subject`/`activeForm` selection; add the
      `Live turn-status header vocabulary` entry to `CONTEXT.md`; module comments.

**Gate 3→done**

- [ ] Rows read `subject`; header reads `activeForm`; no duplicated text.
- [ ] No-task, no-tokens-yet, completed-turn, reduced-motion cases covered.
- [ ] `CONTEXT.md` vocabulary added.
- [ ] `pnpm typecheck` + `pnpm test --filter @trevor/web` green; Storybook
      baselines updated.

---

## Accepted / Deferred Follow-up

_None at authoring time._ An `↑` input/context-token cell and a
model-authored (checklist-independent) headline are Non-Goals for this plan,
noted as possible later directions, not deferred tasks.

## Superseded / Obsolete

_None._

# 50 Live Turn-Status Header - Progress Report

**Stage:** implemented (pending Storybook baseline regeneration - see note)

> **Current focus:** complete - M1-M3 implemented; `pnpm lint`/`typecheck`/`test`
> (web + unit) green.

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 15 |
| Checked (done) | 15 |
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

- [x] RED: `turnStatusHeaderFrom(events, {awaitingResponse})` fixture tests -
      task-active -> in-progress `activeForm`; no task -> `turnActionLabel`;
      tool-running -> tool-verb; `usage.output` from newest `assistant.progress`;
      `undefined` after `assistant.completed`; the awaiting gap still pins
      `Working` (`apps/web/src/derive.test.ts`).
- [x] GREEN: Implement the derive composing `activeTurnStartedAt`, a monotonic
      `liveOutputTokens` (same live-turn boundary as `liveCallFrom`, clamped max
      per R-3), `turnActionLabel`/`toolActionLabel` (active-turn evidence +
      running-tool verb), `tasksFrom(...).find(in_progress)`; `isTurnActive` is the
      shared active-turn predicate.
- [x] RED: `panel-host` integration - pinned header above the task list for an
      active turn (headline/`↓` cell/state), the `esc to interrupt` affordance from
      its new home, and none of it when no turn is active; `transcript-rows` no
      longer appends a `working` row; `transcript-row-view` renders no duplicate
      shimmer for a silent turn (ReasoningTrace kept).
- [x] GREEN: Mount `TurnStatusHeader` + `esc to interrupt` hint atop
      `SupportPanel`/`TasksPanel` (`panel-host.tsx`); remove the `working` row
      (`transcript-rows.ts`, `transcript-row-view.tsx`, `virtual-transcript.tsx`);
      neutralize the silent-assistant bare-shimmer fallback (R-4).
- [x] REFACTOR: `isTurnActive` is the one active-turn selector driving header
      presence (and thus the co-located interrupt affordance); module comments on
      the derive and the mount.

**Gate 2→3**

- [x] Pinned header appears for active turns (task and no-task) and disappears on
      completion; exactly one live indicator.
- [x] `esc to interrupt` surfaces from its new home (pinned region); the interrupt
      BEHAVIOR is the untouched global Escape handler.

---

## Phase 3 - Rows to `subject`, edge cases, docs

### M3: Task rows render `subject` + edge cases + CONTEXT.md

- [x] RED: `tasks-panel` stories/tests expect rows rendering `subject`; active
      row `subject` distinct from the header `activeForm` (no duplication);
      `support-panel-view` fixture updated to the `subject` text.
- [x] GREEN: Render `taskRowLabel(task)` in `tasks-panel.tsx` (`subject`, fall back
      to `activeForm` only when `subject` is unset).
- [x] RED: Edge-case tests - no-task fallback drops the trailing state cell
      (derive + component redundancy); token cell hidden until first snapshot and
      monotonic within a turn (derive clamp test); `motion-reduce` disables the
      shimmer (component test).
- [x] GREEN: Edge-case handling (the monotonic clamp lives in `liveOutputTokens`;
      the redundancy/hidden-cell rules in `TurnStatusHeader`).
- [x] REFACTOR: `taskRowLabel` is the one `subject`/`activeForm` selection helper
      (`tasks-display.ts`); reconciled the `Live turn-status header vocabulary`
      entry in `CONTEXT.md` (token cell = monotonic-max; retired working row noted
      in the action-status section); module comments.

**Gate 3→done**

- [x] Rows read `subject`; header reads `activeForm`; no duplicated text.
- [x] No-task, no-tokens-yet, completed-turn, reduced-motion cases covered.
- [x] `CONTEXT.md` vocabulary reconciled (section pre-existed from authoring).
- [x] `pnpm typecheck` + `pnpm test` (web + unit) green; Storybook baselines: see
      note below (container lane).

---

## Accepted / Deferred Follow-up

_None at authoring time._ An `↑` input/context-token cell and a
model-authored (checklist-independent) headline are Non-Goals for this plan,
noted as possible later directions, not deferred tasks.

## Superseded / Obsolete

_None._

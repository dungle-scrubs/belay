# 50 Live Turn-Status Header - Implementation Plan

A single live status line for the in-flight turn, pinned above the task
checklist, mirroring Claude Code's working indicator:

```
Adding schemas and tests…  (2m 37s · ↓ 2.6k tokens · thinking)
```

Three cells - a semantic **action headline**, and a parenthetical
**elapsed · ↓ output-tokens · engine-state** - composed from primitives Trevor
already ships. This is the "a + b" scope: the metrics parenthetical (a) plus the
gerund action headline (b). The task checklist (c) already exists and is
unchanged except for which text field its rows render.

## 0. Hard Dependencies

None. <!-- D-006 --> <!-- D-007 -->

Every input is already on the wire and every formatter already exists; this plan
composes them web-side. It is **not** a decimal off the in-flight `44.4`
(usage-limit events is a different, rate/quota feature). The substrate shipped in
retired plans **31** (`action-shimmer-status`: the `ActionShimmer` primitive,
`action-label.ts`, and the `activeForm` present-progressive task field) and **43**
(`usage-metrics-surface`: the `Usage` read model and `liveCallFrom`). Concretely:

- Elapsed: `activeTurnStartedAt(events)` + `formatElapsed(ms)` already render
  `Working (2m 37s · esc to interrupt)` live (`apps/web/src/derive.ts:756,92`;
  `apps/web/src/components/chat/action-shimmer.tsx:39`).
- Live output tokens: `liveCallFrom(events)` returns the newest in-flight
  `assistant.progress` `{usage}` until completion (`apps/web/src/transcript.ts:343`);
  `usage.output` + `fmtTokens` (`derive.ts:54`) already give `2.6k`.
- Engine state: `turnActionLabel(evidence)` yields `thinking`/`streaming`/
  `loading <model>`/`applying steering`, and `toolActionLabel` yields the tool
  verbs (`apps/web/src/action-label.ts:126,39`).
- Headline text: the in-progress task's **`activeForm`** - a model-authored
  present-progressive label already carried on `tasks.current`
  (`packages/session/src/protocol.ts:270`; rendered today at
  `apps/web/src/tasks-panel.tsx:54`).

## Architecture

<!-- D-004 --> The live indicator becomes **one pinned `TurnStatusHeader`** at the
top of the task-panel region above the composer (`SupportPanel` / `TasksPanel`,
mounted at `apps/web/src/components/panel/panel-host.tsx:462`), present for the
whole active turn even when the checklist has no rows. The checklist (when
present) hangs directly below it, reproducing the reference's unified block. The
scrolling `working`-row `ActionShimmer` (`transcript-rows.ts:75`,
`transcript-row-view.tsx:164`) is **retired as the live turn indicator** so there
is exactly one, and the `esc to interrupt` affordance it carried relocates to the
pinned region / composer (it is not dropped).

The header text is a **deterministic web-side projection** of already-structured
state - the same doctrine as `action-label.ts` (never a fuzzy match over prose):

```
                       tasks.current (activeForm | subject, status)
                       assistant.progress (usage.output)        ── all already
                       assistant.started.createdAt               on the session log
                       agent.state / streaming / tool calls
                                     │
                                     ▼
        turnStatusHeaderFrom(events, session)   ── pure derive, apps/web/src/derive.ts
                                     │
             ┌───────────────────────┼───────────────────────┐
        headline                  metrics                   state
   in-progress activeForm    elapsed (startedAt)      turnActionLabel
   else turnActionLabel      ↓ usage.output (fmtTokens)   (engine state)
                                     │
                                     ▼
                 <TurnStatusHeader/>  (pinned atop TasksPanel)
```

### Line contract

<!-- D-003 --> One line: `<headline>  (<elapsed> · ↓ <output> tokens · <state>)`,
`·` middle-dot separators (matching `ActionShimmer`), no `esc to interrupt` inside
the parenthetical.

| Cell | Source | Rules |
|------|--------|-------|
| **headline** | in-progress task `activeForm`, else `turnActionLabel` | <!-- D-001 --> gerund; the semantic *what*. |
| **elapsed** | `formatElapsed(now - activeTurnStartedAt)` | `2m 37s`; ticks every 1s (reuse `useElapsedLabel`). |
| **↓ tokens** | live `usage.output` via `liveCallFrom` + `fmtTokens` | <!-- D-002 --> per-turn output; `↓` = streamed down; **hidden until the first `assistant.progress`**; monotonic within a turn. |
| **state** | `turnActionLabel` (engine state) | <!-- D-003 --> the *how*; **rendered only when it differs from the headline** (dropped when the headline already is the state). |

### Headline vs. state - two axes, not duplication

<!-- D-001 --> <!-- D-005 --> The headline answers *what* (the task: "Adding
schemas and tests"); the trailing state answers *how* (the engine: "thinking").
To keep them visibly distinct - and to reproduce the reference, where the row read
the imperative "Add tools.json schemas and tests" while the headline read the
tighter gerund - **the checklist rows flip to render `subject`** (imperative) and
`activeForm` is reserved for the header. Both forms already exist on
`TaskSnapshot`; this is a pure web change, no new model output. When no task is
`in_progress`, the headline falls back to `turnActionLabel` and the redundant
trailing state cell is dropped (`thinking (2m 37s · ↓ 2.6k tokens)`), degrading
to `Working` when the stream offers no better evidence.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-006 --> Web-only; no host / protocol / storage change | All inputs (`tasks.current` activeForm/subject, `assistant.progress` usage, `assistant.started` createdAt) and formatters already exist. The plan adds a component, a derive, a `↓` glyph, and a text-field swap. |
| Headline quality depends on the model keeping `activeForm` fresh | The checklist stays authoritative (rows show `subject`); the header degrades to the deterministic `turnActionLabel` when no task is active (R-1). |
| `assistant.progress` is advisory and periodic | The `↓` cell shows the last-known value and stays hidden until the first snapshot; it must never decrease within a turn (R-3). |
| Retiring the scrolling `working` row removes where `esc to interrupt` lived | The affordance must be relocated to the pinned region / composer, not lost (R-2). |

### Boundaries

- **`turnStatusHeaderFrom` (new, `apps/web/src/derive.ts`) is the one projection.**
  It composes `activeTurnStartedAt`, `liveCallFrom`, `turnActionLabel`, and
  `tasksFrom(...).find(in_progress)` into `{headline, startedAt, outputTokens?,
  state?}`. Pure and fixture-tested; no rendering logic.
- **`TurnStatusHeader` (new, `apps/web/src/components/chat/`) is presentational.**
  Props in, line out; owns the `↓` glyph, the `·` join, the redundancy rule, the
  hidden-token-cell rule, and the shimmer/a11y behavior inherited from
  `ActionShimmer` (`aria-hidden` overlay announced once, `motion-reduce`).
- **`action-label.ts` stays the single owner of the state vocabulary.** The header
  reads it; it does not re-derive `thinking`/`streaming`/tool verbs.
- **The task list's data model, tools, and ordering are untouched.** Only
  `tasks-panel.tsx`'s rendered field changes (`activeForm` -> `subject`).

### Observability

UI-only (no runtime/transport/provider change), so the observability contract is
light: `turnStatusHeaderFrom` is a pure function whose Storybook fixtures are the
inspection surface (task-active, no-task, tool-running, no-tokens-yet,
turn-completed). No spans or structured failure events are warranted.

---

## Phases

### Phase 1: Presentational header (Storybook-first)

**Goal:** `TurnStatusHeader` renders the exact line from typed props, with the
`↓` cell, `·` join, redundancy rule, and hidden-token rule - proven in Storybook
before any wiring.

#### M1: `TurnStatusHeader` component + `↓` token cell

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add `TurnStatusHeader` stories (`apps/web/src/components/chat/turn-status-header.stories.tsx`)
     with a **frozen `startedAt`** for stable elapsed baselines (the
     `action-shimmer.stories.tsx` pattern): task-active
     (`Adding schemas and tests… (2m 37s · ↓ 2.6k tokens · thinking)`),
     no-task (`thinking (2m 37s · ↓ 2.6k tokens)`), tool-running
     (`reading src/foo.ts (0m 12s · ↓ 340 tokens)`), no-tokens-yet (cell hidden).
  2. GREEN: Implement `TurnStatusHeader` (props `{headline, startedAt,
     outputTokens?, state?}`): `·`-joined line, `↓` glyph before the abbreviated
     token count, elapsed via `useElapsedLabel`, hide the token cell when
     `outputTokens` is undefined.
  3. RED: Unit test the **redundancy rule** - the trailing state cell is omitted
     when `state` equals the headline - and token formatting (`fmtTokens`, the
     `↓` prefix).
  4. GREEN: Implement the redundancy + formatting rules.
  5. REFACTOR: Extract a `formatOutputTokenCell` helper; carry over
     `ActionShimmer`'s `aria-hidden`/`motion-reduce` a11y; add a module comment
     stating what the component owns.

### Gate 1→2

- [ ] Storybook renders all four variants; token cell hidden when absent.
- [ ] Redundancy rule and `↓` formatting are unit-covered.

### Phase 2: Live derive + pinned placement

**Goal:** The header is fed by live session state, pinned above the task list for
the whole active turn, and the scrolling `working` row is retired.

#### M2: `turnStatusHeaderFrom` derive + mount pinned + retire scrolling row

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add `turnStatusHeaderFrom(events, session)` fixture tests
     (`apps/web/src/derive.test.ts`): task-active -> headline = in-progress
     `activeForm`; no task -> headline = `turnActionLabel`; tool-running ->
     tool-verb headline; output tokens from the newest `assistant.progress`;
     `undefined` after `assistant.completed` (header absent post-turn).
  2. GREEN: Implement the derive by composing `activeTurnStartedAt`,
     `liveCallFrom`, `turnActionLabel` (assembling active-turn evidence -
     `warm`/`streaming`/`steering`), and `tasksFrom(...).find(in_progress)`.
  3. RED: Add a `panel-host` story/integration expectation that the pinned
     `TurnStatusHeader` renders above the task list during an active turn and is
     absent after completion, and that the transcript no longer appends a
     `working` row.
  4. GREEN: Mount `TurnStatusHeader` at the top of `SupportPanel`/`TasksPanel`
     (`panel-host.tsx:462`); remove the `working` row from `transcript-rows.ts`
     and `transcript-row-view.tsx`; relocate `esc to interrupt` to the pinned
     region / composer.
  5. REFACTOR: One `activeTurn` selector so header presence and the interrupt
     affordance can't drift; module comments on the derive and the header mount.

### Gate 2→3

- [ ] The pinned header appears for active turns (task and no-task) and
      disappears on completion; only one live indicator exists.
- [ ] `esc to interrupt` still works from its new home.

### Phase 3: Rows to `subject`, edge cases, docs

**Goal:** The checklist rows read `subject` so headline and row don't duplicate;
edge cases and vocabulary are settled.

#### M3: Task rows render `subject` + edge cases + CONTEXT.md

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Update `tasks-panel` stories/tests to expect rows rendering `subject`
     (imperative), with the active row's `subject` distinct from the header's
     `activeForm` (no duplicated text when both are visible).
  2. GREEN: Render `subject` in `tasks-panel.tsx:54` (fall back to `activeForm`
     only when `subject` is unset).
  3. RED: Add edge-case tests - no-task fallback drops the trailing state cell;
     token cell stays hidden until the first snapshot and never decreases within
     a turn; `motion-reduce` disables the shimmer.
  4. GREEN: Implement the edge-case handling.
  5. REFACTOR: Consolidate the `subject`/`activeForm` selection into one helper;
     add the `## Live turn-status header vocabulary` entry to `CONTEXT.md`; module
     comments.

### Gate 3→done

- [ ] Rows read `subject`; header reads `activeForm`; no duplicated text.
- [ ] No-task, no-tokens-yet, completed-turn, and reduced-motion cases covered.
- [ ] `CONTEXT.md` vocabulary added.
- [ ] `pnpm typecheck` + `pnpm test --filter @trevor/web` green; Storybook
      baselines updated.

---

## Non-Goals

- **A model-authored, checklist-independent headline** or a summarizer over the
  raw `thinking` stream. <!-- D-001 --> The headline reuses the existing
  `activeForm`; a new turn-headline protocol field is explicitly out of scope
  (that would be host + protocol + storage work).
- **Changing the task list's data model, tools, or ordering.** <!-- D-005 -->
  Only the rendered text field changes (`activeForm` -> `subject`).
- **An `↑` input-token counterpart.** v1 shows only `↓` output; an input/context
  cell is a possible later addition.
- **A usage dashboard / panel.** The existing `usage-summary` surface (session
  totals) is unchanged and distinct from this per-turn live cell.
- **The `assistant.limit` rate/quota signal** (plan `44.4`) - a different feature
  in a neighboring domain; keep the vocabulary distinct.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| R-1: model lets `activeForm` go stale, so the headline misdescribes the work | low | medium | Checklist rows (`subject`) stay authoritative; header degrades to deterministic `turnActionLabel` when no task is active | impl |
| R-2: retiring the scrolling `working` row drops the `esc to interrupt` affordance | medium | low | M2 explicitly relocates it to the pinned region / composer; covered by a story/test | impl |
| R-3: advisory `assistant.progress` makes the `↓` cell flicker or regress | low | medium | Show last-known, hide until the first snapshot, clamp monotonic within a turn; M3 test | impl |
| R-4: a second live indicator survives (pinned header + scrolling row) | medium | low | One `activeTurn` selector drives both header presence and row removal (M2 REFACTOR) | impl |

---

## Escape Hatches

1. **If pinned placement reads poorly with no active task:** keep the pinned
   header only when the panel is present and fall back to an inline header at the
   transcript tail for no-task turns (reintroduces the working-row site, header
   text unchanged).
2. **If the `activeForm` headline is too noisy in practice:** make the headline
   `turnActionLabel`-only and treat `activeForm` as an enhancement, without
   touching the metrics cells.

---

## Progress Report Accounting

See `progress-report.md`. Buckets: current-cutoff blockers (M1-M3 tasks); no
deferred or superseded debt at authoring time. Current focus starts at M1 RED.

---

## Validation Commands

```bash
pnpm typecheck
pnpm test --filter @trevor/web
pnpm --filter @trevor/web storybook   # visual baselines for the header variants
```

---

## Decisions

Canonical decisions live in `.plans/50-live-turn-status-header/plan.db`
(D-001…D-007). Query:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "50-live-turn-status-header"
```

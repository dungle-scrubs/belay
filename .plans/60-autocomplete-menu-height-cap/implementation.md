# Autocomplete Menu Height Cap - Implementation Plan

Cap the composer autocomplete menus (the `@` file-mention picker and the `/` slash
command menu) so a long match list scrolls inside a bounded popover instead of growing
upward off the top of the screen.

## 0. Hard Dependencies

None. This is a focused presentational fix over the shared `AutocompleteMenu` chrome in
`apps/web`. No protocol, host, or storage change.

## Architecture

Both composer autocomplete menus render through one shared component,
`apps/web/src/components/chat/autocomplete-menu.tsx`:

- `FileMentionMenu` (`file-mention-menu.tsx`) is a thin adapter that maps workspace file
  matches to rows and passes them to `AutocompleteMenu`.
- `CommandMenu` (`command-menu.tsx`) is the parallel adapter for slash commands.
- `PanelHost` (`apps/web/src/components/panel/panel-host.tsx`) positions both overlays
  `absolute inset-x-0 bottom-full z-20 mb-2` above the composer, so they grow upward.

Today `AutocompleteMenu` renders its rows in a plain `flex flex-col` with no max height
and no overflow; the outer popover is `overflow-hidden`, which clips but does not scroll.
A workspace with many files returns dozens of matches, so the `@` menu grows past the top
of the viewport and the top entries become unreachable. The slash menu has the same
defect, just less likely to trigger because the command set is small.

The target shape keeps positioning in `PanelHost` unchanged and fixes the shared chrome:
the row list becomes a bounded scroll container, while the empty/loading state and the
summary footer stay outside the cap.

<!-- D-001 --> The height cap and scroll live in the shared `AutocompleteMenu` chrome, not per-caller, so both the `@` file-mention and `/` slash menus are fixed by one edit and the chrome does not fork.

<!-- D-002 --> The row list uses a CSS-only `max-h-[60vh] overflow-y-auto` container. A viewport-relative `max-h` (not a fixed `h`) guarantees the menu can never reach the top of the screen regardless of window height, renders short lists at natural height (no empty box), and degrades gracefully on short viewports without runtime measurement.

<!-- D-003 --> Storybook is the primary verification surface: an `Overflow` story on each menu's story file reproduces and verifies the cap (many matches in a short frame) before app wiring, because the cap is a pure presentational concern of `AutocompleteMenu`.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Shared chrome stays the single owner | The cap is applied inside `AutocompleteMenu`, not duplicated in `FileMentionMenu` / `CommandMenu` or pushed to `PanelHost`. |
| Short lists render at natural height | Use `max-h`, not a fixed `h`, so a two-row menu is not an empty box. |
| Footer and empty state never scroll | The summary footer and the empty/loading state stay outside the scroll container so the footer stays pinned and an empty menu never gets a scrollbar. |
| Positioning is unchanged | `PanelHost`'s `absolute bottom-full` placement stays; the menu simply stops growing past the cap and scrolls internally. |
| No runtime measurement | The cap is pure CSS (viewport-relative), so no JS layout measurement, resize observer, or flip logic is introduced. |

### Boundaries

- **Chrome owner:** `apps/web/src/components/chat/autocomplete-menu.tsx` owns the row-list
  scroll container and the cap. This is the only production file changed.
- **Adapters:** `file-mention-menu.tsx` and `command-menu.tsx` are unchanged; they already
  hand rows to `AutocompleteMenu`.
- **Positioning owner:** `apps/web/src/components/panel/panel-host.tsx` keeps the
  `absolute bottom-full` overlay placement; no caller change.
- **Storybook owners:** `apps/web/src/components/chat/file-mention-menu.stories.tsx` and
  `command-menu.stories.tsx` own the `Overflow` visual regression stories.

### Observability

This work changes only visible menu sizing, not runtime/provider/transport behavior. The
UI-facing observability requirement is that a Storybook `Overflow` story clearly answers:

- the menu has a bounded height and does not exit its frame;
- the row list scrolls internally;
- the summary footer stays pinned below the scroll area;
- a short list still renders at natural height.

No new storage root, protocol event, or host diagnostics channel is introduced.

## Phases

### Phase 1: Bound And Scroll The Autocomplete Menu

**Goal:** A long autocomplete match list scrolls inside a bounded popover and never runs
off the top of the screen; short lists are unaffected.

**Gate from previous:** Existing `autocomplete-menu`, `file-mention-menu`, and
`command-menu` tests pass.

#### M1: Storybook Reproduction

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add an `Overflow` story to `file-mention-menu.stories.tsx` with many file matches (about 40) rendered inside a short frame, so the unbounded list visibly exits the frame before the fix.
  2. RED: Add the matching `Overflow` story to `command-menu.stories.tsx` with enough synthetic commands to overflow a short frame, proving the shared chrome (not just the file menu) has the defect.

#### M2: Cap And Scroll The Shared Chrome

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. GREEN: In `autocomplete-menu.tsx`, wrap the `role="listbox"` row container in a `max-h-[60vh] overflow-y-auto` scroll container, leaving the empty/loading state and the summary footer outside the cap.
  2. RED: Add a `web` project test (`autocomplete-menu.test.tsx`) that renders many rows and asserts the listbox element is scrollable (its `scrollHeight` exceeds its bounded client height) while the summary footer is a sibling outside the scroll container.
  3. RED: Add a test asserting a short list (fewer rows than the cap) is not forced to a fixed height - the popover renders at natural height with no internal scroll.
  4. GREEN: Pass both edge-case tests without changing any caller.
  5. REFACTOR: Keep the scroll container local to `AutocompleteMenu` so adapters and `PanelHost` consume an already-bounded popover.

#### M3: Verify In App

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. GREEN: Confirm `PanelHost` needs no change - the `absolute bottom-full` placement still works and the menu now stops at the cap and scrolls.
  2. REFACTOR: Update the `Overflow` story descriptions to document the cap behavior (`max-h-[60vh]`, pinned footer) as the intended steady state.

### Gate 1->done

- [ ] All Phase 1 milestone tests pass.
- [ ] `pnpm test` (unit + web) green; typecheck and lint green.
- [ ] Storybook `Overflow` stories show a bounded, scrolling menu with a pinned footer; short-list stories are unchanged.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| `60vh` feels wrong on some viewport | low | medium | `max-h` degrades gracefully; the value is one Tailwind class, trivial to tune post-review. | frontend |
| Scroll container breaks keyboard `aria-activedescendant` scrolling | medium | low | The listbox role and option ids are unchanged; if the active option is not auto-scrolled into view, follow up with `scrollIntoView` on the active option - but only if a test proves it is needed. | frontend |

## Escape Hatches

1. **If `60vh` is too short or too tall in practice:** the cap is a single Tailwind class on one container; tune it without touching structure.
2. **If the active option is not scrolled into view on arrow navigation:** add `scrollIntoView({ block: "nearest" })` on the active option element inside `AutocompleteMenu`, gated behind a failing test.

## Validation Commands

```bash
pnpm --filter @trevor/web test
pnpm --filter @trevor/web typecheck
pnpm --filter @trevor/web lint
# Storybook: Chat/FileMentionMenu > Overflow, Chat/CommandMenu > Overflow
```

## Decisions

Canonical decisions are in the plan database
(`.plans/60-autocomplete-menu-height-cap/plan.db`). Query with:

```bash
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "60-autocomplete-menu-height-cap"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.

# Keyboard Control - Implementation Plan (stub)

> **Status: intentionally light.** This plan holds a larger, still-cloudy
> keyboard-control direction. Most scope is undecided. It currently carries ONE
> concrete near-term milestone (M1) plus a design backlog (section 4) that must be
> fleshed out - through a design pass or the planner interview - before more
> milestones are committed. <!-- D-001 -->

## 0. Hard Dependencies

- [x] Plan 07 shortcut router is shipped: a single `window` keydown listener that
  normalizes `Mod`, applies focus guards, and dispatches to the frontmost eligible
  surface. Bindings register declaratively in `apps/web/src/shortcuts/registry.ts`.
- [x] `apps/web/HOTKEYS.md` is the authoritative ledger of what the app binds and
  what the browser/OS reserves across macOS/Windows/Linux. Any new binding must be
  checked against it and recorded there in the same change (its own stated rule).
  <!-- D-003 -->

## 1. Objective

Broaden keyboard operability of the Trevor web app toward a coherent
keyboard-control model. The end shape is not yet decided - this plan exists to
collect the direction, keep it anchored to `HOTKEYS.md` and the plan-07 router, and
ship self-contained keyboard wins as they crystallize. <!-- D-001 -->

## 2. Numbering and relationship to other work

- Fresh top-level integer `61` - keyboard control is its own feature area, not an
  assistant-ui-audit follow-up. The 58.6 audit only *seeds* it (row A10). <!-- D-002 -->
- Not to be confused with the shipped plan-07 shortcut router (the mechanism this
  plan builds on) or the older `25-keyboard-shortcuts` work.

## 3. Milestones (current cutoff)

### M1: Keyboard-navigable sidebar session menu (seed, audit A10)

**Testing:** test-after (frontend rendering + focus/roving-nav behavior; DOM/roving
assertions after wiring). <!-- D-004 -->

Today the sidebar session overflow menu (rename/archive/delete) is right-click-only
with no keyboard path. Give it a keyboard entry + roving arrow-key navigation,
consistent with the existing roving patterns in the app (e.g. the ask_user question
surface `makeChoiceNav`, the cmdk popovers). Consult `HOTKEYS.md` before binding any
key and update it in the same change.

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. Design check: pick the menu-open key + nav model against `HOTKEYS.md`
     (reuse an existing roving pattern; do not invent a new global chord unless the
     ledger proves it safe on all three platforms).
  2. Implement: a keyboard affordance to open the session overflow menu on the
     focused row, with arrow-key roving across its items and Enter/Escape to
     activate/dismiss; no change to the existing right-click path or the menu's
     appearance.
  3. Verify: a story/interaction test driving open → arrow → activate → escape via
     keyboard only; `HOTKEYS.md` updated with the new binding row.

## 4. Design backlog (to flesh out - NOT yet committed milestones)

Open questions for the larger keyboard-control direction. None of these is decided;
they are recorded so the plan can grow deliberately. Promote an item to a section-3
milestone only after its shape is agreed. <!-- D-001 -->

- **Scope of "keyboard control".** Full keyboard-driven navigation of every surface
  (transcript, sidebar, panels, tool rows)? A Vim-everywhere model beyond the
  composer? A command surface that can reach every action? Pick the ambition level.
- **Focus model.** Is there a global roving-focus / landmark-jump scheme across the
  app's regions, or per-surface focus only? How do keyboard focus and the existing
  `Mod`-router coexist?
- **Discoverability.** How does a user learn the keys - extend the `Mod+/` shortcuts
  help, an in-app cheat sheet generated from the router registry + `HOTKEYS.md`?
- **Cross-platform budget.** The genuinely-safe combo shortlist in `HOTKEYS.md` is
  small; a broad keyboard-control scheme may exhaust it. Does the model lean on
  modal/leader keys (e.g. a `g`-prefix "go to" leader) to avoid the modifier crunch?
- **Relationship to Vim mode.** Does keyboard control extend the existing Vim layer
  (`src/vim/`) or sit beside it?

## 5. Non-Goals

- No commitment to any specific keyboard-control model until section 4 is resolved.
- No new global chords that `HOTKEYS.md` does not clear on macOS + Windows + Linux.
- M1 does not change the existing right-click menu path or the menu's appearance.

## 6. Validation Commands

```sh
pnpm --filter web test
pnpm --filter web typecheck
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "61-keyboard-control"
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "61-keyboard-control" --streak 3
```

## 7. Decisions

Canonical decisions are in `plan.db`.

- D-001: deliberately-light stub; most scope undecided; design backlog in section 4.
- D-002: fresh integer 61 (own feature area, not a 58.6 decimal).
- D-003: `apps/web/HOTKEYS.md` is the authoritative combo ledger; consult + update it.
- D-004: M1 seed = keyboard-navigable sidebar session menu (audit A10).

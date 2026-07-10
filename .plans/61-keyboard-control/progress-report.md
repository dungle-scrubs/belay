# Progress Report - Keyboard Control (stub)

**Plan:** `61-keyboard-control`
**Stage:** ready for implementation (stub - one concrete milestone; larger scope pending design)
**Current focus:** M1 - Keyboard-navigable sidebar session menu (3)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 3 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 3 |
| Accepted/deferred follow-up | 5 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Keyboard-navigable sidebar session menu (3)

- [ ] Design check: pick the menu-open key + nav model against `HOTKEYS.md` (reuse an
      existing roving pattern; no new global chord unless the ledger clears it on all
      three platforms).
- [ ] Implement: keyboard affordance to open the session overflow menu on the focused
      row, arrow-key roving across items, Enter/Escape to activate/dismiss; no change
      to the right-click path or the menu's appearance.
- [ ] Verify: keyboard-only story/interaction test (open → arrow → activate → escape);
      `HOTKEYS.md` updated with the new binding row.

## Accepted/Deferred Follow-Up (design backlog - to flesh out before becoming milestones)

These are open design questions, not committed work. Promote to a Current Cutoff
milestone only after the shape is agreed (see implementation.md section 4).

- [ ] Decide the scope/ambition of "keyboard control" (full navigation vs command
      reach vs Vim-everywhere).
- [ ] Decide the focus model (global roving/landmark jump vs per-surface) and how it
      coexists with the `Mod`-router.
- [ ] Decide discoverability (extend `Mod+/` help / generated cheat sheet).
- [ ] Decide the cross-platform combo budget strategy (leader keys vs modifier chords).
- [ ] Decide the relationship to the existing Vim layer (`src/vim/`).

## Superseded/Obsolete Checklist Debt

None.

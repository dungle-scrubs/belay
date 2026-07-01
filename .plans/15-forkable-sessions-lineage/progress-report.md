# Forkable Sessions Lineage - Progress Report

## Summary

- **Current cutoff blockers:** 5
- **Completed current work:** 12
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M4 - Participant Inheritance

## Completed Current State / Hard Dependencies

- [x] Richter is a generic append-only session substrate.
- [x] Blob-backed artifacts are content-addressed.
- [x] Session navigation/resume/takeover UI patterns exist.

## Current Cutoff Blockers

- [x] RED: Cover stable per-message ids and prefix selection.
- [x] GREEN: Implement a clean "fresh linear session from prefix" builder.
- [x] REFACTOR: Keep existing linear replay behavior unchanged.
- [x] RED: Cover `session.forkedFrom`, origin tags, `forkReady`, and self-contained child replay.
- [x] GREEN: Implement host fork operation over normal session append APIs.
- [x] REFACTOR: Keep Richter generic.
- [x] RED: Storybook/test branch-from-here and lineage states.
- [x] GREEN: Add explicit branch affordance and lineage navigator.
- [x] REFACTOR: Preserve session navigation/resume semantics.
- [ ] RED: Cover opt-in inheritance and dedupe by origin/id.
- [ ] GREEN: Implement inheritance contracts only where needed.
- [ ] RED: Cover a mid-turn fork resuming its next turn on the active (post-switch) model+reasoning reconstructed from the prefix's `model.switched` events, not a reset default (`.plans/09.1-mid-turn-model-switch`).
- [ ] GREEN: Treat the model+reasoning selection as an inherited stateful participant seeded from the fork point's active model.
- [ ] REFACTOR: Document stateless provider behavior.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

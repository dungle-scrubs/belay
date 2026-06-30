# Forkable Sessions Lineage - Progress Report

## Summary

- **Current cutoff blockers:** 14
- **Completed current work:** 3
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Message Identity and Prefix Builder

## Completed Current State / Hard Dependencies

- [x] Richter is a generic append-only session substrate.
- [x] Blob-backed artifacts are content-addressed.
- [x] Session navigation/resume/takeover UI patterns exist.

## Current Cutoff Blockers

- [ ] RED: Cover stable per-message ids and prefix selection.
- [ ] GREEN: Implement a clean "fresh linear session from prefix" builder.
- [ ] REFACTOR: Keep existing linear replay behavior unchanged.
- [ ] RED: Cover `session.forkedFrom`, origin tags, `forkReady`, and self-contained child replay.
- [ ] GREEN: Implement host fork operation over normal session append APIs.
- [ ] REFACTOR: Keep Richter generic.
- [ ] RED: Storybook/test branch-from-here and lineage states.
- [ ] GREEN: Add explicit branch affordance and lineage navigator.
- [ ] REFACTOR: Preserve session navigation/resume semantics.
- [ ] RED: Cover opt-in inheritance and dedupe by origin/id.
- [ ] GREEN: Implement inheritance contracts only where needed.
- [ ] RED: Cover a mid-turn fork resuming its next turn on the active (post-switch) model+reasoning reconstructed from the prefix's `model.switched` events, not a reset default (`.plans/09.1-mid-turn-model-switch`).
- [ ] GREEN: Treat the model+reasoning selection as an inherited stateful participant seeded from the fork point's active model.
- [ ] REFACTOR: Document stateless provider behavior.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.

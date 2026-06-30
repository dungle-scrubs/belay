# Forkable Sessions Lineage - Implementation Plan

## 0. Hard Dependencies

- [x] Richter remains a generic append-only session substrate.
- [x] Blob-backed artifacts exist and are content-addressed.
- [x] Session navigation, resume, and transcript takeover patterns are available for later UI.
- [ ] `.plans/09.1-mid-turn-model-switch` ships the `model.switched` session event, recorded on the session log so replay reconstructs the active model at every point, before this plan - so prefix-copy + origin tags carry the active switched model+reasoning into a fork through the generic event mechanism, with no Trevor-specific fork/model columns added to Richter. <!-- D-002 -->

## Scope

Extracted from D-025-D-030. This plan owns forkable sessions and lineage: stable message identity, `session.forkedFrom`, prefix-copy with origin tags, `forkReady`, host fork operation, web branch-from-here affordance, lineage navigator, and opt-in participant inheritance. Richter must not gain Trevor-specific fork columns or lineage APIs.

## Phases

### M1 - Message Identity and Prefix Builder

- [ ] RED: Cover stable per-message ids and prefix selection.
- [ ] GREEN: Implement a clean "fresh linear session from prefix" builder.
- [ ] REFACTOR: Keep existing linear replay behavior unchanged.

### M2 - Fork Protocol and Host Operation

- [ ] RED: Cover `session.forkedFrom`, origin tags, `forkReady`, and self-contained child replay.
- [ ] GREEN: Implement host fork operation over normal session append APIs.
- [ ] REFACTOR: Keep Richter generic.

### M3 - Web Branch and Lineage UI

- [ ] RED: Storybook/test branch-from-here and lineage states.
- [ ] GREEN: Add explicit branch affordance and lineage navigator.
- [ ] REFACTOR: Preserve session navigation/resume semantics.

### M4 - Participant Inheritance

- [ ] RED: Cover opt-in inheritance and dedupe by origin/id.
- [ ] GREEN: Implement inheritance contracts only for stateful participants that need them.
- [ ] RED: Cover a mid-turn fork resuming its next turn on the active (post-switch) model+reasoning reconstructed from the prefix's `model.switched` events, not a reset default (`.plans/09.1-mid-turn-model-switch`).
- [ ] GREEN: Treat the model+reasoning selection as an inherited stateful participant seeded from the fork point's active model.
- [ ] REFACTOR: Document stateless provider behavior. The provider stays stateless, but the model+reasoning selection is inherited state seeded from the fork point's active `.plans/09.1-mid-turn-model-switch` switch value. <!-- D-002 -->

## Decisions

Canonical decisions are in `.plans/15-forkable-sessions-lineage/plan.db`.

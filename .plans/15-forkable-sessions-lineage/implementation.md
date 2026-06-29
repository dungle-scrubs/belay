# Forkable Sessions Lineage - Implementation Plan

## 0. Hard Dependencies

- [x] Richter remains a generic append-only session substrate.
- [x] Blob-backed artifacts exist and are content-addressed.
- [x] Session navigation, resume, and transcript takeover patterns are available for later UI.

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
- [ ] REFACTOR: Document stateless provider behavior.

## Decisions

Canonical decisions are in `.plans/15-forkable-sessions-lineage/plan.db`.

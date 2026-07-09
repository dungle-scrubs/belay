# Event-Driven Tangent Adoption - Progress

Plan: `58.3-event-driven-tangent-adoption`
Stage: ready for implementation

> Current focus: M1 - Protocol Event

## Summary

Total tasks: 19
Completed: 0
Remaining: 19

The plan is scoped to reduce `/tangent` startup latency by letting the parent host adopt a newly created tangent from a parent-session `tangent.created` event. The existing inventory poll remains as a repair loop.

## Decisions

- D-001: Add a parent-session `tangent.created` wake-up event so the live parent host can adopt immediately.
- D-002: Keep the event payload isolated from prompt content; no quote text, parent transcript, or model context.
- D-003: Keep the parent host as the only tangent execution owner.
- D-004: Make wake-up delivery best-effort; failed delivery falls back to the inventory poll.

## Milestones

### M1 - Protocol Event

- [ ] RED: Accept a valid `tangent.created` protocol event.
- [ ] GREEN: Add event type, constructor/parser support, and exports.
- [ ] RED: Prove tangent prompt projection still depends on the tangent session marker.
- [ ] REFACTOR: Align naming with existing tangent vocabulary.

### M2 - Web Publish Path

- [ ] RED: Tangent creation writes `session.tangentOf` and publishes parent `tangent.created`.
- [ ] GREEN: Publish the wake-up after the tangent marker append succeeds.
- [ ] RED: Wake-up publish failure does not fail tangent creation.
- [ ] GREEN: Make parent wake-up publish best-effort.
- [ ] REFACTOR: Extract a small wake-up helper.

### M3 - Host Event-Driven Adoption

- [ ] RED: Parent host adopts from `tangent.created` without waiting for inventory polling.
- [ ] GREEN: Add an idempotent single-tangent adoption method.
- [ ] RED: Replay and leadership do not create duplicate tangent workers.
- [ ] GREEN: Wire live parent event handling through the existing adoption manager.
- [ ] REFACTOR: Keep event fast path separate from full inventory reconcile.

### M4 - Repair And Latency Verification

- [ ] RED: Delivered wake-up adopts before the poll interval.
- [ ] GREEN: Hermetic fake-provider path produces the first tangent response through event adoption.
- [ ] RED: Missing wake-up still repairs through polling.
- [ ] GREEN: Preserve polling as fallback repair.
- [ ] REFACTOR: Add adoption-source debug output if useful.

## Next Step

Start M1 RED with the smallest protocol test for `tangent.created`.

# Event-Driven Tangent Adoption - Implementation Plan

## 0. Hard Dependencies

- [x] Shipped tangent isolation primitives exist in `packages/session/src/tangent.ts` and the tangent session is marked with `session.tangentOf`.
- [x] Parent-host adoption exists in `apps/agent-host/src/session/tangent-adoption.ts` and starts tangent workers through `SessionWorker`.
- [x] The current repair loop exists in `apps/agent-host/src/main.ts` by polling session inventory for tangents of the parent session.
- [x] Downstream accommodation: none. This follows plan 58.2 and does not change the worktree sidebar contracts.

## 1. Architecture

The current `/tangent` path creates the tangent session immediately, but the parent host only learns about it on the next inventory poll. That poll runs every 4 seconds, so a new tangent can sit idle even though the browser already knows the tangent session id.

D-001: Add a parent-session `tangent.created` wake-up event. After the web client appends the tangent session's `session.tangentOf` marker, it appends `tangent.created` to the parent session. A live parent host already streams parent-session events, so it can adopt the new tangent without waiting for `fetchInventory()`.

D-002: Keep the event as an index hint only. Its payload may contain the tangent session id and the source message id, but must not carry selected quote text, parent transcript content, model context, or any hidden prompt material. Tangent prompt isolation stays owned by the tangent session's durable `session.tangentOf` marker and its first `user.message`.

D-003: Keep adoption owned by the parent host. The event must call through the existing `TangentAdoption` and `SessionWorker` path, not spawn a tangent-specific OS host and not introduce a second agent-host ownership model.

D-004: Treat wake-up delivery as best-effort. If publishing `tangent.created` fails after the tangent marker is written, tangent creation still succeeds and the existing inventory poll repairs the missed wake-up.

The poll remains in place as a repair loop. Event-driven adoption is the fast path; polling handles missed events, replay gaps, host restarts, and older clients.

## 2. Event Shape

`tangent.created` belongs to the parent session log:

```ts
type TangentCreatedEvent = {
  readonly type: "tangent.created";
  readonly tangentSessionId: SessionId;
  readonly sourceMessageId: MessageId;
};
```

If the existing event model requires the event payload under a `payload` field, keep the same fields there. Do not add prompt text, selected text, or parent transcript data.

## 3. Milestones

### M1 - Protocol Event

Goal: the shared session protocol can represent the wake-up event without changing tangent prompt projection.

1. RED: Add a protocol/unit test that accepts a valid `tangent.created` event with `tangentSessionId` and `sourceMessageId`.
2. GREEN: Add the event type, constructor/parser support, and exported type where the rest of the session events live.
3. RED: Add a test that tangent prompt projection still depends on the tangent session's own `session.tangentOf` marker, not the parent `tangent.created` event.
4. REFACTOR: Keep naming and placement aligned with the existing `session.tangentOf` and tangent fold-back event vocabulary.

### M2 - Web Publish Path

Goal: creating a tangent emits the durable tangent marker and then best-effort wakes the parent host.

1. RED: Add a web test proving tangent creation writes `session.tangentOf` to the tangent session and then publishes `tangent.created` to the parent session.
2. GREEN: Publish `tangent.created` after the tangent marker append succeeds.
3. RED: Add a test for wake-up publish failure: the tangent creation call still returns the tangent session id.
4. GREEN: Make the parent wake-up publish best-effort and leave the existing tangent session durable.
5. REFACTOR: Extract a small helper for the parent wake-up so ordering and failure semantics are obvious at the call site.

### M3 - Host Event-Driven Adoption

Goal: a live parent host adopts a tangent from the event stream without waiting for the inventory poll.

1. RED: Add a host test where a parent worker receives `tangent.created` and adoption starts immediately without calling `fetchInventory()`.
2. GREEN: Add an idempotent `adopt(tangentSessionId)` or equivalent method to `TangentAdoption`; do not call full `reconcile()` with a partial tangent set.
3. RED: Add a replay/leadership test so old `tangent.created` events do not start duplicate workers or bypass existing leader ownership.
4. GREEN: Wire live parent-session `tangent.created` handling to the adoption manager only when this host is the active owner; otherwise rely on the repair loop.
5. REFACTOR: Keep the inventory poll as a full desired-state reconcile and the event path as a single-tangent fast path.

### M4 - Repair And Latency Verification

Goal: missed wake-ups repair through polling, while delivered wake-ups avoid the 4 second delay.

1. RED: Add an integration or hermetic e2e test that observes tangent adoption before the poll interval when `tangent.created` is delivered.
2. GREEN: Drive the host with the fake provider and make the event path produce the first tangent response without waiting for the poll.
3. RED: Add a test where `tangent.created` is absent or dropped and the tangent is still adopted by the existing inventory poll.
4. GREEN: Preserve the poll behavior and keep the interval as repair, not as the primary path.
5. REFACTOR: Add structured debug output for adoption source (`event` vs `poll`) if it helps diagnose latency without adding user-facing UI.

## 4. Validation

Run the narrow tests first, then the full gates:

```sh
pnpm vitest run --project unit packages/session/src/tangent.test.ts
pnpm vitest run --project web apps/web/src/tangent/use-tangent.test.tsx
pnpm vitest run --project unit apps/agent-host/src/session/tangent-adoption.test.ts
pnpm vitest run --project e2e e2e/tangent.test.ts
pnpm typecheck
pnpm lint
pnpm test
```

If an exact test filename differs, use the nearest existing test that owns that scope rather than adding a new parallel test tree.

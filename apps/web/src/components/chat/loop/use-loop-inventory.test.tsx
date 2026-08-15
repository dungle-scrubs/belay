import {
  events,
  type LoopSnapshot,
  type SessionEvent,
  type TrevorEventInput,
} from "@belay/session";
import { expect, test } from "vitest";
import { loopInventoryRowsFromEvents } from "./use-loop-inventory";

function stored(input: TrevorEventInput, seq: number): SessionEvent {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    eventId: `ev-${seq}`,
    payload: input.payload as Record<string, unknown>,
    producerId: "host",
    seq,
    sessionId: "s",
    type: input.type,
  };
}

function snapshot(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    completed: 0,
    durability: "session",
    loopId: "loop_1",
    runner: "current_session_prompt",
    status: "pending",
    summary: "run tests",
    ...overrides,
  };
}

test("loopInventoryRowsFromEvents keeps the latest loop.status row per loop id", () => {
  const rows = loopInventoryRowsFromEvents([
    stored(events.userMessage({ text: "hi", provider: "qwen" }), 1),
    stored(events.loopStatus({ snapshot: snapshot({ completed: 1, status: "running" }) }), 2),
    stored(events.loopStatus({ snapshot: snapshot({ completed: 2, status: "paused" }) }), 3),
  ]);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    loopId: "loop_1",
    progress: { completed: 2 },
    status: "paused",
  });
});

test("loopInventoryRowsFromEvents drops deleted loops", () => {
  const rows = loopInventoryRowsFromEvents([
    stored(events.loopStatus({ snapshot: snapshot({ loopId: "loop_1", status: "running" }) }), 1),
    stored(events.loopStatus({ snapshot: snapshot({ loopId: "loop_2", status: "running" }) }), 2),
    stored(events.loopStatus({ snapshot: snapshot({ loopId: "loop_1", status: "deleted" }) }), 3),
  ]);

  expect(rows.map((row) => row.loopId)).toEqual(["loop_2"]);
});

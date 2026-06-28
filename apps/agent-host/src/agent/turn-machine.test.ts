import assert from "node:assert/strict";
import { test } from "vitest";
import { TurnMachine } from "./turn-machine";

/**
 * The turn machine's run bookkeeping, focused on `reapExcept` - the reconnect-reconcile that closes a
 * run whose terminal completion was lost while the store was unreachable (the forever-"Working" bug).
 * It must close in-flight orphans, spare a genuinely-live turn, and survive the emit-dedup poisoning
 * that a `markCompleted`-then-failed-emit leaves behind.
 */

const runIds = (events: readonly { payload: Record<string, unknown> }[]) =>
  events.map((e) => e.payload.runId);

test("reapExcept closes in-flight runs as interrupted, sparing the active run", () => {
  const tm = new TurnMachine();
  tm.start("r1");
  tm.start("r2");
  const events = tm.reapExcept("r2"); // r2 is genuinely running
  assert.deepEqual(runIds(events), ["r1"]);
  assert.equal(events[0]?.type, "assistant.completed");
  assert.equal(events[0]?.payload.interrupted, true);
  // r1 is closed (gone from in-flight); r2 is left running.
  assert.deepEqual(tm.inFlightIds(), ["r2"]);
});

test("reapExcept(null) closes every in-flight run (cold leadership / fresh join)", () => {
  const tm = new TurnMachine();
  tm.start("r1");
  tm.start("r2");
  assert.deepEqual(runIds(tm.reapExcept(null)).sort(), ["r1", "r2"]);
  assert.equal(tm.hasInFlight, false);
});

test("reapExcept re-emits even after a poisoned markCompleted (the store-outage case)", () => {
  const tm = new TurnMachine();
  tm.start("r1");
  // The turn's terminal completion tripped the emit-dedup but its emit was LOST to a dead socket, so
  // the run is still in-flight in the log. markCompleted alone must not suppress the reconciling close.
  assert.equal(tm.markCompleted("r1"), true);
  const events = tm.reapExcept(null);
  assert.deepEqual(
    runIds(events),
    ["r1"],
    "the orphan is re-emitted despite the prior markCompleted",
  );
});

test("reapExcept carries the run's last-known usage onto the reconciled completion", () => {
  const tm = new TurnMachine();
  tm.start("r1");
  const usage = { input: 1200, output: 30, contextWindow: 1_000_000, genMs: 5 };
  tm.progress("r1", usage);
  const events = tm.reapExcept(null);
  assert.deepEqual(events[0]?.payload.usage, usage);
});

test("reapExcept is a no-op when nothing is in flight", () => {
  assert.deepEqual(new TurnMachine().reapExcept(null), []);
});

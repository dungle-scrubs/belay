import assert from "node:assert/strict";
import { test } from "vitest";
import { ActiveRun } from "./active-run";
import { createSwitchCell } from "./switch-cell";

test("tracks the active run id and clears only the matching run", () => {
  const active = new ActiveRun();

  active.open("run-a");
  active.clear("other");
  assert.equal(active.runId(), "run-a");

  active.clear("run-a");
  assert.equal(active.runId(), null);
});

test("returns the switch cell for the active run or wildcard", () => {
  const active = new ActiveRun();
  const cell = createSwitchCell();

  active.open("run-a", cell);

  assert.equal(active.switchCellFor("run-a"), cell);
  assert.equal(active.switchCellFor(""), cell);
  assert.equal(active.switchCellFor("other"), null);
});

test("a restricted run has no switch cell", () => {
  const active = new ActiveRun();

  active.open("clip-run");

  assert.equal(active.switchCellFor("clip-run"), null);
});

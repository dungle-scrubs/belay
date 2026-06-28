import assert from "node:assert/strict";
import { test } from "vitest";
import { reduceReasoning } from "./reasoning-levels";

test("reduceReasoning steps down a notch, or null at the floor", () => {
  assert.equal(reduceReasoning(["off", "on"], "on"), "off");
  assert.equal(reduceReasoning(["off", "on"], "off"), null);
  assert.equal(reduceReasoning(["minimal", "low", "high"], "high"), "low");
  assert.equal(reduceReasoning(["minimal", "low", "high"], "minimal"), null);
  assert.equal(reduceReasoning(["off", "on"], undefined), null);
});

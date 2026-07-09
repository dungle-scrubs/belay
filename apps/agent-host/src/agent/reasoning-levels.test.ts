import assert from "node:assert/strict";
import { test } from "vitest";
import { cheapestReasoning, reduceReasoning } from "./reasoning-levels";

test("reduceReasoning steps down a notch, or null at the floor", () => {
  assert.equal(reduceReasoning(["off", "on"], "on"), "off");
  assert.equal(reduceReasoning(["off", "on"], "off"), null);
  assert.equal(reduceReasoning(["minimal", "low", "high"], "high"), "low");
  assert.equal(reduceReasoning(["minimal", "low", "high"], "minimal"), null);
  assert.equal(reduceReasoning(["off", "on"], undefined), null);
});

test("cheapestReasoning prefers off only when the surface lists it", () => {
  assert.equal(cheapestReasoning(["off", "high"]), "off");
  assert.equal(cheapestReasoning(["minimal", "low", "medium", "high"]), "minimal");
  assert.equal(cheapestReasoning([]), undefined);
});

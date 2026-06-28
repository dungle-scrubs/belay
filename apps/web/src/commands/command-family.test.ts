import assert from "node:assert/strict";
import { test } from "vitest";
import { commandPresentation } from "./command-family";
import { LOOP_FAMILY } from "./loop";
import { loopPresentation, parseLoopCommand } from "./loop-parser";

/**
 * The command presentation view-model (D-017): the builder + keyword strip render from this, so the
 * used-set, the error filter, and the row order are computed ONCE here, not re-derived per component.
 */

test("chips flag each keyword used/unused, in descriptor order", () => {
  const view = commandPresentation(parseLoopCommand('/loop every 5m do "go"'), LOOP_FAMILY);
  assert.deepEqual(
    view.chips.map((c) => c.keyword),
    LOOP_FAMILY.keywords.map((k) => k.keyword),
    "chips are the descriptor keywords, in order",
  );
  const used = new Set(view.chips.filter((c) => c.used).map((c) => c.keyword));
  assert.ok(used.has("every") && used.has("do"), "typed keywords are flagged used");
  assert.ok(!used.has("until"), "an untyped keyword stays unused");
});

test("rows pass through the parsed builder fields", () => {
  const parse = parseLoopCommand("/loop");
  const view = commandPresentation(parse, LOOP_FAMILY);
  assert.deepEqual(view.rows, parse.fields);
});

test("errors are only the error-severity diagnostics; ready mirrors the parse", () => {
  const bad = commandPresentation(parseLoopCommand('/loop every 5flarn max 0 do "x"'), LOOP_FAMILY);
  assert.ok(bad.errors.length >= 1, "value errors surface");
  assert.ok(
    bad.errors.every((d) => d.severity === "error"),
    "only errors, no info diagnostics",
  );
  assert.equal(bad.ready, false);

  const good = commandPresentation(parseLoopCommand('/loop max 3 do "go"'), LOOP_FAMILY);
  assert.deepEqual(good.errors, []);
  assert.equal(good.ready, true);
});

test("loopPresentation owns the parse plus descriptor presentation path", () => {
  const input = '/loop every 5m until "tests pass" do "run the suite"';
  assert.deepEqual(
    loopPresentation(input),
    commandPresentation(parseLoopCommand(input), LOOP_FAMILY),
  );
});

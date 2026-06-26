import assert from "node:assert/strict";
import { test } from "vitest";
import { LOOP_FAMILY, loopGrammar } from "./loop";
import { parseDurationMs, parseLoopCommand } from "./loop-parser";

test("the legend derives from the descriptor keywords - no separate hand-maintained list (D-016)", () => {
  const { legend } = loopGrammar();
  assert.deepEqual(
    legend,
    LOOP_FAMILY.keywords.map((k) => k.keyword),
    "loopGrammar().legend is exactly the keyword names, in guide order",
  );
  // The parser surfaces that same legend as the available keywords for a bare create.
  assert.deepEqual([...parseLoopCommand("/loop ").availableKeywords], [...legend]);
});

test("non-loop input parses as invalid", () => {
  const result = parseLoopCommand("/shell ls");
  assert.equal(result.mode, "invalid");
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.code, "not_loop_command");
});

test("a complete creation is ready with no diagnostics", () => {
  const result = parseLoopCommand('/loop max 5 do "run tests"');
  assert.equal(result.mode, "create");
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.diagnostics.length, 0);
});

test("missing action and bound are reported and block readiness", () => {
  const result = parseLoopCommand("/loop");
  assert.equal(result.ready, false);
  assert.deepEqual([...result.missing].sort(), ["action", "bound"]);
  const actionRow = result.fields.find((row) => row.field === "action");
  assert.equal(actionRow?.missing, true);
  assert.equal(actionRow?.hint, 'add do "…"');
});

test("runner alias sets the runner row and lights the legend", () => {
  const result = parseLoopCommand('/loop background max 3 do "sweep"');
  const runnerRow = result.fields.find((row) => row.field === "runner");
  assert.equal(runnerRow?.value, "background agent");
  assert.ok(result.usedKeywords.includes("background"));
  assert.ok(!result.availableKeywords.includes("background"));
  assert.ok(result.availableKeywords.includes("durable"));
});

test("an invalid duration is flagged and not carried", () => {
  const result = parseLoopCommand('/loop every 5flarn do "x"');
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.code, "invalid_duration");
  assert.equal(
    result.fields.find((row) => row.field === "every"),
    undefined,
  );
});

test("invalid max is flagged", () => {
  const result = parseLoopCommand('/loop max 0 do "x"');
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.code, "invalid_max");
});

test("a trailing keyword with no value does not capture itself", () => {
  const result = parseLoopCommand("/loop max 2 do");
  const actionRow = result.fields.find((row) => row.field === "action");
  assert.equal(actionRow?.missing, true);
  assert.equal(result.ready, false);
});

test("tokens carry absolute spans and kinds", () => {
  const result = parseLoopCommand('/loop max 5 do "go"');
  const command = result.tokens[0];
  assert.deepEqual(
    { end: command?.end, kind: command?.kind, start: command?.start },
    { end: 5, kind: "command", start: 0 },
  );
  const value = result.tokens.find((token) => token.field === "maxIterations");
  assert.equal(value?.kind, "value");
  assert.equal(result.command.slice(0, 0), ""); // command id is "loop", not "/loop"
  assert.equal(result.command, "loop");
});

test("control verbs classify as control mode", () => {
  const result = parseLoopCommand("/loop stop loop_1");
  assert.equal(result.mode, "control");
  assert.equal(result.tokens.find((token) => token.kind === "subcommand")?.start, 6);
});

test("list classifies as list mode", () => {
  assert.equal(parseLoopCommand("/loop list").mode, "list");
});

test("durations accept aliases", () => {
  assert.equal(parseDurationMs("5m"), 300_000);
  assert.equal(parseDurationMs("5min"), 300_000);
  assert.equal(parseDurationMs("nope"), undefined);
});

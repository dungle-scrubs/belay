import assert from "node:assert/strict";
import { test } from "vitest";
import { LOOP_CONTROL_VERBS, LOOP_FAMILY, loopGrammar } from "./loop-command";
import {
  classifyLoopCommand,
  extractLoopSpec,
  parseDurationMs,
  parseLoopCommand,
} from "./loop-parser";

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

// --- M2: creation grammar coverage ---

test("optional `new` prefix is accepted and does not break a creation", () => {
  const result = parseLoopCommand('/loop new max 3 do "sweep"');
  assert.equal(result.mode, "create");
  assert.equal(result.ready, true);
  // `new` is a subcommand token, not an unknown.
  assert.ok(result.tokens.some((token) => token.kind === "subcommand" && token.keyword === "new"));
  assert.equal(result.diagnostics.length, 0);
});

test("every runner alias resolves to its runner in the row", () => {
  const cases: Array<[string, string]> = [
    ["current", "current session"],
    ["session", "current session"],
    ["background", "background agent"],
    ["process", "process"],
  ];
  for (const [alias, label] of cases) {
    const result = parseLoopCommand(`/loop ${alias} max 2 do "x"`);
    assert.equal(
      result.fields.find((row) => row.field === "runner")?.value,
      label,
      `runner alias ${alias}`,
    );
  }
});

test("`durable` sets the durability row and lights the legend", () => {
  const result = parseLoopCommand('/loop durable max 2 do "x"');
  assert.equal(result.fields.find((row) => row.field === "durability")?.value, "durable");
  assert.ok(result.usedKeywords.includes("durable"));
  assert.equal(result.ready, true);
});

test("`until` and `timeout` each satisfy the bound and parse their value", () => {
  const until = parseLoopCommand('/loop until "tests pass" do "fix it"');
  assert.equal(until.ready, true);
  assert.equal(until.fields.find((row) => row.field === "until")?.value, "tests pass");

  const timeout = parseLoopCommand('/loop timeout 30m do "watch"');
  assert.equal(timeout.ready, true);
  assert.equal(timeout.fields.find((row) => row.field === "timeout")?.value, "30m");
});

test("an empty until is flagged and does not satisfy the bound", () => {
  const result = parseLoopCommand('/loop until "" do "x"');
  assert.equal(result.ready, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "empty_until"));
});

// --- M2: control grammar + stable loop-id extraction ---

test("every control verb classifies as control mode and extracts a stable loop id", () => {
  for (const verb of LOOP_CONTROL_VERBS) {
    const parsed = parseLoopCommand(`/loop ${verb} loop_9`);
    assert.equal(parsed.mode, "control", `${verb} is control mode`);
    const routed = classifyLoopCommand(`/loop ${verb} loop_9`);
    assert.equal(routed.action, verb);
    assert.equal(routed.loopId, "loop_9", `${verb} extracts the loop id`);
  }
});

test("/loops list and /loop list both classify as list", () => {
  assert.equal(parseLoopCommand("/loops list").mode, "list");
  assert.equal(classifyLoopCommand("/loops list").action, "list");
  assert.equal(classifyLoopCommand("/loop list").action, "list");
});

test("a control verb with no id extracts no loop id (host can prompt for usage)", () => {
  const routed = classifyLoopCommand("/loop resume");
  assert.equal(routed.action, "resume");
  assert.equal(routed.loopId, undefined);
});

// --- M3: quotes ---

test("a double-quoted action is one value with internal spaces preserved", () => {
  const result = parseLoopCommand('/loop max 2 do "run the full suite twice"');
  assert.equal(
    result.fields.find((row) => row.field === "action")?.value,
    "run the full suite twice",
  );
  assert.equal(result.ready, true);
});

test("an unquoted do value is a single token only (trailing words are not captured)", () => {
  const result = parseLoopCommand("/loop max 2 do sweep extra words");
  // Only `sweep` is the action; the rest are unknown tokens, not part of the action.
  assert.equal(result.fields.find((row) => row.field === "action")?.value, "sweep");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "unknown_token"));
});

test("an unterminated quote is diagnosed, not carried with a stray quote", () => {
  const result = parseLoopCommand('/loop max 2 do "still open');
  assert.equal(result.ready, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "unterminated_quote"));
});

// --- M3: durations ---

test("compact duration units all normalize to milliseconds", () => {
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("30sec"), 30_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("2hr"), 7_200_000);
  assert.equal(parseDurationMs("0.5s"), 500);
});

test("a bare numeric duration defaults to seconds (retained V1 behavior)", () => {
  assert.equal(parseDurationMs("5"), 5_000);
  const result = parseLoopCommand('/loop every 5 do "tick"');
  assert.equal(result.ready, true);
  assert.equal(result.fields.find((row) => row.field === "every")?.value, "5");
});

// --- M3: the full diagnostic set + readiness ---

test("each validation case yields its own diagnostic code", () => {
  const codeOf = (input: string): string | undefined =>
    parseLoopCommand(input).diagnostics[0]?.code;
  assert.equal(codeOf("/shell ls"), "not_loop_command");
  assert.equal(codeOf('/loop max 0 do "x"'), "invalid_max");
  assert.equal(codeOf('/loop every nope do "x"'), "invalid_duration");
  assert.equal(codeOf('/loop until "" do "x"'), "empty_until");
});

test("an explicit-but-empty do is empty_action, distinct from a missing action", () => {
  const empty = parseLoopCommand('/loop max 2 do ""');
  assert.ok(empty.diagnostics.some((diagnostic) => diagnostic.code === "empty_action"));
  // Distinct from the missing case: `do ""` is NOT reported as a missing gap.
  assert.ok(!empty.missing.includes("action"));
  assert.equal(empty.ready, false);

  const missing = parseLoopCommand("/loop max 2");
  assert.ok(missing.missing.includes("action"));
  assert.ok(!missing.diagnostics.some((diagnostic) => diagnostic.code === "empty_action"));
});

test("an unknown token is an info diagnostic and does not block a valid loop", () => {
  const result = parseLoopCommand('/loop max 2 gibberish do "x"');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "unknown_token"));
  // unknown_token is info severity, so a bounded + actioned loop is still ready.
  assert.equal(result.ready, true);
});

// --- M4: typed spec extraction from a ready creation ---

test("extractLoopSpec compiles a ready creation into a typed, ms-normalized spec", () => {
  const spec = extractLoopSpec('/loop background durable every 5m timeout 1h do "sweep"');
  assert.deepEqual(spec, {
    runner: "background_agent",
    durability: "durable",
    action: "sweep",
    everyMs: 300_000,
    timeoutMs: 3_600_000,
  });
});

test("extractLoopSpec normalizes max to a number and keeps until text", () => {
  assert.deepEqual(extractLoopSpec('/loop max 5 do "run tests"'), {
    runner: "current_session_prompt",
    durability: "session",
    action: "run tests",
    max: 5,
  });
  assert.equal(extractLoopSpec('/loop until "green" do "fix"')?.until, "green");
});

test("extractLoopSpec returns undefined for a control line, a draft, or an error", () => {
  assert.equal(extractLoopSpec("/loop stop loop_1"), undefined); // control, not create
  assert.equal(extractLoopSpec("/loop list"), undefined); // list
  assert.equal(extractLoopSpec('/loop do "x"'), undefined); // no bound
  assert.equal(extractLoopSpec("/loop max 5"), undefined); // no action
  assert.equal(extractLoopSpec('/loop max 0 do "x"'), undefined); // invalid_max error
});

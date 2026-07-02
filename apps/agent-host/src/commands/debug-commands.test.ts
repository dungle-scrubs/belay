import assert from "node:assert/strict";
import { test } from "vitest";
import { DEBUG_ONLY_SPECS, debugCommandSpecs, isStopConfirmed } from "./debug-commands";

/**
 * The debug-command gating (D-094 M4): the lifecycle slash commands are exposed ONLY in debug mode,
 * and `/stop` requires an explicit confirm. These pin the "debug-only exposure" and the confirm step
 * the host wiring relies on; KILL must never appear here (force-termination stays the CLI's job).
 */

test("debug mode off announces only the /debug toggle - no lifecycle commands", () => {
  const names = debugCommandSpecs(false).map((s) => s.name);
  assert.deepEqual(names, ["/debug"]);
});

test("debug mode on reveals restart + archive/unarchive/stop, never kill", () => {
  const names = debugCommandSpecs(true).map((s) => s.name);
  assert.deepEqual(names, ["/debug", "/restart", "/archive", "/unarchive", "/stop"]);
  assert.ok(!names.includes("/kill"), "kill is CLI-only - never a host debug command");
});

test("every debug-only spec describes its lifecycle effect", () => {
  for (const spec of DEBUG_ONLY_SPECS) {
    assert.ok(spec.summary.length > 0, `${spec.name} has a summary`);
  }
  // Stop's summary names what it tears down, so the slash menu describes the effect before use.
  const stop = DEBUG_ONLY_SPECS.find((s) => s.name === "/stop");
  assert.match(stop?.summary ?? "", /cancel|clear|shut/i);
});

test("/stop confirm gating: bare stop prompts, `confirm` executes", () => {
  assert.equal(isStopConfirmed(""), false);
  assert.equal(isStopConfirmed("   "), false);
  assert.equal(isStopConfirmed("now"), false);
  assert.equal(isStopConfirmed("confirm"), true);
  assert.equal(isStopConfirmed("  CONFIRM  "), true, "trimmed + case-insensitive");
});

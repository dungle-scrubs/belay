import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vitest";
import { executeTool } from "../src/tools";

/**
 * The tool executor's error channel: a malformed call never throws or rejects - it is rendered
 * to one model-facing `error: …` line so the turn continues and the model can recover. Unknown
 * tool, non-JSON arguments, and schema-invalid arguments all degrade the same graceful way.
 */

const run = (name: string, args: string) => Effect.runPromise(executeTool(name, args));

test("an unknown tool renders an error line, never throws", async () => {
  const out = await run("definitely-not-a-tool", "{}");
  assert.ok(out.startsWith("error:"), out);
  assert.match(out, /unknown tool/i);
});

test("non-JSON arguments render an error line", async () => {
  const out = await run("bash", "{not valid json");
  assert.ok(out.startsWith("error:"), out);
});

test("schema-invalid arguments render an error line", async () => {
  // bash's `command` must be a string; a number is a decode failure, not a thrown exception.
  const out = await run("bash", JSON.stringify({ command: 123 }));
  assert.ok(out.startsWith("error:"), out);
});

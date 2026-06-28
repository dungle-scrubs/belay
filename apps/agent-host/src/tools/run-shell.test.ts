import assert from "node:assert/strict";
import { test } from "vitest";
import { runCommand } from "./run-shell";

/**
 * The shared protected shell path is the floor under the bash tool, `/shell`, skill interpolation,
 * and the prompt shell lane (D-082). These cover the four outcomes the lane publishes on a
 * `shell.result` - clean success, a safety-floor refusal, a non-zero failure, and the output cap.
 */

test("runCommand returns clean output for a successful command (ok)", async () => {
  const result = await runCommand("printf hello");
  assert.deepEqual(result, { output: "hello", ok: true });
});

test("runCommand refuses an always-prevented command through the safety floor (ok:false)", async () => {
  // `rm -rf /` is on the always-prevented floor regardless of the workspace root.
  const result = await runCommand("rm -rf /");
  assert.equal(result.ok, false);
  assert.match(result.output, /^refused: /);
});

test("runCommand reports a non-zero command as a failure (ok:false)", async () => {
  const result = await runCommand("sh -c 'echo boom >&2; exit 3'");
  assert.equal(result.ok, false);
  assert.match(result.output, /boom/);
});

test("runCommand caps large output with a truncation marker (no unbounded result)", async () => {
  // ~5000 numbered lines (~24KB) is well under the 1MB maxBuffer but far over the 8000-char output
  // cap, so the command succeeds and the rendered output is truncated rather than passed through whole.
  const { output, ok } = await runCommand("seq 1 5000");
  assert.equal(ok, true);
  assert.ok(output.length <= 8000 + 32, `expected capped output, got ${output.length} chars`);
  assert.match(output, /\[truncated\]/);
});

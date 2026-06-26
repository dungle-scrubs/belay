import assert from "node:assert/strict";
import { test } from "vitest";
import { renderShell, runShell, type ShellResult, shellOutcome } from "./run-shell";

/**
 * The shared protected shell path is the floor under the bash tool, `/shell`, skill interpolation,
 * and the prompt shell lane (D-082). These cover the four outcomes the lane publishes on a
 * `shell.result` - clean success, a safety-floor refusal, a non-zero failure, and the output cap -
 * plus the `shellOutcome` mapping that decides which of those count as `ok: false`.
 */

test("runShell returns clean output for a successful command (ok)", async () => {
  const result = await runShell("printf hello");
  assert.equal(result.kind, "ok");
  assert.equal(shellOutcome(result).ok, true);
  assert.equal(shellOutcome(result).output, "hello");
});

test("runShell refuses an always-prevented command through the safety floor (ok:false)", async () => {
  // `rm -rf /` is on the always-prevented floor regardless of the workspace root.
  const result = await runShell("rm -rf /");
  assert.equal(result.kind, "refused");
  const outcome = shellOutcome(result);
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /^refused: /);
});

test("runShell reports a non-zero command as a failure (ok:false)", async () => {
  const result = await runShell("sh -c 'echo boom >&2; exit 3'");
  assert.equal(result.kind, "failed");
  const outcome = shellOutcome(result);
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /boom/);
});

test("runShell caps large output with a truncation marker (no unbounded result)", async () => {
  // ~5000 numbered lines (~24KB) is well under the 1MB maxBuffer but far over the 8000-char output
  // cap, so the command succeeds and the rendered output is truncated rather than passed through whole.
  const result = await runShell("seq 1 5000");
  assert.equal(result.kind, "ok");
  const { output } = shellOutcome(result);
  assert.ok(output.length <= 8000 + 32, `expected capped output, got ${output.length} chars`);
  assert.match(output, /\[truncated\]/);
});

test("shellOutcome maps each ShellResult kind to the right ok flag + rendered text", () => {
  const ok: ShellResult = { kind: "ok", output: "done" };
  const refused: ShellResult = { kind: "refused", reason: "blocked" };
  const failed: ShellResult = { kind: "failed", output: "error: x" };
  assert.deepEqual(shellOutcome(ok), { output: "done", ok: true });
  assert.deepEqual(shellOutcome(refused), { output: "refused: blocked", ok: false });
  assert.deepEqual(shellOutcome(failed), { output: "error: x", ok: false });
  // Stays byte-identical to renderShell so /shell and the lane never diverge.
  assert.equal(shellOutcome(refused).output, renderShell(refused));
});

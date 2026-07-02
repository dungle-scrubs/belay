import assert from "node:assert/strict";
import { ProcessRegistry } from "@host/processes/process-registry";
import { Effect } from "effect";
import { afterEach, test } from "vitest";
import { buildBashTool } from "./bash";
import { ToolInputError } from "./errors";
import { promotedResultText } from "./promote-runner";

/**
 * M4: the bash tool, wired to the promotable runner. A long command promotes (its result names the `pN`
 * and shows the output so far + the job is tracked in the supervisor, so cancelling the run never orphans
 * it); a fast command returns its output; a refused command is a ToolInputError. Real short commands.
 */

const reg = new ProcessRegistry();
afterEach(() => reg.killAll());

const run = (command: string, thresholdMs: number, enabled = true) =>
  Effect.runPromise(buildBashTool(reg, { enabled, thresholdMs }).execute({ command }));

test("a promoted bash command returns a result that names the pN job + survives as a tracked job", async () => {
  const out = await run("sleep 2", 60);
  assert.match(out, /promoted to p\d+/);
  // The job is in the supervisor (independent of the run), so a parent-run cancellation never orphans it.
  const promoted = reg.snapshots().find((s) => s.source === "bash" && s.status === "running");
  assert.ok(promoted, "the promoted job is tracked in the supervisor");
  assert.ok(out.includes(promoted?.id ?? "??"), "the result names the actual job id");
});

test("a fast bash command returns its output (foreground complete)", async () => {
  const out = await run("echo done-fast", 2000);
  assert.match(out, /done-fast/);
  assert.doesNotMatch(out, /promoted/);
});

test("a refused command is a ToolInputError with the safety reason", async () => {
  const err = await Effect.runPromise(
    Effect.flip(
      buildBashTool(reg, { enabled: true, thresholdMs: 60 }).execute({ command: "rm -rf /" }),
    ),
  );
  assert.ok(err instanceof ToolInputError);
});

test("promotedResultText names the job + shows the output so far", () => {
  const text = promotedResultText("p7", "line one\nline two");
  assert.match(text, /promoted to p7/);
  assert.match(text, /line one/);
});

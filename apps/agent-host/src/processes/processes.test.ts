import assert from "node:assert/strict";
import { ProcessError, ToolInputError } from "@host/tools/errors";
import { Effect } from "effect";
import { test } from "vitest";
import { ProcessSupervisor } from "./processes";

/**
 * Characterization tests for the `process` tool now that the supervisor owns its own
 * tool definition (`supervisor.buildTool()`, D-035). These pin the action dispatch and
 * output that the old free `buildProcessTool` forwarder produced, so inlining it onto the
 * class stays behavior-preserving: the tool keeps the `process` name, dispatches
 * start/poll/kill/list to the supervisor, JSON-encodes the result, and routes a typed
 * ToolError into the Effect `E` channel.
 */

test("buildTool exposes the `process` tool with the start/poll/kill/list schema", () => {
  const tool = new ProcessSupervisor().buildTool();
  assert.equal(tool.name, "process");
  // The process tool mutates the host, so it is NOT a read-only barrier.
  assert.equal(tool.readOnly, undefined);
});

test("start dispatches to the supervisor and returns its JSON id/status", async () => {
  const sup = new ProcessSupervisor();
  const out = await Effect.runPromise(
    sup.buildTool().execute({ action: "start", command: "true", stdoutCursor: 0, stderrCursor: 0 }),
  );
  const parsed = JSON.parse(out) as { id: string; status: string };
  assert.equal(parsed.status, "running");
  assert.match(parsed.id, /^p\d+$/u);
  sup.killAll();
});

test("an empty start command fails with a ToolInputError in the E channel", async () => {
  const sup = new ProcessSupervisor();
  const err = await Effect.runPromise(
    Effect.flip(
      sup
        .buildTool()
        .execute({ action: "start", command: "   ", stdoutCursor: 0, stderrCursor: 0 }),
    ),
  );
  assert.ok(err instanceof ToolInputError);
  assert.equal(err.tool, "process");
});

test("poll on an unknown id surfaces a ProcessError in the E channel", async () => {
  const sup = new ProcessSupervisor();
  const err = await Effect.runPromise(
    Effect.flip(
      sup.buildTool().execute({ action: "poll", id: "nope", stdoutCursor: 0, stderrCursor: 0 }),
    ),
  );
  assert.ok(err instanceof ProcessError);
  assert.equal(err.detail, 'no such process "nope"');
});

test("kill on an unknown id surfaces a ProcessError in the E channel", async () => {
  const sup = new ProcessSupervisor();
  const err = await Effect.runPromise(
    Effect.flip(
      sup.buildTool().execute({ action: "kill", id: "nope", stdoutCursor: 0, stderrCursor: 0 }),
    ),
  );
  assert.ok(err instanceof ProcessError);
});

test("dismiss removes completed jobs and refuses running jobs in the E channel", async () => {
  const sup = new ProcessSupervisor();
  const completed = sup.start("true", process.cwd()).id;
  const running = sup.start("sleep 5", process.cwd()).id;
  await sup.awaitExit(completed);

  const out = await Effect.runPromise(
    sup.buildTool().execute({ action: "dismiss", id: completed, stdoutCursor: 0, stderrCursor: 0 }),
  );
  assert.deepEqual(JSON.parse(out), { id: completed, status: "dismissed" });
  assert.equal(
    sup.list().find((job) => job.id === completed),
    undefined,
  );

  const err = await Effect.runPromise(
    Effect.flip(
      sup.buildTool().execute({ action: "dismiss", id: running, stdoutCursor: 0, stderrCursor: 0 }),
    ),
  );
  assert.ok(err instanceof ProcessError);
  assert.match(err.detail, /stop it first/u);
  assert.equal(sup.list().find((job) => job.id === running)?.status, "running");
  sup.killAll();
});

test("clear_completed removes terminal jobs through the process tool", async () => {
  const sup = new ProcessSupervisor();
  const completed = sup.start("true", process.cwd()).id;
  const killed = sup.start("sleep 5", process.cwd()).id;
  const running = sup.start("sleep 5", process.cwd()).id;
  sup.kill(killed);
  await sup.awaitExit(completed);

  const out = await Effect.runPromise(
    sup.buildTool().execute({ action: "clear_completed", stdoutCursor: 0, stderrCursor: 0 }),
  );

  assert.deepEqual(JSON.parse(out), { dismissed: 2 });
  assert.equal(
    sup.list().find((job) => job.id === completed),
    undefined,
  );
  assert.equal(
    sup.list().find((job) => job.id === killed),
    undefined,
  );
  assert.equal(sup.list().find((job) => job.id === running)?.status, "running");
  sup.killAll();
});

test("list returns a JSON array of the supervisor's jobs", async () => {
  const sup = new ProcessSupervisor();
  sup.start("true", process.cwd());
  const out = await Effect.runPromise(
    sup.buildTool().execute({ action: "list", stdoutCursor: 0, stderrCursor: 0 }),
  );
  const jobs = JSON.parse(out) as Array<{ id: string; command: string; status: string }>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.command, "true");
  sup.killAll();
});

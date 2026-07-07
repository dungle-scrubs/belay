import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { test } from "vitest";
import { ToolExecutionError } from "./errors";
import { createToolRegistry } from "./registry";
import type { Tool } from "./types";

/**
 * Responsible for: the composable tool-registry boundary over an explicit tool set.
 * Not for: the host's default concrete tool inventory, which is covered by index.test.ts.
 */

const FakeParams = Schema.Struct({ value: Schema.String });

const echoTool: Tool<typeof FakeParams.Type> = {
  name: "echo_fake",
  description: "Echo a test value.",
  params: FakeParams,
  readOnly: true,
  execute: (input, ctx) =>
    Effect.succeed(`${ctx?.runId ?? "no-run"}:${ctx?.callId ?? "no-call"}:${input.value}`),
};

const failingTool: Tool<typeof FakeParams.Type> = {
  name: "fail_fake",
  description: "Fail for registry tests.",
  params: FakeParams,
  execute: () =>
    Effect.fail(new ToolExecutionError({ tool: "fail_fake", detail: "planned failure" })),
};

test("registry derives definitions and offered tool subsets from an explicit tool list", () => {
  const registry = createToolRegistry({
    tools: [echoTool, failingTool],
    readOnlyTools: new Set(["echo_fake"]),
  });

  assert.deepEqual(
    registry.toolDefs.map((tool) => tool.name),
    ["echo_fake", "fail_fake"],
  );
  assert.equal(registry.readOnlyTools.has("echo_fake"), true);

  const offered = registry.offeredToolDefs(true, new Set(["echo_fake"]), [
    { name: "delegate_fake", description: "delegate", parameters: { type: "object" } },
  ]);
  assert.deepEqual(
    offered.map((tool) => tool.name),
    ["echo_fake", "delegate_fake"],
  );
  assert.deepEqual(registry.offeredToolDefs(false, undefined, undefined), []);
});

test("registry decodes, dispatches, and renders tool errors at one boundary", async () => {
  const registry = createToolRegistry({
    tools: [echoTool, failingTool],
    readOnlyTools: new Set(["echo_fake"]),
    now: () => 10,
  });

  assert.equal(
    await Effect.runPromise(registry.executeTool("echo_fake", '{"value":"ok"}', "r1", "c1")),
    "r1:c1:ok",
  );
  assert.equal(
    await Effect.runPromise(registry.executeTool("missing_fake", "{}")),
    'error: unknown tool "missing_fake"',
  );
  assert.equal(
    await Effect.runPromise(registry.executeTool("echo_fake", "{")),
    "error: tool arguments were not valid JSON",
  );
  assert.match(
    await Effect.runPromise(registry.executeTool("echo_fake", '{"value":123}')),
    /^error: echo_fake failed - /,
  );
  assert.equal(
    await Effect.runPromise(registry.executeTool("fail_fake", '{"value":"x"}')),
    "error: fail_fake failed - planned failure",
  );
});

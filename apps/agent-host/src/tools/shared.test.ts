import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { test } from "vitest";
import { ToolExecutionError, ToolInputError } from "./errors";
import {
  boundedText,
  MAX_OUTPUT,
  simpleTool,
  TRUNCATION_NOTICE,
  toolExecution,
  toolInput,
} from "./shared";

/**
 * `simpleTool` is the tool primitive: the body returns core logic only, while the primitive stamps
 * the tool name onto unknown throws/rejections, explicit input failures, explicit execution
 * failures, read-only metadata, and capped output. `boundedText` is the one flag-carrying
 * truncation helper behind mcp/content's boundText and lsp/caps's capText.
 */

const NameOnly = Schema.Struct({ x: Schema.optional(Schema.String) });

test("boundedText leaves short text untouched and cuts long text with the shared marker", () => {
  assert.deepEqual(boundedText("hello", 10), { text: "hello", truncated: false });

  const bounded = boundedText("z".repeat(50), 10);
  assert.equal(bounded.text, `${"z".repeat(10)}${TRUNCATION_NOTICE}`);
  assert.equal(bounded.truncated, true);
});

test("simpleTool wraps unknown throws and explicit sentinel failures with the tool name", async () => {
  const thrown = simpleTool({
    name: "simple",
    description: "d",
    params: NameOnly,
    execute: () => {
      throw new Error("boom");
    },
  });
  const err = await Effect.runPromise(Effect.flip(thrown.execute({})));
  assert.ok(err instanceof ToolExecutionError);
  assert.equal(err.tool, "simple");
  assert.equal(err.detail, "boom");

  const input = simpleTool({
    name: "simple_input",
    description: "d",
    params: NameOnly,
    execute: () => toolInput("bad arg"),
  });
  const inputErr = await Effect.runPromise(Effect.flip(input.execute({})));
  assert.ok(inputErr instanceof ToolInputError);
  assert.equal(inputErr.tool, "simple_input");
  assert.equal(inputErr.detail, "bad arg");

  const execution = simpleTool({
    name: "simple_execution",
    description: "d",
    params: NameOnly,
    execute: () => toolExecution("known failure"),
  });
  const executionErr = await Effect.runPromise(Effect.flip(execution.execute({})));
  assert.ok(executionErr instanceof ToolExecutionError);
  assert.equal(executionErr.tool, "simple_execution");
  assert.equal(executionErr.detail, "known failure");
});

test("simpleTool maps rejected promises to ToolExecutionError with the tool name", async () => {
  const tool = simpleTool({
    name: "async_simple",
    description: "d",
    params: NameOnly,
    execute: () => Promise.reject(new Error("io boom")),
  });
  const err = await Effect.runPromise(Effect.flip(tool.execute({})));
  assert.ok(err instanceof ToolExecutionError);
  assert.equal(err.tool, "async_simple");
  assert.equal(err.detail, "io boom");
});

test("simpleTool caps output and surfaces readOnly only when set", async () => {
  const big = "x".repeat(MAX_OUTPUT + 500);
  const tool = simpleTool({
    name: "simple_capped",
    description: "d",
    params: NameOnly,
    readOnly: true,
    capped: true,
    execute: () => big,
  });
  const out = await Effect.runPromise(tool.execute({}));
  assert.equal(tool.readOnly, true);
  assert.ok(out.length < big.length);
  assert.ok(out.endsWith("…[truncated]"));

  const rw = simpleTool({
    name: "rw",
    description: "d",
    params: NameOnly,
    execute: () => "ok",
  });
  assert.equal(rw.readOnly, undefined);
});

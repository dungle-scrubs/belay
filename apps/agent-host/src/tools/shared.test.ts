import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { test } from "vitest";
import { ToolExecutionError, ToolInputError } from "./errors";
import { defineTool, MAX_OUTPUT, tryTool, tryToolSync } from "./shared";

/**
 * Characterization tests for the shared tool error-wrapping helper (M3 / D-003).
 *
 * Every tool wrapped its fs/child-process calls in the same
 * `Effect.try(Promise)({ catch: (cause) => new ToolExecutionError({ tool, detail: msg(cause), cause }) })`
 * boilerplate, re-spelling its own name 12 times across 7 tools. These pin the one
 * error contract before it is centralized: a thrown/rejected cause becomes a
 * ToolExecutionError carrying the tool name and the cause's message, and a success
 * passes through unchanged.
 */

test("tryTool maps a rejection to a ToolExecutionError carrying the tool name + message", async () => {
  const err = await Effect.runPromise(
    Effect.flip(tryTool("edit", () => Promise.reject(new Error("boom")))),
  );
  assert.ok(err instanceof ToolExecutionError);
  assert.equal(err.tool, "edit");
  assert.equal(err.detail, "boom");
  assert.ok(err.cause instanceof Error);
});

test("tryTool passes a resolved value through unchanged", async () => {
  const value = await Effect.runPromise(tryTool("read", () => Promise.resolve("file body")));
  assert.equal(value, "file body");
});

test("tryToolSync maps a thrown error to a ToolExecutionError carrying the tool name", async () => {
  const err = await Effect.runPromise(
    Effect.flip(
      tryToolSync("edit", () => {
        throw new Error("outside workspace");
      }),
    ),
  );
  assert.ok(err instanceof ToolExecutionError);
  assert.equal(err.tool, "edit");
  assert.equal(err.detail, "outside workspace");
});

test("tryToolSync passes a returned value through unchanged", async () => {
  const value = await Effect.runPromise(tryToolSync("edit", () => "/abs/path"));
  assert.equal(value, "/abs/path");
});

test("a non-Error rejection still yields the tool name and a string detail", async () => {
  const err = await Effect.runPromise(Effect.flip(tryTool("glob", () => Promise.reject("nope"))));
  assert.ok(err instanceof ToolExecutionError);
  assert.equal(err.tool, "glob");
  assert.equal(err.detail, "nope");
});

/**
 * `defineTool` is the tool primitive: it binds the tool name into the ToolOps the body uses (so a
 * tool never re-spells its name) and owns output capping. These pin that the name-bound error
 * envelope and the `capped` policy are one shared decision, not re-implemented per tool.
 */

const NameOnly = Schema.Struct({ x: Schema.optional(Schema.String) });

test("defineTool binds the tool name into ops.attempt / attemptSync / reject", async () => {
  const tool = defineTool({
    name: "demo",
    description: "d",
    params: NameOnly,
    execute: (_args, ops) => ops.attempt(() => Promise.reject(new Error("io boom"))),
  });
  const err = await Effect.runPromise(Effect.flip(tool.execute({})));
  assert.ok(err instanceof ToolExecutionError);
  assert.equal(err.tool, "demo");
  assert.equal(err.detail, "io boom");

  const rejecter = defineTool({
    name: "demo2",
    description: "d",
    params: NameOnly,
    execute: (_args, ops) => ops.reject("bad arg"),
  });
  const inputErr = await Effect.runPromise(Effect.flip(rejecter.execute({})));
  assert.ok(inputErr instanceof ToolInputError);
  assert.equal(inputErr.tool, "demo2");
  assert.equal(inputErr.detail, "bad arg");
});

test("capped:true truncates output at MAX_OUTPUT; without it the output passes through", async () => {
  const big = "x".repeat(MAX_OUTPUT + 500);
  const capped = defineTool({
    name: "capped",
    description: "d",
    params: NameOnly,
    capped: true,
    execute: () => Effect.succeed(big),
  });
  const out = await Effect.runPromise(capped.execute({}));
  assert.ok(out.length < big.length);
  assert.ok(out.endsWith("…[truncated]"));

  const uncapped = defineTool({
    name: "uncapped",
    description: "d",
    params: NameOnly,
    execute: () => Effect.succeed(big),
  });
  assert.equal(await Effect.runPromise(uncapped.execute({})), big);
});

test("defineTool surfaces readOnly only when set (drives READ_ONLY_TOOLS membership)", () => {
  const ro = defineTool({
    name: "ro",
    description: "d",
    params: NameOnly,
    readOnly: true,
    execute: () => Effect.succeed("ok"),
  });
  const rw = defineTool({
    name: "rw",
    description: "d",
    params: NameOnly,
    execute: () => Effect.succeed("ok"),
  });
  assert.equal(ro.readOnly, true);
  assert.equal(rw.readOnly, undefined);
});

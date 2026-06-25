import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vitest";
import { ToolExecutionError } from "./errors";
import { tryTool, tryToolSync } from "./shared";

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

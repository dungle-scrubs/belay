import assert from "node:assert/strict";
import { test } from "vitest";
import { TOOL_DEFS } from "./index";

/**
 * ask_user must keep its V1 name (never `ask_user_question`, D-001) and advertise a clean, flat
 * parameter schema (both the legacy single-question form and the grouped form).
 */

test("ask_user is registered under its V1 name, and ask_user_question is absent (D-001)", () => {
  const names = TOOL_DEFS.map((d) => d.name);
  assert.ok(names.includes("ask_user"), "ask_user must be registered");
  assert.ok(!names.includes("ask_user_question"), "must not be renamed to ask_user_question");
});

test("ask_user advertises an object schema exposing the legacy and grouped question fields", () => {
  const def = TOOL_DEFS.find((d) => d.name === "ask_user");
  assert.ok(def, "ask_user has a tool def");
  const params = def.parameters as Record<string, unknown>;
  assert.equal(params.type, "object");
  const props = params.properties as Record<string, unknown>;
  for (const key of ["question", "choices", "questions", "multiSelect"]) {
    assert.ok(key in props, `ask_user params expose "${key}"`);
  }
});

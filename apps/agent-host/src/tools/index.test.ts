import assert from "node:assert/strict";
import { test } from "vitest";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { READ_ONLY_TOOLS } from "./index";
import { multiEditTool } from "./multi-edit";
import { readTool } from "./read";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

/**
 * Pins the `readOnly` partition that drives concurrent dispatch (D-050 / M1). `READ_ONLY_TOOLS`
 * is derived by filtering the registry on the flag, so these guard both directions: a tool that
 * declares `readOnly: true` joins the set, and a tool that leaves the flag unset stays a serial
 * barrier and is absent from it.
 */

test("the read-only tools declare the flag and appear in READ_ONLY_TOOLS", () => {
  for (const tool of [readTool, globTool, grepTool, webSearchTool]) {
    assert.equal(tool.readOnly, true, `${tool.name} should declare readOnly: true`);
    assert.ok(READ_ONLY_TOOLS.has(tool.name), `${tool.name} should be in READ_ONLY_TOOLS`);
  }
});

test("a tool without the readOnly flag is absent from READ_ONLY_TOOLS", () => {
  for (const tool of [editTool, writeTool, multiEditTool, bashTool]) {
    assert.equal(tool.readOnly, undefined, `${tool.name} should leave readOnly unset`);
    assert.ok(
      !READ_ONLY_TOOLS.has(tool.name),
      `${tool.name} should be absent from READ_ONLY_TOOLS`,
    );
  }
});

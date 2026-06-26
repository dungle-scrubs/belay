import assert from "node:assert/strict";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@trevor/session";
import { test } from "vitest";
import { supervisor } from "../processes";
import { buildSkillTool } from "../skills";
import { buildTaskTools } from "../tasks";
import { astGrepTool } from "./ast-grep";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { READ_ONLY_TOOLS } from "./index";
import { multiEditTool } from "./multi-edit";
import { readTool } from "./read";
import { sessionRecallTool } from "./session-recall";
import type { Tool } from "./types";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

/**
 * Pins the `readOnly` partition that drives concurrent dispatch (D-050 / M1). `READ_ONLY_TOOLS`
 * is the cross-surface vocabulary from `@trevor/session` (D-031); these guard both directions:
 * a tool that declares `readOnly: true` joins the set, and a tool that leaves the flag unset
 * stays a serial barrier and is absent from it.
 */

test("the read-only tools declare the flag and appear in READ_ONLY_TOOLS", () => {
  for (const tool of [
    readTool,
    globTool,
    grepTool,
    webSearchTool,
    sessionRecallTool,
    astGrepTool,
  ]) {
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

/**
 * Drift guard (D-031): the shared tool-vocabulary table in `@trevor/session` must match the
 * host's REAL tool definitions exactly - every tool the host can expose, and each tool's
 * `readOnly` nature. The conditional tools (`ast_grep`, registered only when its binary
 * resolves; `skill`, only when the library is non-empty) are listed explicitly so the
 * universe is environment-independent, not read off the runtime `TOOLS` array. Adding a host
 * tool, removing one, or flipping a `readOnly` flag without updating the table fails here -
 * which keeps the table (and therefore both surfaces' read-only classification) in lockstep
 * with the authoritative host defs.
 */
test("the shared tool table matches the host's actual tool defs (names + readOnly)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; only name/readOnly read here.
  const hostTools: readonly Tool<any>[] = [
    readTool,
    bashTool,
    writeTool,
    editTool,
    multiEditTool,
    globTool,
    grepTool,
    webSearchTool,
    sessionRecallTool,
    astGrepTool,
    supervisor.buildTool(),
    ...buildTaskTools(),
    buildSkillTool([]),
  ];

  const fromHost = hostTools
    .map((tool) => ({ name: tool.name, readOnly: tool.readOnly === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fromTable = TOOL_DESCRIPTORS.map((tool) => ({
    name: tool.name,
    readOnly: tool.readOnly,
  })).sort((a, b) => a.name.localeCompare(b.name));

  assert.deepEqual(
    fromHost,
    fromTable,
    "the @trevor/session tool table drifted from the host tool defs - update packages/session/src/tools.ts",
  );
});

test("READ_ONLY_TOOLS is the shared READ_ONLY_TOOL_NAMES (single source)", () => {
  assert.strictEqual(READ_ONLY_TOOLS, READ_ONLY_TOOL_NAMES);
});

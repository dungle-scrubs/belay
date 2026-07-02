import assert from "node:assert/strict";
import { createMcpRuntime } from "@host/mcp/runtime";
import { supervisor } from "@host/processes/processes";
import { buildSkillTool } from "@host/skills/skills";
import { buildTaskTools } from "@host/tools/tasks/tasks";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@trevor/session";
import { test } from "vitest";
import { buildToolScriptTool } from "../tool-script/tool";
import { archiveReadTool, archiveUnpackTool } from "./archive/tool";
import { askUserTool } from "./ask-user";
import { astGrepTool } from "./ast-grep";
import { buildBashTool } from "./bash";
import { clipboardWriteTool } from "./clipboard";
import { docsTool } from "./docs/docs";
import { doctorTool } from "./doctor";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { READ_ONLY_TOOLS, TOOL_DEFS } from "./index";
import { buildMcpTool } from "./mcp";
import { multiEditTool } from "./multi-edit";
import { DEFAULT_PROMOTION_CONFIG } from "./promote-policy";
import { readTool } from "./read";
import { sessionRecallTool } from "./session-recall";
import { skillViewTool } from "./skill-view";
import { skillsListTool } from "./skills-list";
import { trevorExpertTool } from "./trevor-expert";
import type { Tool } from "./types";
import { webFetchTool } from "./web-fetch/web-fetch";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

// The bash tool is now a builder (it threads the supervisor + promotion config, plan 09); build one
// instance for the parity/readOnly checks below - its name + readOnly nature are unchanged.
const bashTool = buildBashTool(supervisor, DEFAULT_PROMOTION_CONFIG);

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
    webFetchTool,
    archiveReadTool,
    docsTool,
    sessionRecallTool,
    astGrepTool,
    doctorTool,
  ]) {
    assert.equal(tool.readOnly, true, `${tool.name} should declare readOnly: true`);
    assert.ok(READ_ONLY_TOOLS.has(tool.name), `${tool.name} should be in READ_ONLY_TOOLS`);
  }
});

test("a tool without the readOnly flag is absent from READ_ONLY_TOOLS", () => {
  for (const tool of [
    editTool,
    writeTool,
    multiEditTool,
    archiveUnpackTool,
    bashTool,
    // mcp mutates EXTERNAL service state (plan 23 D-008): always a serial barrier.
    buildMcpTool(createMcpRuntime([])),
  ]) {
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
    askUserTool,
    readTool,
    bashTool,
    writeTool,
    editTool,
    multiEditTool,
    globTool,
    grepTool,
    webSearchTool,
    webFetchTool,
    archiveReadTool,
    docsTool,
    sessionRecallTool,
    skillsListTool,
    skillViewTool,
    astGrepTool,
    doctorTool,
    trevorExpertTool,
    // The mcp tool's name/readOnly nature is config-independent; an empty runtime suffices here.
    buildMcpTool(createMcpRuntime([])),
    buildToolScriptTool({
      execute: () => Promise.resolve(""),
      cwd: "/w",
      makeScratchDir: () => "/tmp/x",
      cleanupScratchDir: () => {},
    }),
    clipboardWriteTool,
    archiveUnpackTool,
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

/**
 * Regression guard: every advertised tool's parameter schema must be a clean JSON OBJECT schema with
 * no doc-level `$`-meta keys. A no-arg tool (`doctor`) declared as a bare `Schema.Struct({})` leaked
 * an `anyOf` carrying a relative `$id` URL, which OpenAI-compatible providers (DeepSeek) reject with
 * "relative URL without a base" - breaking every turn. Pinning `type: "object"` + no `$`-keys catches
 * both that shape and any future schema that emits `$id`/`$schema`/`$ref`/`$defs`.
 */
test("every advertised tool parameter schema is a clean object (type: object, no $-meta keys)", () => {
  for (const def of TOOL_DEFS) {
    const params = def.parameters as Record<string, unknown>;
    assert.equal(params.type, "object", `${def.name} parameters must be a JSON object schema`);
    for (const key of Object.keys(params)) {
      assert.ok(
        !key.startsWith("$"),
        `${def.name} parameters leaked a "${key}" meta key (breaks OpenAI-compatible providers)`,
      );
    }
  }
});

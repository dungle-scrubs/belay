/**
 * Responsible for: the tool registry - assembling TOOLS, deriving provider JSON Schemas,
 * offered-def filtering, and the executeTool decode/dispatch/error boundary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ONLY_TOOL_NAMES } from "@belay/session";
import { lspManager } from "@host/lsp/host-runtime";
import { mcpRuntime } from "@host/mcp/host-runtime";
import { supervisor } from "@host/processes/processes";
import { buildSkillTool, discoverSkills } from "@host/skills/skills";
import { buildTaskTools } from "@host/tools/tasks/tasks";
import { Effect } from "effect";
import type { ToolDef } from "../providers";
import { buildToolScriptTool } from "../tool-script/tool";
import { archiveReadTool, archiveUnpackTool } from "./archive/tool";
import { askUserTool } from "./ask-user";
import { astGrepTool } from "./ast-grep";
import { astGrepPath } from "./ast-grep-bin";
import { buildBashTool } from "./bash";
import { belayExpertTool } from "./belay-expert";
import { clipboardWriteTool } from "./clipboard";
import { docsTool } from "./docs/docs";
import { doctorTool } from "./doctor";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { buildLspCodeActionsTool } from "./lsp-code-actions";
import { buildLspDiagnosticsTool } from "./lsp-diagnostics";
import { buildLspDocumentSymbolsTool } from "./lsp-document-symbols";
import { buildLspHoverTool } from "./lsp-hover";
import { buildLspStatusTool } from "./lsp-status";
import { buildLspWorkspaceSymbolsTool } from "./lsp-workspace-symbols";
import { buildMcpTool } from "./mcp";
import { migrateClaudeTool } from "./migrate-claude";
import { multiEditTool } from "./multi-edit";
import { DEFAULT_PROMOTION_CONFIG } from "./promote-policy";
import { readTool } from "./read";
import { createToolRegistry } from "./registry";
import { sessionRecallTool } from "./session-recall";
import { skillViewTool } from "./skill-view";
import { skillsListTool } from "./skills-list";
import { loadSourceRecallConfig } from "./source-recall/config";
import { createSourceRecallRegistry } from "./source-recall/registry";
import { buildSourceRecallTools } from "./source-recall/tools";
import type { Tool } from "./types";
import { videoInspectTool } from "./video-inspect/tool";
import { webFetchTool } from "./web-fetch/web-fetch";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

export type { ToolError } from "./errors";
// The tool error classes and the `Tool`/`ToolError` contract are the package's public surface:
// tool-defining modules (processes/skills/tasks) and the executor discriminate failures by these
// tags and implement this interface. Re-exporting them here keeps `errors.ts`/`types.ts` internal
// and gives every consumer one import path (mirrors providers/index.ts).
export { ProcessError, ToolExecutionError, ToolInputError } from "./errors";
export { createToolRegistry, type ToolRegistry, toParametersJsonSchema } from "./registry";
export type { Tool } from "./types";

// The TOOLS array is heterogeneous (each tool decodes to its own params type), so it holds
// `Tool<any>`; each per-tool definition stays strongly typed at its own declaration.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each tool stays typed.
const FILE_TOOLS: readonly Tool<any>[] = [
  askUserTool,
  readTool,
  buildBashTool(supervisor, DEFAULT_PROMOTION_CONFIG),
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
  // source_recall / source_index_status / source_index_refresh (plan 38): indexed code search over a
  // prebuilt provider index (source-recall daemon first, Aleutian Trace second), selected from
  // <BELAY_HOME>/source-recall.json. The registry NEVER fails - a missing/unreachable backend yields
  // a structured "unavailable" result - so an unconfigured provider can't break an ordinary turn.
  ...buildSourceRecallTools(createSourceRecallRegistry(loadSourceRecallConfig())),
  skillsListTool,
  skillViewTool,
  doctorTool,
  belayExpertTool,
  // migrate_claude_md (plan 26, D-005/D-010): detect legacy CLAUDE.md files and propose migrating each
  // to a sibling AGENTS.md; a required-response serial barrier that blocks the turn and then mutates.
  migrateClaudeTool,
  // mcp (plan 23 M7): the model-facing surface over the host-wide MCP runtime singleton (the
  // supervisor/taskRegistry DI pattern); never readOnly - external calls are serial barriers (D-008).
  buildMcpTool(mcpRuntime),
  // lsp_* (plan 24 M3-M5): read-only PULL tools over the host-wide LSP manager singleton (D-001,
  // D-003) - every one a concurrent-safe read (D-007), and every degraded LSP outcome a bounded
  // SUCCESS string, never a turn failure (D-006).
  buildLspStatusTool(lspManager),
  buildLspDiagnosticsTool(lspManager),
  buildLspHoverTool(lspManager),
  buildLspDocumentSymbolsTool(lspManager),
  buildLspWorkspaceSymbolsTool(lspManager),
  buildLspCodeActionsTool(lspManager),
  // tool_script (plan 16): the bridge routes allowed read-only calls back through THIS registry's
  // executeTool (hoisted; referenced lazily at call time), gated by the request's toolsets. The child runs
  // out-of-process in a deny-first sandbox; its scratch dir is an ephemeral, per-run temp dir.
  buildToolScriptTool({
    execute: (tool, argsJson, runId, callId) =>
      Effect.runPromise(executeTool(tool, argsJson, runId, callId)),
    cwd: process.cwd(),
    makeScratchDir: () => mkdtempSync(join(tmpdir(), "belay-tool-script-")),
    cleanupScratchDir: (dir) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort scratch cleanup
      }
    },
  }),
  clipboardWriteTool,
  archiveUnpackTool,
  // video_inspect (plan 39): sample frames from a local video into blob artifacts and feed them
  // back to the model as vision input. A serial barrier - it forces the post-video finalization pass.
  videoInspectTool,
  supervisor.buildTool(),
  ...buildTaskTools(),
  // ast_grep is registered only when its project-managed binary resolves (skipped on a platform
  // without a prebuilt package), so the model is never offered a tool the host can't run.
  ...(astGrepPath() ? [astGrepTool] : []),
];

// Skill discovery (D-075). Two tool surfaces coexist over one registry:
//
//   - The canonical, forward path is the two-tool drill-in: `skills_list(query?, limit?)`
//     searches the compact registry METADATA, then `skill_view(skill_id)` loads exactly one
//     chosen body. Always present (they self-describe an empty registry), so non-web clients
//     and future resource types ride the same contract.
//   - The legacy `skill(name)` tool is kept as a COMPATIBILITY SHIM, added only when the
//     library is non-empty. It fuses the two levels: its description carries the ambient
//     roster (an always-on, cap-40 `skills_list()` with no query) and `skill(name)` loads one
//     body (the `skill_view(name)` step).
//
// Migration behavior: `skill(name)` is exactly `skill_view(name)` for the load, and its embedded
// roster is the no-query `skills_list()` for discovery. New clients should prefer
// `skills_list` + `skill_view`; the shim stays until ambient-roster delivery moves off the tool
// description (at which point `skill` is dropped, not re-pointed), so removing it never changes the
// canonical path - it only retires the fused alias.
const discoveredSkills = discoverSkills();
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each tool stays typed.
const TOOLS: readonly Tool<any>[] = discoveredSkills.length
  ? [...FILE_TOOLS, buildSkillTool(discoveredSkills)]
  : FILE_TOOLS;

/**
 * Names of the tools the loop may run concurrently. The classification is owned by the
 * cross-surface vocabulary in `@belay/session` (D-031) - the single source both the host
 * and the web consume - so it can never drift between the two surfaces. A parity test
 * (index.test.ts) cross-checks this shared table against the real `TOOLS` defs, so adding a
 * host tool or flipping its `readOnly` flag without updating the table fails the build. A
 * tool absent from the read-only set is a mutating serial barrier. The loop partitions a
 * step's tool batch against this set (D-050).
 */
export const DEFAULT_TOOL_REGISTRY = createToolRegistry({
  tools: TOOLS,
  readOnlyTools: READ_ONLY_TOOL_NAMES,
});

export const READ_ONLY_TOOLS: ReadonlySet<string> = DEFAULT_TOOL_REGISTRY.readOnlyTools;

/** Tool definitions advertised to the model (parameters derived from each tool's schema). */
export const TOOL_DEFS = DEFAULT_TOOL_REGISTRY.toolDefs;

/**
 * The exact tool-def set the model is OFFERED for one turn: the registry tools when tools are enabled,
 * narrowed to a subagent's allow-list (`toolNames`), plus a parent turn's delegation defs. The ONE
 * owner of this filter-then-append rule, so the turn's breakdown overhead (which SIZES the offered
 * set) can't silently diverge from what the loop actually hands the model.
 */
export function offeredToolDefs(
  useTools: boolean,
  toolNames: ReadonlySet<string> | undefined,
  delegateDefs: readonly ToolDef[] | undefined,
): readonly ToolDef[] {
  return DEFAULT_TOOL_REGISTRY.offeredToolDefs(useTools, toolNames, delegateDefs);
}

/**
 * Executes a tool by name with a raw JSON argument string, as an Effect that never
 * fails: a tool's typed ToolError is rendered to an `error:` result the model can read -
 * one bad tool call must not collapse the whole turn - and attributed to that tool in
 * the host log. `runId` (the turn's correlation id) only tags the boundary log.
 *
 * The raw arguments are decoded once here against the tool's schema; a decode failure is a
 * ToolInputError carrying the formatted reason, rendered through the same `error:` path.
 */
export function executeTool(
  name: string,
  argumentsJson: string,
  runId?: string,
  callId?: string,
): Effect.Effect<string> {
  return DEFAULT_TOOL_REGISTRY.executeTool(name, argumentsJson, runId, callId);
}

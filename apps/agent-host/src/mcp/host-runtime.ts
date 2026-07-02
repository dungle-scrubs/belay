import { warn } from "@host/transport/log";
import { loadMcpServersConfig } from "./config";
import { createMcpRuntime, type McpRuntime } from "./runtime";

/**
 * The host-wide MCP runtime singleton (plan 23 M7), in the supervisor/taskRegistry tradition:
 * one lazy runtime over the user's `<TREVOR_HOME>/mcp-servers.json`, shared by the model-facing
 * `mcp` tool (tools/mcp.ts via tools/index.ts), the /doctor facts, and main.ts shutdown.
 * Construction connects NOTHING (the runtime is lazy per server), so an unconfigured or unused
 * MCP install costs no process, socket, or file handle. Config issues are structured warnings
 * at load, never a crash. Stdio children exit on parent death regardless of an explicit close
 * (their stdin pipe closes), so a hard exit cannot orphan them.
 *
 * Responsible for: constructing and exporting the one host MCP runtime and surfacing its
 * config-load issues.
 * Not for: config normalization (./config), runtime mechanics (./runtime), or the model-facing
 * surface (@host/tools/mcp).
 */

const config = loadMcpServersConfig();

for (const issue of config.issues) {
  warn("mcp", "dropped mcp-servers.json entry", {
    server: issue.server,
    kind: issue.kind,
    detail: issue.detail,
  });
}

/** The one host MCP runtime; lazy, so importing this connects to nothing. */
export const mcpRuntime: McpRuntime = createMcpRuntime(config.servers, {
  clientInfo: { name: "trevor", version: process.env.npm_package_version ?? "dev" },
});

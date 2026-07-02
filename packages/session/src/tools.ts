/**
 * The cross-surface tool vocabulary - the single source of truth for the set of tool
 * NAMES the host exposes and the read-only classification that drives concurrent
 * dispatch. The host derives its `READ_ONLY_TOOLS` from this table (a parity test keeps
 * the real tool defs and this table in lockstep), and the web reads the same set to group
 * consecutive read-only tool rows into one concurrent block. Both surfaces consume this
 * one descriptor so the classification cannot drift between them (plan D-031).
 *
 * This module owns only the vocabulary (names + read-only flag). It does NOT own tool
 * IMPLEMENTATIONS - those live in the host (`apps/agent-host/src/tools`), which is the
 * authority on each tool's nature. A read-only tool only reads state and never mutates the
 * workspace, so the agent loop may run a run of such calls concurrently; any other tool is
 * a mutating serial barrier (D-050).
 */

export interface ToolDescriptor {
  readonly name: string;
  /** True for a tool with no observable side effects (the agent loop may run it concurrently). */
  readonly readOnly: boolean;
}

export const TOOL_DESCRIPTORS = [
  // ask_user pauses the turn for a user decision, so it is a serial barrier, never run concurrently.
  { name: "ask_user", readOnly: false },
  { name: "read", readOnly: true },
  { name: "glob", readOnly: true },
  { name: "grep", readOnly: true },
  { name: "web_search", readOnly: true },
  { name: "web_fetch", readOnly: true },
  { name: "archive_read", readOnly: true },
  { name: "docs", readOnly: true },
  { name: "session_recall", readOnly: true },
  { name: "ast_grep", readOnly: true },
  { name: "doctor", readOnly: true },
  // clipboard_write mutates external clipboard state (a side effect), so it is a serial barrier.
  { name: "clipboard_write", readOnly: false },
  { name: "bash", readOnly: false },
  { name: "write", readOnly: false },
  { name: "edit", readOnly: false },
  { name: "multi_edit", readOnly: false },
  { name: "archive_unpack", readOnly: false },
  { name: "process", readOnly: false },
  { name: "task_create", readOnly: false },
  { name: "task_update", readOnly: false },
  { name: "task_list", readOnly: true },
  { name: "skill", readOnly: false },
  { name: "skills_list", readOnly: true },
  { name: "skill_view", readOnly: true },
  // trevor_expert only reads the host-generated capability manifest; a serial-safe pure read.
  { name: "trevor_expert", readOnly: true },
  // mcp calls external MCP servers, which mutate EXTERNAL service state (a different risk axis
  // than workspace mutation), so it is always a mutating serial barrier (plan 23 D-008).
  { name: "mcp", readOnly: false },
  // lsp_* (plan 24) are explicit read-only language-server pulls (D-003/D-007): they only read
  // server-reported facts (status, diagnostics) and never mutate the workspace.
  { name: "lsp_status", readOnly: true },
  { name: "lsp_diagnostics", readOnly: true },
  // tool_script runs a bounded READ-ONLY script through a read-only bridge; no mutation, serial-safe.
  { name: "tool_script", readOnly: true },
] as const satisfies readonly ToolDescriptor[];

/** Every tool name the host exposes, in declaration order. */
export const TOOL_NAMES = TOOL_DESCRIPTORS.map((tool) => tool.name);

/** The union of every tool name (useful for an exhaustive renderer dispatch, M29). */
export type ToolName = (typeof TOOL_DESCRIPTORS)[number]["name"];

/**
 * The names of the read-only tools, derived from the table - the single classification both
 * the host (concurrent dispatch) and the web (concurrent-tools grouping) consume. A new
 * read-only tool joins just by declaring `readOnly: true` here (and in its host tool def,
 * which the parity test cross-checks).
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_DESCRIPTORS.filter((tool) => tool.readOnly).map((tool) => tool.name),
);

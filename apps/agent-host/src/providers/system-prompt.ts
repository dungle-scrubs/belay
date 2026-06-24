import { taskRegistry } from "../tasks";
import { HOST_CWD_TOOLS, WORKSPACE_CONFINED_TOOLS, WORKSPACE_ROOT } from "../tools/workspace";
import type { ToolDef } from "./types";

/** Oxford-comma join: "a", "a and b", "a, b, and c" - matches the prompt's prose. */
function listAnd(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// The confinement rule, rendered once from the workspace policy (tools/workspace.ts) so
// the prompt cannot advertise a confinement the tools do not enforce. Two phrasings for
// the two prompt locations (tool-selection guidance vs. the execution-context header);
// both derive the same confined / host-cwd tool lists.
const CONFINED = listAnd(WORKSPACE_CONFINED_TOOLS);
const HOST_CWD = listAnd(HOST_CWD_TOOLS);
const CONFINEMENT_GUIDANCE = `${CONFINED} are scoped to the workspace root; use paths relative to it. ${HOST_CWD} use the host working directory and accept absolute paths.`;
const CONFINEMENT_EXECUTION = `${CONFINED} are confined to the workspace root; ${HOST_CWD} run from the host working directory and accept absolute paths.`;

/**
 * Who Trevor is and what the turn is for. Kept tool-agnostic so it holds whether or
 * not a route advertises tools.
 */
const IDENTITY =
  "You are Trevor, a coding agent working directly in the user's development environment. Complete software tasks by reading and editing files and running shell commands through the tools provided, then report concrete results.";

/** General coding-agent conduct, phrased for this host's actual tool surface. */
const CODING_GUIDANCE = [
  "Use glob to discover files by name or path, and grep to find exact strings, symbols, error text, or patterns across the workspace.",
  "Read the relevant code before making implementation or architecture claims; do not assume behavior from file names alone.",
  "Prefer the repository's existing patterns, frameworks, helper APIs, and component boundaries over inventing new abstractions.",
  "Keep edits tightly scoped to the requested change and avoid unrelated refactors or metadata churn.",
  "Do not revert, overwrite, or discard the user's changes unless they explicitly ask for that exact operation.",
  "Avoid destructive shell commands such as git reset --hard, git checkout --, git clean, or force push unless the user explicitly requests that operation.",
  "When asked to implement a change, carry it through with edits and appropriate verification before reporting completion.",
] as const;

/** How to pick between this host's tools, and the workspace confinement contract. */
const TOOL_SELECTION_GUIDANCE = [
  "Prefer read, write, and edit over bash when a dedicated file tool fits the task.",
  "Use grep for exact strings, symbols, error text, or regular expressions, and glob for path or filename discovery.",
  "edit requires its 'old' text to appear exactly once in the file; read the file first to choose a unique anchor, or use write for a full rewrite.",
  CONFINEMENT_GUIDANCE,
  "Use tools when they are the best fit for the task instead of claiming you have no tool access.",
];

/** How to maintain the working checklist (ported from V1's task guidance). */
const TASK_GUIDANCE = [
  "For multi-step work, track it as a checklist with task_create and task_update; skip the checklist for trivial single-step requests.",
  "Mark a task in_progress when you start it and completed the moment it is done; keep exactly one task in_progress at a time.",
  "Retire tasks that are no longer relevant or were superseded with task_update status deleted; on a new topic, delete stale tasks and start a fresh list rather than extending a finished one.",
  "Completing the final open task clears the checklist automatically - do not try to clear it by hand.",
  "Never create fake or demo tasks; if asked for an example task list, render it as ordinary text instead of real task records.",
] as const;

/** Guardrails that keep tool calls grounded in real paths instead of placeholders. */
const REPO_GUARDRAILS = [
  "When the user names a path or search target, act on it with glob or grep instead of asking for clarification.",
  "Use '.' or a real existing path for the workspace root; never invent placeholder paths like /path/to/repo.",
  "For codebase structure reviews, begin from existing top-level files like README.md or AGENTS.md; do not assume directories such as src/ exist.",
] as const;

/**
 * Anti-sycophancy and wording constraints. Verbatim-in-spirit from the original
 * Trevor host; these are model-conduct rules and apply regardless of tools.
 */
const RESPONSE_CALIBRATION_GUIDANCE = [
  "Never use the em dash",
  "Resist sycophancy. User pushback is a signal to re-check reasoning, not to reverse position.",
  "Do not agree with the user merely because they propose an alternative or challenge your prior answer. Treat disagreement as a request to re-evaluate, not as evidence that the user is right.",
  "When the user challenges a recommendation, re-state the decision criteria, compare the options against those criteria, and say clearly whether your original answer changes.",
  "If your answer changes, explain the new reasoning that caused the change; if it does not, say so directly and explain why.",
  "Prefer the technically correct answer over the socially agreeable answer.",
  'Never use "honest" to describe data, state, schemas, or records, such as "this keeps the data honest."',
] as const;

/** Where the agent's file tools operate, so the model resolves paths correctly. */
export interface SystemPromptContext {
  /** Root that edit/glob/grep are confined to. Defaults to WORKSPACE_ROOT. */
  readonly workspaceRoot?: string;
  /** Host working directory read and bash run from. Defaults to process.cwd(). */
  readonly cwd?: string;
}

function executionContext(workspaceRoot: string, cwd: string): string {
  const lines = [`Workspace root: ${workspaceRoot}`];
  if (cwd !== workspaceRoot) {
    lines.push(`Host working directory: ${cwd}`);
  }
  lines.push(CONFINEMENT_EXECUTION);
  return lines.join("\n");
}

/** A `- name: description` line per advertised tool, under an inventory header. */
function toolInventory(tools: readonly ToolDef[]): string {
  const lines = tools.map((tool) => `- ${tool.name}: ${tool.description}`);
  return ["You have access to these tools:", ...lines].join("\n");
}

/**
 * Builds the system prompt for one model request. The tool inventory is rendered
 * from the same `tools` array the provider sends to the model, so the advertised
 * surface can never drift from what is actually callable. With no tools (an
 * answer-only route), the inventory and tool guidance are dropped but the identity,
 * execution context, and calibration rules remain.
 */
export function buildSystemPrompt(
  tools: readonly ToolDef[] = [],
  context: SystemPromptContext = {},
): string {
  const workspaceRoot = context.workspaceRoot ?? WORKSPACE_ROOT;
  const cwd = context.cwd ?? process.cwd();

  if (tools.length === 0) {
    return [
      IDENTITY,
      executionContext(workspaceRoot, cwd),
      RESPONSE_CALIBRATION_GUIDANCE.join("\n"),
      "No tools are available on this route; answer directly in ordinary text.",
    ].join("\n\n");
  }

  const guidance = [
    ...CODING_GUIDANCE,
    ...TOOL_SELECTION_GUIDANCE,
    ...TASK_GUIDANCE,
    ...REPO_GUARDRAILS,
    ...RESPONSE_CALIBRATION_GUIDANCE,
  ].join("\n");

  // The live checklist is re-rendered every turn, so the model's plan survives
  // history compaction instead of living only in the (compactable) transcript.
  const checklist = taskRegistry.renderForPrompt();
  return [
    IDENTITY,
    executionContext(workspaceRoot, cwd),
    toolInventory(tools),
    guidance,
    ...(checklist ? [checklist] : []),
  ].join("\n\n");
}

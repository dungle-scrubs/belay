import type { ContextRegistry } from "../context/registry";
import { contextRegistry } from "../context/registry";
import { HOST_CWD_TOOLS, WORKSPACE_CONFINED_TOOLS, WORKSPACE_ROOT } from "../paths";
import type { TaskRegistry } from "../tasks";
import { taskRegistry } from "../tasks";
import type { ToolDef } from "./types";

/**
 * Owns system-prompt assembly and the registry reads that feed it: the context registry
 * (AGENTS.md, eager + lazy) and the task registry (the live checklist) are rendered for the
 * prompt only from here, alongside the confinement policy (paths.ts) and the tool-inventory
 * rendering. Call sites ask the builder for a prompt; they do not import the registries to
 * render them, and they do not thread workspaceRoot/cwd when the builder's defaults suffice.
 *
 * It does NOT own tool execution, and it does NOT own the registries' MUTATION by tools:
 * `contextRegistry.noteFileAccess(...)` is still driven by the read/write/edit tools as they
 * touch files (that is tool-execution timing, not prompt assembly), and the task tools still
 * mutate `taskRegistry`. The builder is the single READ point for prompt assembly, not the
 * owner of when those registries change.
 */

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

// The confinement rule, rendered once from the workspace policy (paths.ts) so
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
  "Never end a turn by announcing an action you then do not take ('let me read...', 'let me continue...'): in the same step, actually call the tools to do it. Only stop when the task is done or you need the user - and then give a real final answer, not a promise to continue.",
] as const;

/** How to pick between this host's tools, and the workspace confinement contract. */
const TOOL_SELECTION_GUIDANCE = [
  "Prefer read, write, and edit over bash when a dedicated file tool fits the task.",
  "Use grep (ripgrep-backed text/regex search) for exact strings, symbols, error text, or regular expressions, and glob for path or filename discovery.",
  "Use ast_grep for STRUCTURAL (syntax-aware) search when text/regex is awkward - e.g. finding a call shape like 'console.log($$$)' or a function/JSX pattern regardless of formatting; it is read-only and only available when its binary is installed.",
  "The doctor tool runs Trevor's own host self-diagnostic (provider/model auth readiness, internet reachability, available tools, storage, and workspace) and returns a health report; call it only when the user asks about Trevor's own health, setup, why a turn failed, or whether a provider/model/tool is available - never as routine context-gathering for ordinary coding work.",
  "Use web_search for DISCOVERY - finding which page answers a question - and web_fetch to READ a source you already have a URL for (the docs page, article, or API/JSON endpoint a search surfaced). Search to locate, then fetch the selected URL to read it; do not fetch a URL you have not first found or been given.",
  "web_fetch reads ONE explicit public URL. Its backend ladder is static first; it falls back to the Jina reader only when the static page is unusable (thin or JS-rendered); and Firecrawl is a scarce final fallback - configured-only and used last, only when both static and Jina fail. Prefer the default mode and a single fetch per source rather than forcing rendered mode.",
  "Use docs for CURRENT EXTERNAL documentation - the official docs of a product, API, library, SDK, or service (setup, usage, configuration, limits, reference). docs resolves a subject into a cached, citeable corpus you then search and read, layering caching and source citations over web_search/web_fetch; reach for it when you need authoritative external reference material rather than a single one-off page read.",
  "Do NOT use docs for the active workspace's own source truth - how THIS repository actually behaves, what its code, config, types, or tests do, or its local plans. That stays on read, glob, grep, ast_grep, the tests, and the compiler output, never docs; docs is for external documentation and is never a substitute for reading the repo you are working in.",
  "Independent read-only lookups (read, glob, grep, web_search) run in parallel when you request several in a single step, so batch them together instead of one at a time; edits, writes, and bash run sequentially, so issue those one per step.",
  "edit requires its 'old' text to appear exactly once in the file; read the file first to choose a unique anchor, or use write for a full rewrite.",
  "Use ask_user ONLY when a concrete missing decision blocks useful progress - it pauses the turn until the user answers. Offer concrete choices and mark the one you recommend; do not use it to gather broad open-ended preferences or to ask what you can determine yourself by reading the code.",
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
  "For codebase structure reviews, begin from existing top-level files like README.md; any AGENTS.md instructions for this repository are already provided in the project-context block above, so follow them without re-reading those files.",
  "Do not start discovery with the broad glob '**/*'; it returns a capped, partial slice. Begin with top-level files or a targeted pattern (a subdirectory or extension, e.g. src/**/*.ts) and widen only as needed.",
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
  /**
   * The active output style's response-shape guidance (plan 03, M6). PRESENTATION ONLY: it shapes how
   * the answer reads and nothing else - it never changes the tool inventory, model, reasoning, agents,
   * or execution. Empty (the default style) contributes no block. Threaded in by the caller from the
   * persisted style preference; the builder stays unaware of how a style is chosen or stored.
   */
  readonly styleGuidance?: string;
}

/** The presentation-only style block, or "" for the default style (no guidance). */
function styleBlock(guidance: string | undefined): string {
  return guidance
    ? `Response style (presentation only, does not change tools or behavior): ${guidance}`
    : "";
}

interface PromptRegistrySnapshot {
  readonly contextBlock: string;
  readonly checklist: string;
}

interface PromptBlock {
  readonly enabled?: boolean;
  readonly render: () => string;
}

function renderBlocks(blocks: readonly PromptBlock[]): string {
  return blocks
    .filter((block) => block.enabled ?? true)
    .map((block) => block.render())
    .filter((text) => text.length > 0)
    .join("\n\n");
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
 * Assembles the per-turn system prompt and owns the registry reads that feed it. The
 * context + task registries are injected (defaulting to the module singletons), so the
 * builder is the one place that renders them FOR THE PROMPT; the tool inventory, the
 * confinement policy, and the prompt copy are assembled here too.
 */
export class SystemPromptBuilder {
  constructor(
    private readonly context: ContextRegistry = contextRegistry,
    private readonly tasks: TaskRegistry = taskRegistry,
  ) {}

  private registrySnapshot(cwd: string, workspaceRoot: string): PromptRegistrySnapshot {
    return {
      contextBlock: this.context.renderForPrompt(cwd, workspaceRoot),
      checklist: this.tasks.renderForPrompt(),
    };
  }

  /**
   * Builds the system prompt for one model request. The tool inventory is rendered
   * from the same `tools` array the provider sends to the model, so the advertised
   * surface can never drift from what is actually callable. With no tools (an
   * answer-only route), the inventory and tool guidance are dropped but the identity,
   * execution context, and calibration rules remain.
   */
  build(tools: readonly ToolDef[] = [], context: SystemPromptContext = {}): string {
    const workspaceRoot = context.workspaceRoot ?? WORKSPACE_ROOT;
    const cwd = context.cwd ?? process.cwd();
    const snapshot = this.registrySnapshot(cwd, workspaceRoot);

    const style = styleBlock(context.styleGuidance);

    if (tools.length === 0) {
      return renderBlocks([
        { render: () => IDENTITY },
        { render: () => executionContext(workspaceRoot, cwd) },
        { enabled: style.length > 0, render: () => style },
        { render: () => RESPONSE_CALIBRATION_GUIDANCE.join("\n") },
        { render: () => "No tools are available on this route; answer directly in ordinary text." },
      ]);
    }

    const guidance = [
      ...CODING_GUIDANCE,
      ...TOOL_SELECTION_GUIDANCE,
      ...TASK_GUIDANCE,
      ...REPO_GUARDRAILS,
      ...RESPONSE_CALIBRATION_GUIDANCE,
    ].join("\n");

    return renderBlocks([
      { render: () => IDENTITY },
      { render: () => executionContext(workspaceRoot, cwd) },
      { render: () => toolInventory(tools) },
      { enabled: snapshot.contextBlock.length > 0, render: () => snapshot.contextBlock },
      { render: () => guidance },
      { enabled: style.length > 0, render: () => style },
      { enabled: snapshot.checklist.length > 0, render: () => snapshot.checklist },
    ]);
  }
}

/** The host's prompt builder, wired to the session's context + task registries. */
export const systemPromptBuilder = new SystemPromptBuilder();

/**
 * The stable free-function entry, delegating to the singleton builder. Call sites keep a
 * single import; the registry reads for the prompt all live behind `systemPromptBuilder`.
 */
export function buildSystemPrompt(
  tools: readonly ToolDef[] = [],
  context: SystemPromptContext = {},
): string {
  return systemPromptBuilder.build(tools, context);
}

/**
 * The fixed prompt OVERHEAD in characters for a turn: the system prompt plus the tool schemas the
 * provider re-sends every step. The one owner of the `systemPrompt.length + JSON.stringify(tools).length`
 * formula, shared by the turn's breakdown seed and the provider's overflow estimate so the two can't
 * disagree on overhead. Empty tools contribute nothing (no `"[]"` 2-char artifact).
 */
export function promptOverheadChars(
  systemPrompt: string | undefined,
  tools: readonly ToolDef[],
): number {
  return (systemPrompt?.length ?? 0) + (tools.length > 0 ? JSON.stringify(tools).length : 0);
}

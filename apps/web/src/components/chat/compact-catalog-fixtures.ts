import { lucidArtifactRef } from "@belay/session";
import type { Message, ToolMessage } from "../../transcript";
import { inlineAgent } from "./inline-agent-fixtures";

/**
 * The compact transcript CATALOG fixtures (plan 58): one 1-2 line exemplar of every `Message.kind`,
 * plus the tool type-variants the spacing rule cares about (a read-only run that batches, two distinct
 * mutating tools, two same-named mutating calls, and MCP tools). Shared by `compact-catalog.stories.tsx`
 * (the visual all-types catalog) and `compact-catalog.test.tsx` (coverage + state assertions), so the
 * visual baseline and the tests exercise the same shapes.
 *
 * `catalogTranscript` is the resting/settled catalog ordered to make the type-aware spacing legible
 * (a read-only batch, a flush run of same-name edits, then one gap per distinct type). `catalogActive`
 * carries the running/streaming forms of the kinds that have a resting-vs-active duality (a tool, an
 * assistant segment, a delegation), so the story can show both states next to each other.
 */

/**
 * Compile-time coverage guard: every `Message.kind` must have an entry here, so adding a new kind to the
 * union without a catalog fixture fails typecheck. The runtime test then asserts each listed kind
 * actually appears in `catalogTranscript`.
 */
const CATALOG_KIND_COVERAGE: Record<Message["kind"], true> = {
  user: true,
  assistant: true,
  tool: true,
  result: true,
  recovered: true,
  continued: true,
  reconnecting: true,
  guardrail: true,
  compacting: true,
  delegation: true,
  inlineAgent: true,
  shell: true,
  question: true,
  hookDecision: true,
  modelSwitch: true,
  limit: true,
  lucid: true,
};

/** Every `Message.kind` the catalog is expected to cover (derived from the exhaustive guard above). */
export const CATALOG_KINDS = Object.keys(CATALOG_KIND_COVERAGE) as Message["kind"][];

/** Build a settled (result given) or in-flight (result omitted) tool message. Shared with the transcript
 *  stories so the tool-message shape has one definition. */
export function toolMessage(id: string, name: string, args: object, result?: string): ToolMessage {
  return {
    kind: "tool",
    id,
    name,
    args: JSON.stringify(args),
    done: result !== undefined,
    ...(result !== undefined ? { result } : {}),
  };
}

/**
 * The resting catalog: one settled exemplar of every kind, ordered so the type grouping reads clearly -
 * a read-only run (read/glob/grep) that folds into one batch, two same-name edits that sit flush, then
 * distinct mutating + MCP tools and the quiet markers, each its own type.
 */
export function catalogTranscript(): Message[] {
  return [
    {
      kind: "user",
      id: "u1",
      text: "Refactor the turn loop and run the tests.",
      artifacts: [],
      pastes: [],
    },
    // A settled thinking-only segment (no visible text) -> collapses to a "Thought" compact row.
    {
      kind: "assistant",
      id: "a-think",
      runId: "r1",
      text: "",
      thinking: "Read the loop, grep the call sites, then edit.",
      done: true,
      warm: false,
      model: "glm",
    },
    // A read-only run: 3 consecutive read-only tools fold into one concurrent batch (one "readonly" type).
    toolMessage(
      "t-read",
      "read",
      { path: "apps/agent-host/src/turn-loop.ts" },
      "export function runTurn() {…}",
    ),
    toolMessage("t-glob", "glob", { pattern: "**/*.ts", path: "apps/agent-host/src" }, "42 files"),
    toolMessage(
      "t-grep",
      "grep",
      { pattern: "runTurn", path: "apps/agent-host/src" },
      "12 matches",
    ),
    // Two same-named mutating tools: same "tool:edit" type, so they sit flush.
    toolMessage("t-edit1", "edit", { path: "apps/agent-host/src/turn-loop.ts" }, "applied 1 edit"),
    toolMessage(
      "t-edit2",
      "edit",
      { path: "apps/agent-host/src/step-budget.ts" },
      "applied 1 edit",
    ),
    // Distinct mutating tools: each its own type, so each opens one gap.
    toolMessage("t-write", "write", { path: "apps/agent-host/src/notes.md" }, "wrote 12 lines"),
    toolMessage("t-bash", "bash", { command: "pnpm test" }, "error: 2 tests failed"),
    // MCP tools: the gateway `mcp` and a passthrough `mcp__*` name, each its own type, never the readonly bucket.
    toolMessage("t-mcp1", "mcp", { server: "linear", tool: "list_issues" }, "8 issues"),
    toolMessage("t-mcp2", "mcp__github__create_issue", { title: "Flaky test" }, "created #4213"),
    {
      kind: "shell",
      id: "sh1",
      requestId: "rq1",
      command: "git status",
      done: true,
      ok: true,
      output: "clean",
    },
    { kind: "result", id: "c1", command: "doctor", text: "all green\n3 checks passed", ok: true },
    {
      kind: "question",
      id: "q1",
      questionId: "qq1",
      runId: "r1",
      outcome: "answered",
      items: [{ id: "i1", question: "Which date library?", answer: "date-fns" }],
      summary: "Picked date-fns",
    },
    {
      kind: "delegation",
      id: "d1",
      childSessionId: "child-1",
      agent: "Explore",
      task: "map the transcript module",
      mode: "async",
      status: "done",
      result: "17 message kinds; one renderer",
    },
    {
      kind: "inlineAgent",
      id: "ia1",
      parentRunId: "r1",
      agents: [inlineAgent({ status: "done" })],
    },
    {
      kind: "lucid",
      id: "lc1",
      lucidId: "roadmap",
      title: "Q3 Roadmap",
      version: 1,
      artifact: lucidArtifactRef({
        htmlHash: "sha256-roadmap",
        size: 0,
        meta: {
          lucidId: "roadmap",
          version: 1,
          provenance: "agent",
          reviewStatus: "open",
          title: "Q3 Roadmap",
        },
      }),
    },
    {
      kind: "recovered",
      id: "rec1",
      action: "Trimmed a tool result",
      detail: "freed ~2k tokens",
      reclaimed: 2048,
    },
    { kind: "continued", id: "cont1", steps: 12, pressure: 0.4, detail: "headroom + progress" },
    {
      kind: "reconnecting",
      id: "reconnecting:r-catalog",
      attempt: 2,
      maxAttempts: 10,
      detail: "502 Bad Gateway",
    },
    { kind: "guardrail", id: "g1", tool: "bash", action: "blocked", reason: "repeat", count: 3 },
    { kind: "compacting", id: "cm1", foldId: "f1", tokens: 400, budget: 1000 },
    {
      kind: "hookDecision",
      id: "hk1",
      hookId: "user:policy",
      event: "PreToolUse",
      decision: "deny",
      toolName: "bash",
      reason: "blocked by policy",
    },
    {
      kind: "modelSwitch",
      id: "ms1",
      from: { model: "deepseek-v4", reasoning: "low" },
      to: { model: "deepseek-v4", reasoning: "high" },
      initiator: "manual",
      outcome: "applied",
    },
    {
      kind: "limit",
      id: "lm1",
      provider: "anthropic",
      status: "approaching",
      scope: "five_hour",
      utilization: 0.9,
    },
    // The final assistant RESPONSE (visible text) stays full even in compact mode (the primacy rule).
    {
      kind: "assistant",
      id: "a-final",
      runId: "r1",
      text: "Refactored `runTurn` into smaller steps and fixed the two failing tests. The suite is green.",
      thinking: "",
      done: true,
      warm: false,
      model: "glm",
    },
  ];
}

/**
 * The active/streaming forms of the kinds with a resting-vs-active duality: an in-flight tool (spinner),
 * a streaming assistant thought ("Thinking"), a running delegation, plus the inherently-active
 * reconnecting + compacting markers. Shown beside the resting catalog so both states are visible.
 */
export function catalogActive(): Message[] {
  return [
    toolMessage("t-run", "bash", { command: "pnpm build" }), // no result -> running spinner
    {
      kind: "assistant",
      id: "a-stream",
      runId: "r2",
      text: "",
      thinking: "Weighing the two approaches before I edit.",
      done: false,
      warm: true,
      model: "glm",
    },
    {
      kind: "delegation",
      id: "d-run",
      childSessionId: "child-2",
      agent: "Plan",
      task: "design the migration",
      mode: "async",
      status: "running",
    },
    {
      kind: "reconnecting",
      id: "reconnecting:r-run",
      attempt: 2,
      maxAttempts: 10,
      detail: "<html><body><h1>502 Bad Gateway</h1><p>ZenZG tunnel unavailable</p></body></html>",
    },
    { kind: "compacting", id: "cm-run", foldId: "f2", tokens: 250, budget: 1000 },
  ];
}

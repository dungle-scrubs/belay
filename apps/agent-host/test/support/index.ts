// Host test-support, re-exported for the e2e workspace via the @trevor/agent-host/testing
// export. Keeps the fake provider and turn driver in one place for both host integration
// tests (which import this folder relatively) and cross-service e2e (which imports the package).

// The ask_user pending-question runtime singleton, exposed so cross-service e2e can wire its emitter to
// the store and drive submitAnswer (the role main.ts's inbound lane plays in the real host).
export { providerQuestionRuntime } from "@host/agent/provider-questions";
// The mid-turn-switch cell + the turn driver (plan 09.1), so cross-service e2e can drive a real turn that
// changes model/reasoning between steps through the same publishTurn -> runAgent path the host uses.
export { createSwitchCell, type SwitchCell } from "@host/agent/switch-cell";
export { publishTurn } from "@host/agent/turn";
export { type ActiveTurn, isAnswerablePrompt, TurnScheduler } from "@host/agent/turn-scheduler";
// Continuation handoff (02): the direct-flow orchestration + the turn-dispatch scheduler and the
// self-echo predicate, so cross-service e2e can drive a handoff through a real store and replay the
// target log through the same scheduling logic the real host uses (the role main.ts plays live).
export {
  type DirectHandoffDeps,
  executeFinalizedHandoff,
  runDirectHandoff,
} from "@host/handoff/handoff-flow";
// The LSP seam (plan 24 M9): the host manager singleton, so cross-service e2e can drive the
// registered lsp_* tools over a hermetic fixture workspace (see ./lsp-fixtures) and shut the
// managed server down in afterAll (the role main.ts's shutdown path plays live).
export { lspManager } from "@host/lsp/host-runtime";
// The MCP seam (plan 23 M9): the config loader, runtime constructor, host singleton, and
// model-facing tool builder, so cross-service e2e can drive every capability path over hermetic
// fixture servers (see ./mcp-fixtures) through the exact construction the host uses.
export { loadMcpServersConfig, type McpServerConfig } from "@host/mcp/config";
export { mcpRuntime } from "@host/mcp/host-runtime";
export type {
  McpElicitationAnswer,
  McpElicitationRequest,
  McpSamplingCompletion,
  McpSamplingRequest,
} from "@host/mcp/mediation";
export { createMcpRuntime, type McpRuntime } from "@host/mcp/runtime";
// The background-job promotion runtime (plan 09), so cross-service e2e can drive a real promotable shell
// command through the supervisor (promote -> tracked pN -> kill) the way the bash tool / shell lane do.
export { ProcessRegistry } from "@host/processes/process-registry";
// The project-context system (plan 26 M8): the pure eager render + the session ContextRegistry (eager +
// lazy AGENTS.md and .trevor/rules) + the /init proposal builder + the pointer sentinel, so
// cross-service e2e can exercise real context ordering, lazy loading, /init drafting, and
// already-converted-pointer fixtures over a hermetic temp workspace.
export { collectEagerSources, renderContext } from "@host/project-context/agents-md";
export { CLAUDE_POINTER_SENTINEL } from "@host/project-context/claude-migration";
export { buildInitProposal } from "@host/project-context/init-agents";
export { ContextRegistry } from "@host/project-context/registry";
export type { ChatMessage, Provider, ProviderEvent } from "@host/providers";
// The typed provider error, so cross-service e2e can drive a retryable transport drop through a real
// store (the DeepSeek-style thinking-only reconnect path) without reaching into host internals.
export { ProviderUnavailable } from "@host/providers/errors";
// The typed tool failures + the model-facing mcp tool builder (plan 23 M9), so the e2e MCP
// capability suite discriminates failures and drives the same action surface the model sees.
export { ToolExecutionError, ToolInputError } from "@host/tools/errors";
export { buildMcpTool, type McpArgs } from "@host/tools/mcp";
export { runPromotable } from "@host/tools/promote-runner";
// The eval/automation harness (plan 28 M10): boots stores + SDK client + a scriptable fake-provider host
// into a `run() -> structured record` loop, so an eval or automation drives Trevor through the same
// headless SDK layer a script would, with the live lane gated by an explicit skip reason.
export {
  attachFakeHost,
  createFakeEvalHarness,
  type EvalHarness,
  type EvalRunInput,
  type EvalRunRecord,
  type FakeHostHandle,
  type LiveLaneStatus,
  liveLaneStatus,
} from "./eval-harness";
export * from "./fake-provider";
// The hermetic fake-LM-Studio residency fixture (plan 11.1 M7), so cross-service e2e can drive two host
// instances reference-counting residency claims over one real cross-process admission store.
export {
  type FakeLmStudioResidency,
  type FakeResidencyInstance,
  makeFakeLmStudioResidency,
} from "./residency-fixture";

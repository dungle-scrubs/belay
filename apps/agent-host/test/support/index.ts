// Host test-support, re-exported for the e2e workspace via the @trevor/agent-host/testing
// export. Keeps the fake provider and turn driver in one place for both host integration
// tests (which import this folder relatively) and cross-service e2e (which imports the package).

// The ask_user pending-question runtime singleton, exposed so cross-service e2e can wire its emitter to
// the store and drive submitAnswer (the role main.ts's inbound lane plays in the real host).
export { providerQuestionRuntime } from "../../src/agent/provider-questions";
export { type ActiveTurn, isAnswerablePrompt, TurnScheduler } from "../../src/agent/turn-scheduler";
// Continuation handoff (02): the direct-flow orchestration + the turn-dispatch scheduler and the
// self-echo predicate, so cross-service e2e can drive a handoff through a real store and replay the
// target log through the same scheduling logic the real host uses (the role main.ts plays live).
export {
  type DirectHandoffDeps,
  executeFinalizedHandoff,
  runDirectHandoff,
} from "../../src/handoff-flow";
// The background-job promotion runtime (plan 09), so cross-service e2e can drive a real promotable shell
// command through the supervisor (promote -> tracked pN -> kill) the way the bash tool / shell lane do.
export { ProcessRegistry } from "../../src/process-registry";
// The typed provider error, so cross-service e2e can drive a retryable transport drop through a real
// store (the DeepSeek-style thinking-only reconnect path) without reaching into host internals.
export { ProviderUnavailable } from "../../src/providers/errors";
export { runPromotable } from "../../src/tools/promote-runner";
export * from "./fake-provider";

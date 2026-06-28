// Host test-support, re-exported for the e2e workspace via the @trevor/agent-host/testing
// export. Keeps the fake provider and turn driver in one place for both host integration
// tests (which import this folder relatively) and cross-service e2e (which imports the package).

// The ask_user pending-question runtime singleton, exposed so cross-service e2e can wire its emitter to
// the store and drive submitAnswer (the role main.ts's inbound lane plays in the real host).
export { providerQuestionRuntime } from "../../src/agent/provider-questions";
export * from "./fake-provider";

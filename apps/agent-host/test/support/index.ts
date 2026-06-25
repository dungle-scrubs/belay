// Host test-support, re-exported for the e2e workspace via the @trevor/agent-host/testing
// export. Keeps the fake provider and turn driver in one place for both host integration
// tests (which import this folder relatively) and cross-service e2e (which imports the package).
export * from "./fake-provider";

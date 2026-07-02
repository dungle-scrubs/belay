import { describe, expect, test } from "vitest";
import {
  createMcpServerMediator,
  createSamplingBudget,
  DEFAULT_MCP_SAMPLING_BUDGET,
  type McpElicitationRequest,
  type McpSamplingRequest,
} from "./mediation";

const SAMPLING_PARAMS = {
  messages: [{ role: "user", content: { type: "text", text: "please sample" } }],
  systemPrompt: "you are a fixture",
  maxTokens: 16,
};

function mediator(
  overrides: Partial<Parameters<typeof createMcpServerMediator>[0]> = {},
): ReturnType<typeof createMcpServerMediator> {
  return createMcpServerMediator({
    server: "alpha",
    sampling: { enabled: false, consumeBudget: () => true },
    ...overrides,
  });
}

describe("mediator - unknown server-originated methods", () => {
  test("answers an unknown method with a method-not-supported error", async () => {
    const outcome = await mediator()("roots/list", {});
    expect(outcome).toEqual({
      error: { code: -32601, message: expect.stringContaining("roots/list") },
    });
  });
});

describe("mediator - elicitation", () => {
  test("no handler (UI unavailable) declines to the server", async () => {
    const outcome = await mediator()("elicitation/create", { message: "Favorite color?" });
    expect(outcome).toEqual({ result: { action: "decline" } });
  });

  test("an accepting handler returns accept with its content", async () => {
    const seen: McpElicitationRequest[] = [];
    const handle = mediator({
      elicitation: {
        handler: (request) => {
          seen.push(request);
          return Promise.resolve({ action: "accept", content: { color: "blue" } });
        },
      },
    });
    const outcome = await handle("elicitation/create", {
      message: "Favorite color?",
      requestedSchema: { type: "object" },
    });
    expect(outcome).toEqual({ result: { action: "accept", content: { color: "blue" } } });
    expect(seen).toEqual([
      {
        server: "alpha",
        message: "Favorite color?",
        requestedSchema: { type: "object" },
      },
    ]);
  });

  test("a declining handler returns decline without content", async () => {
    const handle = mediator({
      elicitation: { handler: () => Promise.resolve({ action: "decline" }) },
    });
    await expect(handle("elicitation/create", { message: "?" })).resolves.toEqual({
      result: { action: "decline" },
    });
  });

  test("a cancelling handler returns cancel", async () => {
    const handle = mediator({
      elicitation: { handler: () => Promise.resolve({ action: "cancel" }) },
    });
    await expect(handle("elicitation/create", { message: "?" })).resolves.toEqual({
      result: { action: "cancel" },
    });
  });

  test("a handler that never answers is cancelled at the timeout", async () => {
    const startedAt = Date.now();
    const handle = mediator({
      elicitation: {
        handler: () =>
          new Promise(() => {
            /* never settles */
          }),
        timeoutMs: 30,
      },
    });
    const outcome = await handle("elicitation/create", { message: "?" });
    expect(outcome).toEqual({ result: { action: "cancel" } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  test("a crashing handler is a structured internal error, not a throw", async () => {
    const handle = mediator({
      elicitation: { handler: () => Promise.reject(new Error("ui exploded")) },
    });
    const outcome = await handle("elicitation/create", { message: "?" });
    expect(outcome).toEqual({ error: { code: -32603, message: expect.any(String) } });
  });
});

describe("mediator - sampling", () => {
  test("denied while disabled, even with a handler wired (off by default)", async () => {
    let calls = 0;
    const handle = mediator({
      sampling: {
        enabled: false,
        consumeBudget: () => true,
        handler: () => {
          calls += 1;
          return Promise.resolve({ text: "never" });
        },
      },
    });
    const outcome = await handle("sampling/createMessage", SAMPLING_PARAMS);
    expect(outcome).toEqual({
      error: { code: -32601, message: expect.stringContaining("disabled") },
    });
    expect(calls).toBe(0);
  });

  test("enabled: passes a sanitized request to the handler and returns only its output", async () => {
    const seen: McpSamplingRequest[] = [];
    const handle = mediator({
      sampling: {
        enabled: true,
        consumeBudget: () => true,
        handler: (request) => {
          seen.push(request);
          return Promise.resolve({
            text: "sampled!",
            model: "fake-model",
            // Junk beyond the seam's shape must be stripped (no raw provider payloads).
            usage: {
              inputTokens: 3,
              outputTokens: 5,
              rawProviderResponse: { secret: "leak" },
            } as never,
          });
        },
      },
    });
    const outcome = await handle("sampling/createMessage", SAMPLING_PARAMS);
    expect(outcome).toEqual({
      result: {
        role: "assistant",
        content: { type: "text", text: "sampled!" },
        model: "fake-model",
        stopReason: "endTurn",
        usage: { inputTokens: 3, outputTokens: 5 },
      },
    });
    expect(seen).toEqual([
      {
        server: "alpha",
        messages: [{ role: "user", text: "please sample" }],
        systemPrompt: "you are a fixture",
        maxTokens: 16,
      },
    ]);
  });

  test("denies once the budget is consumed", async () => {
    const handle = mediator({
      sampling: {
        enabled: true,
        consumeBudget: createSamplingBudget(1).consume,
        handler: () => Promise.resolve({ text: "once" }),
      },
    });
    const first = await handle("sampling/createMessage", SAMPLING_PARAMS);
    expect(first).toHaveProperty("result");
    const second = await handle("sampling/createMessage", SAMPLING_PARAMS);
    expect(second).toEqual({
      error: { code: -32000, message: expect.stringContaining("budget") },
    });
  });

  test("a crashing handler is a structured error without provider details", async () => {
    const handle = mediator({
      sampling: {
        enabled: true,
        consumeBudget: () => true,
        handler: () => Promise.reject(new Error("provider stack trace with secrets")),
      },
    });
    const outcome = await handle("sampling/createMessage", SAMPLING_PARAMS);
    expect(outcome).toEqual({ error: { code: -32603, message: expect.any(String) } });
    expect(JSON.stringify(outcome)).not.toContain("secrets");
  });
});

describe("sampling budget", () => {
  test("consumes down to zero then denies", () => {
    const budget = createSamplingBudget(2);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.consume()).toBe(false);
  });

  test("the default budget is small but non-zero", () => {
    expect(DEFAULT_MCP_SAMPLING_BUDGET).toBeGreaterThan(0);
    expect(DEFAULT_MCP_SAMPLING_BUDGET).toBeLessThanOrEqual(32);
  });
});

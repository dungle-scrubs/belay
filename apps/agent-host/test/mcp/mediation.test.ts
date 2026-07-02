import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/mcp/config";
import type { McpElicitationRequest, McpSamplingRequest } from "../../src/mcp/mediation";
import { createMcpRuntime, type McpRuntime, type McpRuntimeOptions } from "../../src/mcp/runtime";
import { startFixtureHttpServer } from "./fixture-http-server";

/**
 * Elicitation + sampling mediation integration (plan 23 M6): the REAL fixture servers send
 * elicitation/create and sampling/createMessage requests MID tools/call, and the host-owned
 * mediator answers them - accept/decline/cancel/timeout/unavailable for elicitation; the
 * off-by-default denial, injected-handler path, budget gate, and sanitized usage for sampling.
 * The fixture answers the original tool call with the JSON-RPC response it received, so every
 * assertion reads what the SERVER saw.
 */

const FIXTURE = join(import.meta.dirname, "fixture-server.ts");

function stdioConfig(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", FIXTURE],
    env: {},
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 10_000,
    ...overrides,
  } as McpServerConfig;
}

async function withRuntime(
  servers: readonly McpServerConfig[],
  options: McpRuntimeOptions,
  run: (runtime: McpRuntime) => Promise<void>,
): Promise<void> {
  const runtime = createMcpRuntime(servers, options);
  try {
    await run(runtime);
  } finally {
    await runtime.close();
  }
}

/** Runs the probe tool and parses the JSON-RPC response the fixture server observed. */
async function observedByServer(
  runtime: McpRuntime,
  qualifiedName: string,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const text = await Effect.runPromise(runtime.callTool(qualifiedName));
  return JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
}

describe("elicitation mediation over stdio", () => {
  it("accept: the handler's content reaches the server", async () => {
    const seen: McpElicitationRequest[] = [];
    await withRuntime(
      [stdioConfig("alpha")],
      {
        elicitationHandler: (request) => {
          seen.push(request);
          return Promise.resolve({ action: "accept", content: { color: "blue" } });
        },
      },
      async (runtime) => {
        const observed = await observedByServer(runtime, "alpha:elicit_probe");
        expect(observed).toEqual({
          result: { action: "accept", content: { color: "blue" } },
        });
        expect(seen).toEqual([
          {
            server: "alpha",
            message: "What is your favorite color?",
            requestedSchema: {
              type: "object",
              properties: { color: { type: "string" } },
              required: ["color"],
            },
          },
        ]);
      },
    );
  });

  it("decline: the server sees a decline with no content", async () => {
    await withRuntime(
      [stdioConfig("alpha")],
      { elicitationHandler: () => Promise.resolve({ action: "decline" }) },
      async (runtime) => {
        await expect(observedByServer(runtime, "alpha:elicit_probe")).resolves.toEqual({
          result: { action: "decline" },
        });
      },
    );
  });

  it("cancel: the server sees a cancel", async () => {
    await withRuntime(
      [stdioConfig("alpha")],
      { elicitationHandler: () => Promise.resolve({ action: "cancel" }) },
      async (runtime) => {
        await expect(observedByServer(runtime, "alpha:elicit_probe")).resolves.toEqual({
          result: { action: "cancel" },
        });
      },
    );
  });

  it("timeout: an unanswered question cancels at the deadline", async () => {
    await withRuntime(
      [stdioConfig("alpha")],
      {
        elicitationHandler: () =>
          new Promise(() => {
            /* the user never answers */
          }),
        elicitationTimeoutMs: 200,
      },
      async (runtime) => {
        const startedAt = Date.now();
        const observed = await observedByServer(runtime, "alpha:elicit_probe");
        expect(observed).toEqual({ result: { action: "cancel" } });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
      },
    );
  });

  it("unavailable: with no UI handler wired the server sees a decline", async () => {
    await withRuntime([stdioConfig("alpha")], {}, async (runtime) => {
      await expect(observedByServer(runtime, "alpha:elicit_probe")).resolves.toEqual({
        result: { action: "decline" },
      });
    });
  });
});

describe("elicitation mediation over http/sse", () => {
  it("mediates a mid-stream elicitation request and posts the answer back", async () => {
    const fixture = await startFixtureHttpServer({ responseMode: "sse" });
    try {
      await withRuntime(
        [
          {
            name: "beta",
            enabled: true,
            transport: "http",
            endpoint: fixture.endpoint,
            exposure: { tools: true, resources: true, prompts: true },
            requestTimeoutMs: 10_000,
          } as McpServerConfig,
        ],
        {
          elicitationHandler: () =>
            Promise.resolve({ action: "accept", content: { color: "green" } }),
        },
        async (runtime) => {
          await expect(observedByServer(runtime, "beta:elicit_probe")).resolves.toEqual({
            result: { action: "accept", content: { color: "green" } },
          });
        },
      );
    } finally {
      await fixture.close();
    }
  });
});

describe("sampling mediation", () => {
  it("is denied by default with a structured method-level error, handler never called", async () => {
    let handlerCalls = 0;
    await withRuntime(
      [stdioConfig("alpha")], // no `sampling: true` in config
      {
        samplingHandler: () => {
          handlerCalls += 1;
          return Promise.resolve({ text: "never" });
        },
      },
      async (runtime) => {
        const observed = await observedByServer(runtime, "alpha:sampling_probe");
        expect(observed.result).toBeUndefined();
        expect(observed.error?.code).toBe(-32601);
        expect(observed.error?.message).toContain("disabled");
        expect(handlerCalls).toBe(0);
      },
    );
  });

  it("enabled: returns ONLY the handler's output plus sanitized usage", async () => {
    const seen: McpSamplingRequest[] = [];
    await withRuntime(
      [stdioConfig("alpha", { sampling: true })],
      {
        samplingHandler: (request) => {
          seen.push(request);
          return Promise.resolve({
            text: "sampled!",
            model: "fake-model",
            usage: {
              inputTokens: 3,
              outputTokens: 5,
              rawProviderResponse: { secret: "must not leak" },
            } as never,
          });
        },
      },
      async (runtime) => {
        const observed = await observedByServer(runtime, "alpha:sampling_probe");
        expect(observed).toEqual({
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
      },
    );
  });

  it("gates on the budget: the call over budget is denied", async () => {
    await withRuntime(
      [stdioConfig("alpha", { sampling: true })],
      {
        samplingHandler: () => Promise.resolve({ text: "within budget" }),
        samplingBudget: 1,
      },
      async (runtime) => {
        const first = await observedByServer(runtime, "alpha:sampling_probe");
        expect(first.result).toMatchObject({ content: { type: "text", text: "within budget" } });
        const second = await observedByServer(runtime, "alpha:sampling_probe");
        expect(second.result).toBeUndefined();
        expect(second.error?.message).toContain("budget");
      },
    );
  });
});

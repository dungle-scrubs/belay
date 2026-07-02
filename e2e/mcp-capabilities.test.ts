import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  McpArgs,
  McpElicitationRequest,
  McpSamplingRequest,
} from "@trevor/agent-host/testing";
import {
  STDIO_FIXTURE_COMMAND,
  startFixtureHttpServer,
  stdioFixtureArgs,
} from "@trevor/agent-host/testing/mcp-fixtures";
import type { RunningServer } from "@trevor/server-kit";
import type { SessionEvent } from "@trevor/session";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, test } from "vitest";

/**
 * S-E2E MCP capability suite (plan 23 M9, D-006 / Gate 3): every supported MCP capability, end
 * to end and hermetic. REAL fixture servers (a spawned stdio child, real node:http servers in
 * plain-JSON and SSE response modes on ephemeral ports) are registered in a REAL
 * `<TREVOR_HOME>/mcp-servers.json` under a temp home, so the exact config path production walks
 * (node-paths -> boot/paths -> loadMcpServersConfig -> host-runtime singleton) is exercised.
 *
 * Two layers, matching what each proves best:
 *   - FULL HOST PATH: the fake-provider turn pipeline publishes through a real session-store
 *     while the model-facing `mcp` tool (bound to the host runtime SINGLETON built from the
 *     temp-home config file) searches, calls a server literally named "tool-proxy" (D-001), and
 *     runs the D-004 env-allowlist probe - proving config -> registry -> transport -> tool ->
 *     turn -> store wiring on one representative path.
 *   - CAPABILITY MATRIX: runtimes constructed over the SAME config file (re-read through
 *     loadMcpServersConfig) drive the `mcp` tool surface across all three transports for
 *     search, calls, resources, prompts, elicitation (accept/decline/cancel), sampling
 *     (denied/enabled), status incl. auth_needed, timeout, crash fail-closed + fresh-runtime
 *     recovery, and closed behavior.
 *
 * ORDERING MATTERS: `@trevor/session/node-paths` binds TREVOR_HOME at first evaluation, and
 * both the host testing surface AND the test-kit boot chain (store servers -> telemetry file
 * sink) reach it. So this file's static imports are strictly side-effect-free (node builtins,
 * types, the MCP fixture surface); the env override runs at module scope; and every
 * node-paths-reaching module loads DYNAMICALLY in beforeAll - the host surface last, after the
 * fixture endpoints are known and mcp-servers.json is on disk (its singleton reads the config
 * file at import).
 */

// --- hermetic home, BEFORE any node-paths-reaching module loads ---

const HOME = mkdtempSync(join(tmpdir(), "trevor-e2e-mcp-home-"));
const STATE = mkdtempSync(join(tmpdir(), "trevor-e2e-mcp-state-"));

/** The D-004 e2e proof: a provider secret sitting in the HOST env that must never reach a child. */
const FAKE_OPENAI_KEY = "sk-e2e-mcp-secret-that-must-never-leak";
const BEARER_TOKEN = "fixture-bearer-token";

const SAVED_ENV = {
  TREVOR_HOME: process.env.TREVOR_HOME,
  TREVOR_STATE_HOME: process.env.TREVOR_STATE_HOME,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

process.env.TREVOR_HOME = HOME;
process.env.TREVOR_STATE_HOME = STATE;
process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;

type HostTesting = typeof import("@trevor/agent-host/testing");
type SessionModule = typeof import("@trevor/session");
type TestKit = typeof import("@trevor/test-kit");
type McpTool = ReturnType<HostTesting["buildMcpTool"]>;
type FixtureHttpServer = Awaited<ReturnType<typeof startFixtureHttpServer>>;

let host: HostTesting;
let session: SessionModule;
let kit: TestKit;
let store: RunningServer;
let httpJson: FixtureHttpServer;
let httpSse: FixtureHttpServer;
let httpAuth: FixtureHttpServer;
let toolProxy: FixtureHttpServer;

/** The one matrix runtime + tool shared by the read-mostly capability tests. */
let runtimeAll: ReturnType<HostTesting["createMcpRuntime"]>;
let toolAll: McpTool;

const stdioServer = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  transport: "stdio",
  command: STDIO_FIXTURE_COMMAND,
  args: stdioFixtureArgs(),
  ...extra,
});

beforeAll(async () => {
  session = await import("@trevor/session");
  kit = await import("@trevor/test-kit");
  const { bootStore } = await import("@trevor/test-kit/boot");

  [httpJson, httpSse, httpAuth, toolProxy] = await Promise.all([
    startFixtureHttpServer(),
    startFixtureHttpServer({ responseMode: "sse" }),
    startFixtureHttpServer({ requireBearer: BEARER_TOKEN }),
    startFixtureHttpServer(),
  ]);

  // The REAL config file the host reads: every server below is an ordinary named entry,
  // tool-proxy included (D-001).
  writeFileSync(
    join(HOME, "mcp-servers.json"),
    JSON.stringify(
      {
        servers: {
          alpha: stdioServer({ env: { FIXTURE_EXTRA: "explicit-fixture-env" } }),
          beta: { transport: "http", endpoint: httpJson.endpoint },
          gamma: { transport: "http", endpoint: httpSse.endpoint },
          "tool-proxy": { transport: "http", endpoint: toolProxy.endpoint },
          vault: {
            transport: "http",
            endpoint: httpAuth.endpoint,
            auth: { bearerToken: BEARER_TOKEN },
          },
          locked: {
            transport: "http",
            endpoint: httpAuth.endpoint,
            auth: { bearerToken: "wrong-token" },
          },
          hangs: stdioServer({ requestTimeoutMs: 3_000 }),
          doomed: stdioServer(),
          sampler: stdioServer({ sampling: true }),
          benched: stdioServer({ enabled: false }),
        },
      },
      null,
      2,
    ),
  );

  // Only now may the host surface load: its singleton reads mcp-servers.json at import.
  host = await import("@trevor/agent-host/testing");
  store = await bootStore();

  runtimeAll = host.createMcpRuntime(host.loadMcpServersConfig().servers);
  toolAll = host.buildMcpTool(runtimeAll);
});

afterAll(async () => {
  await runtimeAll?.close();
  await host?.mcpRuntime.close();
  await store?.close();
  await Promise.all([httpJson, httpSse, httpAuth, toolProxy].map((f) => f?.close()));
  rmSync(HOME, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const execute = (tool: McpTool, args: McpArgs): Promise<string> =>
  Effect.runPromise(tool.execute(args));

const executeErr = (tool: McpTool, args: McpArgs): Promise<{ message: string }> =>
  Effect.runPromise(Effect.flip(tool.execute(args)));

/** Runs a scripted fake-provider turn through the real store and returns the subscriber. */
async function runMcpTurn(
  sessionId: string,
  calls: readonly McpArgs[],
): Promise<ReturnType<TestKit["subscribe"]>> {
  const transport = session.streamTransport(store.url);
  await transport.ensureSession(sessionId);
  const viewer = kit.subscribe(transport, sessionId, "viewer");
  await kit.waitFor(viewer.isReplayed);

  await host.publishTurnVia(
    host.transportEmit(transport, sessionId, "host"),
    host.fakeProvider({
      step: host.scriptedStep(
        calls.map((args) => ({ name: "mcp", args: { ...args } })),
        "mcp e2e done.",
      ),
    }),
    [{ role: "user", content: "Use the configured MCP servers." }],
    { runId: `r-${sessionId}` },
  );

  await kit.waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: `assistant.completed ${sessionId}`,
    timeoutMs: 55_000,
  });
  return viewer;
}

describe("full host path (config file -> singleton runtime -> tool registry -> turn -> store)", () => {
  test("a turn searches MCP and calls the server named tool-proxy like any other server", async () => {
    const viewer = await runMcpTurn("mcp-full-path", [
      { action: "search", query: "echo" },
      { action: "call", name: "tool-proxy:echo", args: { text: "hello through tool-proxy" } },
    ]);

    const results = viewer.events
      .filter((e: SessionEvent) => e.type === "tool.completed")
      .map((e) => String(e.payload.result ?? ""));
    assert.equal(results.length, 2);

    // Search discovered capabilities across the configured servers, tool-proxy among them.
    const searched = results[0] ?? "";
    assert.ok(searched.includes("alpha:echo"), searched);
    assert.ok(searched.includes("tool-proxy:echo"), searched);

    // The call to the server literally named "tool-proxy" rode the same qualified-name path.
    assert.equal(results[1], "hello through tool-proxy");

    const completed = viewer.events.find((e) => e.type === "assistant.completed");
    assert.equal(completed?.payload.error, undefined);
    viewer.connection.close();
  });

  test("a stdio child spawned through the full path never sees host provider secrets (D-004)", async () => {
    const viewer = await runMcpTurn("mcp-env-allowlist", [
      { action: "call", name: "alpha:env_probe" },
    ]);

    const probe = viewer.events.find((e) => e.type === "tool.completed");
    const childEnv = JSON.parse(String(probe?.payload.result ?? "{}")) as Record<string, string>;

    // Allowlisted vars and the explicit per-server env arrive; the host's secret never does.
    assert.ok(childEnv.PATH, "child should inherit PATH");
    assert.equal(childEnv.FIXTURE_EXTRA, "explicit-fixture-env");
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.ok(!JSON.stringify(childEnv).includes(FAKE_OPENAI_KEY));
    assert.equal(
      Object.keys(childEnv).find((key) => key.startsWith("TREVOR_")),
      undefined,
    );
    viewer.connection.close();
  });
});

describe("capability matrix - config + discovery/search", () => {
  test("the real mcp-servers.json normalizes cleanly into every configured server", () => {
    const config = host.loadMcpServersConfig();
    assert.deepEqual(config.issues, []);
    assert.equal(config.servers.length, 10);

    const entries = host.mcpRuntime.statusSnapshot();
    assert.equal(entries.length, 10);
    const proxy = entries.find((entry) => entry.server === "tool-proxy");
    assert.equal(proxy?.transport, "http");
  });

  test("one search spans stdio, Streamable HTTP, and SSE servers with qualified identity", async () => {
    const result = await execute(toolAll, { action: "search", query: "echo" });
    assert.ok(result.includes("alpha:echo"), result); // stdio
    assert.ok(result.includes("beta:echo"), result); // http, plain-JSON replies
    assert.ok(result.includes("gamma:echo"), result); // http, SSE replies
    assert.ok(result.includes("tool-proxy:echo"), result); // just another named server
    assert.ok(result.includes("[tool]"), result);
    assert.ok(!result.includes("benched:echo"), "a disabled server contributes nothing");
  });

  test("tool calls round-trip on every transport", async () => {
    assert.equal(
      await execute(toolAll, { action: "call", name: "alpha:echo", args: { text: "over stdio" } }),
      "over stdio",
    );
    assert.equal(
      await execute(toolAll, { action: "call", name: "beta:echo", args: { text: "over http" } }),
      "over http",
    );
    assert.equal(
      await execute(toolAll, { action: "call", name: "gamma:echo", args: { text: "over sse" } }),
      "over sse",
    );
  });
});

describe("capability matrix - resources and prompts", () => {
  test("resources list across servers and read back as attributed context records", async () => {
    const listed = await execute(toolAll, { action: "resources" });
    assert.ok(listed.includes("alpha:readme"), listed);
    assert.ok(listed.includes("tool-proxy:readme"), listed);
    assert.ok(listed.includes("fixture://logs/today"), listed);

    const overStdio = await execute(toolAll, {
      action: "resources",
      server: "alpha",
      uri: "fixture://readme",
    });
    assert.ok(overStdio.includes("fixture readme body"), overStdio);

    const overSse = await execute(toolAll, {
      action: "resources",
      server: "gamma",
      uri: "fixture://logs/today",
    });
    assert.ok(overSse.includes("log line 1"), overSse);
  });

  test("prompts list across servers and expand with server-side argument substitution", async () => {
    const listed = await execute(toolAll, { action: "prompt" });
    assert.ok(listed.includes("alpha:summarize"), listed);
    assert.ok(listed.includes("tool-proxy:greet"), listed);

    const expanded = await execute(toolAll, {
      action: "prompt",
      name: "tool-proxy:summarize",
      args: { text: "the quarterly numbers" },
    });
    assert.ok(expanded.includes("Summarize the following text"), expanded);
    assert.ok(expanded.includes("the quarterly numbers"), expanded);
  });
});

describe("capability matrix - auth and status", () => {
  test("a configured bearer token authenticates; a wrong one parks the server in auth_needed", async () => {
    assert.equal(
      await execute(toolAll, { action: "call", name: "vault:echo", args: { text: "bearer ok" } }),
      "bearer ok",
    );

    const error = await executeErr(toolAll, {
      action: "call",
      name: "locked:echo",
      args: { text: "hi" },
    });
    assert.ok(error.message.includes("authentication"), error.message);
    assert.ok(!error.message.includes("wrong-token"));
    assert.ok(!error.message.includes(BEARER_TOKEN));
  });

  test("status reports every server's health with redacted targets and no secrets", async () => {
    const status = await execute(toolAll, { action: "status" });
    assert.ok(status.includes("10 MCP server(s) configured (9 enabled)"), status);
    assert.match(status, /- alpha \[stdio .*\] ready/);
    assert.match(status, /- locked \[http .*\] auth_needed/);
    assert.match(status, /- benched \[stdio .*\].*\(disabled\)/);
    assert.match(status, /- tool-proxy \[http /);
    assert.ok(!status.includes(BEARER_TOKEN));
    assert.ok(!status.includes("wrong-token"));
    assert.ok(!status.includes(FAKE_OPENAI_KEY));
  });
});

describe("capability matrix - elicitation (accept / decline / cancel)", () => {
  test("an accepting handler answers a server's elicitation riding the SSE stream", async () => {
    const seen: McpElicitationRequest[] = [];
    const runtime = host.createMcpRuntime(host.loadMcpServersConfig().servers, {
      elicitationHandler: async (request) => {
        seen.push(request);
        return { action: "accept", content: { color: "teal" } };
      },
    });
    try {
      const tool = host.buildMcpTool(runtime);
      const observed = await execute(tool, { action: "call", name: "gamma:elicit_probe" });
      // The fixture answers the original call with EXACTLY the JSON-RPC response it received.
      assert.deepEqual(JSON.parse(observed), {
        result: { action: "accept", content: { color: "teal" } },
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.server, "gamma");
      assert.equal(seen[0]?.message, "What is your favorite color?");
    } finally {
      await runtime.close();
    }
  });

  test("with no question surface wired, an elicitation is declined (headless default)", async () => {
    const runtime = host.createMcpRuntime(host.loadMcpServersConfig().servers);
    try {
      const tool = host.buildMcpTool(runtime);
      const observed = await execute(tool, { action: "call", name: "alpha:elicit_probe" });
      assert.deepEqual(JSON.parse(observed), { result: { action: "decline" } });
    } finally {
      await runtime.close();
    }
  });

  test("a handler that never answers is cancelled at the deadline", async () => {
    const runtime = host.createMcpRuntime(host.loadMcpServersConfig().servers, {
      elicitationHandler: () => new Promise(() => {}),
      elicitationTimeoutMs: 250,
    });
    try {
      const tool = host.buildMcpTool(runtime);
      const observed = await execute(tool, { action: "call", name: "alpha:elicit_probe" });
      assert.deepEqual(JSON.parse(observed), { result: { action: "cancel" } });
    } finally {
      await runtime.close();
    }
  });
});

describe("capability matrix - sampling (denied by default / enabled by config)", () => {
  test("a server without the sampling opt-in is denied even when a handler is wired", async () => {
    const runtime = host.createMcpRuntime(host.loadMcpServersConfig().servers, {
      samplingHandler: async () => ({ text: "must never be reached" }),
    });
    try {
      const tool = host.buildMcpTool(runtime);
      const observed = JSON.parse(
        await execute(tool, { action: "call", name: "alpha:sampling_probe" }),
      ) as { error?: { code: number; message: string } };
      assert.equal(observed.error?.code, -32601);
      assert.ok(observed.error?.message.includes('sampling is disabled for MCP server "alpha"'));
    } finally {
      await runtime.close();
    }
  });

  test("an opted-in server gets a sanitized completion from the host's sampling seam", async () => {
    const seen: McpSamplingRequest[] = [];
    const runtime = host.createMcpRuntime(host.loadMcpServersConfig().servers, {
      samplingHandler: async (request) => {
        seen.push(request);
        return {
          text: "sampled-completion",
          model: "fake-sampler",
          usage: { inputTokens: 3, outputTokens: 7 },
        };
      },
    });
    try {
      const tool = host.buildMcpTool(runtime);
      const observed = JSON.parse(
        await execute(tool, { action: "call", name: "sampler:sampling_probe" }),
      ) as { result?: Record<string, unknown> };
      assert.deepEqual(observed.result, {
        role: "assistant",
        content: { type: "text", text: "sampled-completion" },
        model: "fake-sampler",
        stopReason: "endTurn",
        usage: { inputTokens: 3, outputTokens: 7 },
      });
      // The handler saw the sanitized projection, never the raw server payload.
      assert.deepEqual(seen, [
        {
          server: "sampler",
          messages: [{ role: "user", text: "please sample" }],
          systemPrompt: "you are a fixture",
          maxTokens: 16,
        },
      ]);
    } finally {
      await runtime.close();
    }
  });
});

describe("capability matrix - timeout, crash, reconnect/closed", () => {
  test("a hanging call trips the per-server requestTimeoutMs from the config file", async () => {
    const error = await executeErr(toolAll, { action: "call", name: "hangs:hang" });
    assert.ok(error.message.includes("timed out after 3000ms"), error.message);

    // The deadline is per-request: the same server still answers afterwards.
    assert.equal(
      await execute(toolAll, { action: "call", name: "hangs:echo", args: { text: "still up" } }),
      "still up",
    );
  });

  test("a crashed server fails closed until a fresh runtime reconnects it", async () => {
    const first = host.createMcpRuntime(host.loadMcpServersConfig().servers);
    try {
      const tool = host.buildMcpTool(first);
      // Warm the connection, then crash the child mid-call.
      assert.equal(
        await execute(tool, { action: "call", name: "doomed:echo", args: { text: "warm" } }),
        "warm",
      );
      const crash = await executeErr(tool, { action: "call", name: "doomed:crash" });
      assert.ok(crash.message.includes("crashed"), crash.message);

      // The fate is terminal: the next call is classified against the recorded crash.
      const after = await executeErr(tool, {
        action: "call",
        name: "doomed:echo",
        args: { text: "again" },
      });
      assert.ok(after.message.includes("crashed"), after.message);
      const doomed = first.statusSnapshot().find((entry) => entry.server === "doomed");
      assert.equal(doomed?.status, "failed");
      assert.ok(doomed?.lastError?.includes("crashed"));
    } finally {
      await first.close();
    }

    // Recovery is a fresh runtime over the same config: the server spawns anew and answers.
    const second = host.createMcpRuntime(host.loadMcpServersConfig().servers);
    try {
      const tool = host.buildMcpTool(second);
      assert.equal(
        await execute(tool, { action: "call", name: "doomed:echo", args: { text: "recovered" } }),
        "recovered",
      );
    } finally {
      await second.close();
    }
  });

  test("a closed runtime fails every later call closed", async () => {
    const runtime = host.createMcpRuntime(host.loadMcpServersConfig().servers);
    const tool = host.buildMcpTool(runtime);
    assert.equal(
      await execute(tool, { action: "call", name: "alpha:echo", args: { text: "before close" } }),
      "before close",
    );
    await runtime.close();

    const error = await executeErr(tool, {
      action: "call",
      name: "alpha:echo",
      args: { text: "after close" },
    });
    assert.ok(error.message.includes("closed"), error.message);
    const alpha = runtime.statusSnapshot().find((entry) => entry.server === "alpha");
    assert.equal(alpha?.status, "closed");
  });
});

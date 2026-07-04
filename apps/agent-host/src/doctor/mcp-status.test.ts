import assert from "node:assert/strict";
import type { McpServerConfig } from "@host/mcp/config";
import { McpServerCrashError, McpTimeoutError } from "@host/mcp/errors";
import { createMcpRuntime, type McpServerStatusEntry } from "@host/mcp/runtime";
import { test } from "vitest";
import { buildLiveDoctorSnapshot, type DoctorProbeResults } from "./build";
import { mcpDebugSummary, mcpPeripheralState } from "./mcp-status";

/**
 * Plan 23 M8: the /doctor MCP rollup - injected runtime status snapshots folded into the one
 * PeripheralState the doctor MCP area renders. Pins the full state matrix (unconfigured /
 * configured-lazy / ready / auth-needed / failed with tag-classified timeout / closed), the
 * multi-server rollup precedence (auth-needed over error over closed), the D-009 detail
 * contents (counts, transports, freshness, sanitized last error), and that no secret survives
 * into the state. Failure classification rides the machine-readable lastErrorTag, so entries
 * here carry REAL errors.ts tags, never sniffable message shapes.
 */

const NOW = Date.parse("2026-07-02T12:00:00.000Z");

function entry(overrides: Partial<McpServerStatusEntry> = {}): McpServerStatusEntry {
  return {
    server: "alpha",
    enabled: true,
    transport: "stdio",
    status: "ready",
    target: "/usr/local/bin/fixture",
    exposure: { tools: true, resources: true, prompts: true },
    capabilities: { discovered: false, counts: { tools: 0, resources: 0, prompts: 0 } },
    ...overrides,
  };
}

const discovered = (
  counts: { tools: number; resources: number; prompts: number },
  atMsAgo = 120_000,
): McpServerStatusEntry["capabilities"] => ({
  discovered: true,
  discoveredAt: NOW - atMsAgo,
  counts,
});

// --- the state matrix ---------------------------------------------------------------------

test("no servers configured folds to unconfigured", () => {
  assert.deepEqual(mcpPeripheralState([], NOW), { kind: "unconfigured" });
});

test("an all-disabled registry folds to unconfigured (nothing can run)", () => {
  assert.deepEqual(mcpPeripheralState([entry({ enabled: false })], NOW), {
    kind: "unconfigured",
  });
});

test("configured-but-never-used servers are ready (lazy), saying nothing is connected yet", () => {
  const state = mcpPeripheralState(
    [
      entry({ status: "configured" }),
      entry({
        server: "beta",
        status: "configured",
        transport: "http",
        target: "https://mcp.example.com/mcp",
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "ready");
  assert.ok(state.kind === "ready" && state.detail.includes("2 servers"));
  assert.ok(state.kind === "ready" && state.detail.includes("0 ready"));
});

test("all enabled servers ready folds to ready with counts, transports, and freshness", () => {
  const state = mcpPeripheralState(
    [
      entry({ capabilities: discovered({ tools: 8, resources: 2, prompts: 1 }) }),
      entry({
        server: "beta",
        transport: "http",
        target: "https://mcp.example.com/mcp",
        protocolVersion: "2025-06-18",
        capabilities: discovered({ tools: 3, resources: 1, prompts: 1 }),
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "ready");
  const detail = state.kind === "ready" ? state.detail : "";
  assert.ok(detail.includes("2 servers"), "configured count");
  assert.ok(detail.includes("2 ready"), "ready count");
  assert.ok(detail.includes("stdio+http"), "transport kinds");
  assert.ok(detail.includes("11 tools"), "summed tool count");
  assert.ok(detail.includes("3 resources"), "summed resource count");
  assert.ok(detail.includes("2 prompts"), "summed prompt count");
  assert.ok(detail.includes("checked 2m ago"), "cache freshness / last checked");
});

test("a disabled server contributes nothing to the healthy rollup", () => {
  const state = mcpPeripheralState(
    [
      entry({ capabilities: discovered({ tools: 4, resources: 0, prompts: 0 }) }),
      entry({ server: "off", enabled: false, status: "failed", lastError: "must not surface" }),
    ],
    NOW,
  );
  assert.equal(state.kind, "ready");
  assert.ok(state.kind === "ready" && state.detail.includes("1 server"));
  assert.ok(state.kind === "ready" && !state.detail.includes("must not surface"));
});

test("any enabled server needing auth folds to auth-needed, naming it with its redacted target", () => {
  const state = mcpPeripheralState(
    [
      entry(),
      entry({
        server: "linear",
        transport: "http",
        target: "https://mcp.linear.app/mcp",
        status: "auth_needed",
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "auth-needed");
  assert.ok(state.kind === "auth-needed" && state.detail?.includes('"linear"'));
  assert.ok(state.kind === "auth-needed" && state.detail?.includes("https://mcp.linear.app/mcp"));
});

test("any enabled failed server folds to error carrying the sanitized last error", () => {
  const crash = new McpServerCrashError({
    server: "github",
    detail: "child exited (code 127, signal null)",
  });
  const state = mcpPeripheralState(
    [
      entry(),
      entry({
        server: "github",
        status: "failed",
        lastError: crash.message,
        lastErrorTag: crash._tag,
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "error");
  assert.ok(state.kind === "error" && state.detail?.includes("code 127"));
});

test("closed servers fold to unavailable (configured but not serving)", () => {
  const state = mcpPeripheralState(
    [entry({ status: "closed", lastError: 'MCP connection to "alpha" is closed' })],
    NOW,
  );
  assert.equal(state.kind, "unavailable");
  assert.ok(state.kind === "unavailable" && state.detail?.includes("closed"));
});

test("a handshake that timed out folds to timeout, classified by TAG not message shape", () => {
  // A handshake timeout is terminal: the transport parks in "failed" carrying the timeout tag.
  const timeout = new McpTimeoutError({ server: "alpha", method: "initialize", timeoutMs: 30_000 });
  const state = mcpPeripheralState(
    [entry({ status: "failed", lastError: timeout.message, lastErrorTag: timeout._tag })],
    NOW,
  );
  assert.equal(state.kind, "timeout");
  assert.ok(state.kind === "timeout" && state.detail?.includes("timed out after 30000ms"));
});

test("a per-request timeout on a READY server stays ready (never the timeout state)", () => {
  const timeout = new McpTimeoutError({ server: "alpha", method: "tools/call", timeoutMs: 5_000 });
  const state = mcpPeripheralState(
    [entry({ status: "ready", lastError: timeout.message, lastErrorTag: timeout._tag })],
    NOW,
  );
  assert.equal(state.kind, "ready");
  assert.ok(state.kind === "ready" && state.detail.includes("last error"));
});

test("rollup precedence: auth-needed beats error beats closed (the plan's ladder)", () => {
  const failed = entry({ server: "b", status: "failed", lastError: "boom" });
  const auth = entry({
    server: "c",
    status: "auth_needed",
    transport: "http",
    target: "https://x/mcp",
  });
  const closed = entry({ server: "d", status: "closed" });
  assert.equal(mcpPeripheralState([failed, auth, closed], NOW).kind, "auth-needed");
  assert.equal(mcpPeripheralState([failed, closed], NOW).kind, "error");
  assert.equal(mcpPeripheralState([closed, entry()], NOW).kind, "unavailable");
});

test("a ready fleet still surfaces a per-request last error in the detail", () => {
  const state = mcpPeripheralState(
    [
      entry({
        capabilities: discovered({ tools: 2, resources: 0, prompts: 0 }),
        lastError:
          'MCP server "alpha" returned a JSON-RPC error for "tools/call": boom tool always fails',
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "ready");
  assert.ok(state.kind === "ready" && state.detail.includes("last error"));
  assert.ok(state.kind === "ready" && state.detail.includes("boom tool always fails"));
});

// --- redaction (D-009): fold real runtime snapshots built from secret-bearing config --------

test("no secret from config survives into the folded state", () => {
  const servers: McpServerConfig[] = [
    {
      name: "alpha",
      enabled: true,
      transport: "stdio",
      command: "/bin/fixture",
      args: ["--api-key=stdio-arg-s3cret"],
      env: { API_KEY: "stdio-env-s3cret" },
      exposure: { tools: true, resources: true, prompts: true },
      requestTimeoutMs: 5_000,
    },
    {
      name: "beta",
      enabled: true,
      transport: "http",
      endpoint: "https://mcp.example.com/mcp?token=query-s3cret",
      auth: { bearerToken: "bearer-s3cret" },
      exposure: { tools: true, resources: true, prompts: true },
      requestTimeoutMs: 5_000,
    },
  ];
  const runtime = createMcpRuntime(servers);
  const folded = JSON.stringify(mcpPeripheralState(runtime.statusSnapshot(), NOW));
  const debug = mcpDebugSummary(runtime.statusSnapshot()) ?? "";
  for (const secret of ["stdio-arg-s3cret", "stdio-env-s3cret", "query-s3cret", "bearer-s3cret"]) {
    assert.ok(!folded.includes(secret), `folded state leaked ${secret}`);
    assert.ok(!debug.includes(secret), `debug summary leaked ${secret}`);
  }
});

// --- the debug surface --------------------------------------------------------------------

test("mcpDebugSummary is a compact status histogram, absent when nothing is configured", () => {
  assert.equal(mcpDebugSummary([]), undefined);
  const summary = mcpDebugSummary([
    entry(),
    entry({ server: "b", status: "auth_needed" }),
    entry({ server: "c", enabled: false }),
  ]);
  assert.ok(summary?.includes("3 servers"));
  assert.ok(summary?.includes("1 ready"));
  assert.ok(summary?.includes("1 auth_needed"));
  assert.ok(summary?.includes("1 disabled"));
});

// --- the live-snapshot wiring: DoctorRuntimeFacts.mcp flows into the MCP area ---------------

const PROBES: DoctorProbeResults = {
  providers: [],
  roots: [],
  tools: ["read"],
  observations: { distinct: 0, unknown: 0, total: 0, top: [] },
  providerFailures: { retryExhausted: 0, nonRetryableTerminal: 0 },
  providerIncidents: [],
};

const FACTS = {
  cwd: "~/ws",
  workspace: "~/ws",
  instanceId: "abc12345",
  role: "leader",
};

test("buildLiveDoctorSnapshot renders the injected MCP state in the MCP area", () => {
  const snapshot = buildLiveDoctorSnapshot({
    runtime: {
      ...FACTS,
      mcp: { kind: "auth-needed", detail: 'MCP server "linear" needs authentication' },
    },
    probes: PROBES,
  });
  const area = snapshot.areas.find((candidate) => candidate.id === "mcp");
  assert.equal(area?.status, "warn");
  assert.ok(area?.verdict.includes('"linear"'));
});

test("buildLiveDoctorSnapshot defaults the MCP area to unconfigured when no state is injected", () => {
  const snapshot = buildLiveDoctorSnapshot({ runtime: FACTS, probes: PROBES });
  const area = snapshot.areas.find((candidate) => candidate.id === "mcp");
  assert.equal(area?.status, "not_checked");
  assert.ok(area?.verdict.includes("not configured"));
});

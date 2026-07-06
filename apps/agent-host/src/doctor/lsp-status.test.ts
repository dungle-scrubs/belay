import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_LSP_DEGRADED_DETAIL_CHARS } from "@host/lsp/caps";
import type { LspServerStatus } from "@host/lsp/contract";
import { createLspManager } from "@host/lsp/manager";
import { test } from "vitest";
import { buildLiveDoctorSnapshot, type DoctorProbeResults } from "./build";
import {
  lspDebugSummary,
  lspDiagnosticFinding,
  lspPeripheralState,
  lspStoredDiagnostics,
} from "./lsp-status";

/**
 * Plan 24 M8: the /doctor LSP rollup - the manager's status snapshot folded into the one
 * PeripheralState the doctor LSP area renders (D-008). Pins the full state matrix
 * (missing-adapter unconfigured / configured-lazy ready / ready with counts + freshness /
 * stale / unavailable with install hint / parked error / parked init timeout), the stored
 * diagnostics summary and its diagnostic-warning finding, redaction (home paths abbreviated,
 * details bounded), and the debug histogram. Failure classification rides the manager's
 * machine `status` field (parked by errors.ts tag), never message sniffing.
 */

const NOW = Date.parse("2026-07-02T12:00:00.000Z");

function entry(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    workspaceRoot: "/w/app",
    server: "typescript-language-server",
    status: "ready",
    restarts: 0,
    ...overrides,
  };
}

// --- the state matrix ---------------------------------------------------------------------

test("no adapter matching any workspace folds to unconfigured (steady state, not an error)", () => {
  assert.deepEqual(lspPeripheralState([], NOW), { kind: "unconfigured" });
  assert.deepEqual(lspPeripheralState([entry({ status: "missing", server: undefined })], NOW), {
    kind: "unconfigured",
  });
});

test("a configured-but-never-used workspace is ready (lazy), saying the server starts on use", () => {
  const state = lspPeripheralState([entry({ status: "configured" })], NOW);
  assert.equal(state.kind, "ready");
  const detail = state.kind === "ready" ? state.detail : "";
  assert.ok(detail.includes("typescript-language-server"), detail);
  assert.match(detail, /starts on first use/);
});

test("a ready server folds to ready with server name, diagnostic counts, and freshness", () => {
  const state = lspPeripheralState(
    [
      entry({
        lastRequestMethod: "textDocument/hover",
        lastRequestAt: NOW - 120_000,
        diagnostics: { files: 2, errors: 2, warnings: 1 },
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "ready");
  const detail = state.kind === "ready" ? state.detail : "";
  assert.ok(detail.includes("typescript-language-server"), "server name");
  assert.ok(detail.includes("ready"), "state word");
  assert.ok(detail.includes("2 errors, 1 warning in 2 files"), `diagnostic counts: ${detail}`);
  assert.ok(detail.includes("checked 2m ago"), `freshness / last checked: ${detail}`);
});

test("a stale server stays ready but reports its quiet age", () => {
  const state = lspPeripheralState([entry({ status: "stale", staleAgeMs: 90_000 })], NOW);
  assert.equal(state.kind, "ready");
  const detail = state.kind === "ready" ? state.detail : "";
  assert.match(detail, /stale/);
  assert.match(detail, /quiet for 90s/);
});

test("an initializing server is ready-in-progress, never an error", () => {
  const state = lspPeripheralState([entry({ status: "initializing" })], NOW);
  assert.equal(state.kind, "ready");
  assert.ok(state.kind === "ready" && state.detail.includes("initializing"));
});

test("a missing binary folds to unavailable with the lookup locations and an install hint", () => {
  const state = lspPeripheralState([entry({ status: "unavailable" })], NOW);
  assert.equal(state.kind, "unavailable");
  const detail = state.kind === "unavailable" ? (state.detail ?? "") : "";
  assert.ok(detail.includes("typescript-language-server"), detail);
  assert.match(detail, /not installed/);
  assert.match(detail, /node_modules\/\.bin and PATH/);
  assert.match(detail, /pnpm add -g typescript-language-server/, "the install hint");
});

test("a parked crash folds to error carrying the sanitized last error", () => {
  const state = lspPeripheralState(
    [
      entry({
        status: "error",
        restarts: 2,
        lastError:
          'LSP server "typescript-language-server" crashed: child exited (code 1, signal null); stderr tail: TypeError: boom',
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "error");
  assert.ok(state.kind === "error" && state.detail?.includes("code 1"));
});

test("a parked initialize timeout folds to timeout, classified by the machine status field", () => {
  const state = lspPeripheralState(
    [
      entry({
        status: "timeout",
        lastError:
          'LSP request "initialize" to "typescript-language-server" timed out after 10000ms',
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "timeout");
  assert.ok(state.kind === "timeout" && state.detail?.includes("timed out after 10000ms"));
});

test("a per-request timeout on a READY server stays ready (never the timeout state)", () => {
  const state = lspPeripheralState(
    [
      entry({
        lastError:
          'LSP request "textDocument/hover" to "typescript-language-server" timed out after 15000ms',
      }),
    ],
    NOW,
  );
  assert.equal(state.kind, "ready");
  assert.ok(state.kind === "ready" && state.detail.includes("last error"));
});

test("rollup precedence: timeout beats error beats unavailable beats ready", () => {
  const ready = entry();
  const unavailable = entry({ workspaceRoot: "/w/b", status: "unavailable" });
  const errored = entry({ workspaceRoot: "/w/c", status: "error", lastError: "boom" });
  const timedOut = entry({ workspaceRoot: "/w/d", status: "timeout", lastError: "slow" });
  assert.equal(lspPeripheralState([ready, unavailable, errored, timedOut], NOW).kind, "timeout");
  assert.equal(lspPeripheralState([ready, unavailable, errored], NOW).kind, "error");
  assert.equal(lspPeripheralState([ready, unavailable], NOW).kind, "unavailable");
  assert.equal(lspPeripheralState([ready], NOW).kind, "ready");
});

// --- the stored-diagnostics summary and the diagnostic-warning finding (D-008) --------------

test("lspStoredDiagnostics sums stored counts across workspaces; absent when nothing is stored", () => {
  assert.equal(lspStoredDiagnostics([entry()]), undefined);
  const summary = lspStoredDiagnostics([
    entry({ diagnostics: { files: 2, errors: 2, warnings: 1 } }),
    entry({ workspaceRoot: "/w/b", diagnostics: { files: 1, errors: 0, warnings: 3 } }),
  ]);
  assert.deepEqual(summary, { files: 3, errors: 2, warnings: 4 });
});

test("stored diagnostics WITH errors surface the bounded diagnostic-warning finding", () => {
  const finding = lspDiagnosticFinding({ files: 2, errors: 2, warnings: 1 });
  assert.equal(finding?.id, "lsp.diagnostics");
  assert.equal(finding?.status, "warn");
  assert.ok(finding?.message.includes("2 errors, 1 warning in 2 files"), finding?.message);
  assert.match(finding?.nextAction?.label ?? "", /lsp_diagnostics/);
});

test("warnings-only stored diagnostics raise no finding (counts stay in the ready detail)", () => {
  assert.equal(lspDiagnosticFinding({ files: 1, errors: 0, warnings: 5 }), undefined);
  assert.equal(lspDiagnosticFinding(undefined), undefined);
});

// --- redaction (M8 task 3): bounded, home-abbreviated details on every surface --------------

test("absolute home paths in errors and roots are abbreviated on every folded surface", () => {
  const home = homedir();
  const entries = [
    entry({
      workspaceRoot: join(home, "dev", "secret-ws"),
      status: "error",
      lastError: `LSP server crashed: ENOENT ${join(home, "dev", "secret-ws", "node_modules", ".bin", "tls")}`,
    }),
  ];
  const state = lspPeripheralState(entries, NOW);
  const folded = JSON.stringify(state);
  assert.ok(!folded.includes(home), `home path leaked: ${folded}`);
  assert.ok(folded.includes("~/dev/secret-ws"), folded);
});

test("the unavailable detail abbreviates the workspace root it names", () => {
  const state = lspPeripheralState(
    [entry({ workspaceRoot: join(homedir(), "ws"), status: "unavailable" })],
    NOW,
  );
  const detail = state.kind === "unavailable" ? (state.detail ?? "") : "";
  assert.ok(!detail.includes(homedir()), detail);
  assert.ok(detail.includes("~/ws"), detail);
});

test("folded details stay bounded even over an unbounded server log tail", () => {
  const state = lspPeripheralState(
    [entry({ status: "error", lastError: `crashed: ${"x".repeat(10_000)}` })],
    NOW,
  );
  const detail = state.kind === "error" ? (state.detail ?? "") : "";
  assert.ok(
    detail.length <= MAX_LSP_DEGRADED_DETAIL_CHARS + 32,
    `detail stays bounded (${detail.length} chars)`,
  );
});

test("a REAL manager snapshot with no matching adapter folds to unconfigured", async () => {
  const manager = createLspManager({
    adapters: [],
    defaultWorkspaceRoot: join(homedir(), ".trevor-lsp-doctor-test"),
  });
  try {
    assert.deepEqual(lspPeripheralState(manager.statusSnapshot(), NOW), {
      kind: "unconfigured",
    });
    assert.equal(lspDebugSummary(manager.statusSnapshot()), undefined);
  } finally {
    await manager.close();
  }
});

// --- the debug surface ----------------------------------------------------------------------

test("lspDebugSummary is a compact status histogram, absent when no adapter matches", () => {
  assert.equal(lspDebugSummary([]), undefined);
  assert.equal(lspDebugSummary([entry({ status: "missing", server: undefined })]), undefined);
  const summary = lspDebugSummary([
    entry(),
    entry({ workspaceRoot: "/w/b", status: "configured" }),
  ]);
  assert.ok(summary?.includes("2 workspaces"));
  assert.ok(summary?.includes("1 ready"));
  assert.ok(summary?.includes("1 configured"));
});

test("lspDebugSummary appends stored diagnostic counts when errors are present", () => {
  const summary = lspDebugSummary([entry({ diagnostics: { files: 1, errors: 3, warnings: 0 } })]);
  assert.ok(summary?.includes("3 errors"));
});

// --- the live-snapshot wiring: DoctorRuntimeFacts.lsp flows into the LSP area ---------------

const PROBES: DoctorProbeResults = {
  storeDiag: { kind: "unknown", hostSha: null, reason: "not probed" },
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

test("buildLiveDoctorSnapshot renders the injected LSP state in the LSP area", () => {
  const snapshot = buildLiveDoctorSnapshot({
    runtime: {
      ...FACTS,
      lsp: { kind: "error", detail: "typescript-language-server crashed" },
    },
    probes: PROBES,
  });
  const area = snapshot.areas.find((candidate) => candidate.id === "lsp");
  assert.equal(area?.status, "error");
  assert.ok(area?.verdict.includes("typescript-language-server"));
});

test("buildLiveDoctorSnapshot defaults the LSP area to unconfigured when no state is injected", () => {
  const snapshot = buildLiveDoctorSnapshot({ runtime: FACTS, probes: PROBES });
  const area = snapshot.areas.find((candidate) => candidate.id === "lsp");
  assert.equal(area?.status, "not_checked");
  assert.ok(area?.verdict.includes("not configured"));
});

test("injected stored-diagnostics errors lift the LSP area to warn via the extra finding", () => {
  const snapshot = buildLiveDoctorSnapshot({
    runtime: {
      ...FACTS,
      lsp: { kind: "ready", detail: "typescript-language-server ready" },
      lspDiagnostics: { files: 2, errors: 2, warnings: 1 },
    },
    probes: PROBES,
  });
  const area = snapshot.areas.find((candidate) => candidate.id === "lsp");
  assert.equal(area?.status, "warn");
  const finding = area?.findings?.find((candidate) => candidate.id === "lsp.diagnostics");
  assert.ok(finding, "the diagnostic-warning finding is attached");
  assert.equal(finding?.status, "warn");
  assert.ok(finding?.message.includes("2 errors, 1 warning in 2 files"), finding?.message);
});

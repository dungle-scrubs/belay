import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTypeScriptLanguageServerAdapter,
  type LanguageServerAdapter,
} from "@host/lsp/adapter";
import { createLspManager, type LspManager, type LspManagerOptions } from "@host/lsp/manager";
import { afterEach, describe, expect, it } from "vitest";
import { lspFixtureAdapter, lspFixtureSpawnSpec } from "./fixture-config";

/**
 * LSP manager integration (plan 24 M2 tasks 1-2 + 5-8): the spawned lifecycle against the REAL
 * fixture server - lazy spawn, initialize-to-ready, init timeout, per-request timeout, crash
 * with a bounded restart budget, stale-age reporting, diagnostics through an acquired client,
 * and graceful close. Every degraded path is a plain result variant, never a throw (D-006).
 */

const ROOT = "/tmp/lsp-manager-workspace";

const managers: LspManager[] = [];

function manager(options: Partial<LspManagerOptions> = {}): LspManager {
  const created = createLspManager({
    adapters: [lspFixtureAdapter()],
    defaultWorkspaceRoot: ROOT,
    requestTimeoutMs: 5_000,
    initTimeoutMs: 5_000,
    ...options,
  });
  managers.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.close()));
});

function hoverParams(uri: string, line = 1, character = 2): unknown {
  return { textDocument: { uri }, position: { line, character } };
}

describe("lsp manager - lifecycle", () => {
  it("spawns lazily on first use and reaches ready", async () => {
    const lsp = manager();
    expect(lsp.status().status).toBe("configured");

    const outcome = await lsp.acquire();
    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.server).toBe("belay-lsp-fixture");
    }
    expect(lsp.status()).toMatchObject({
      status: "ready",
      server: "belay-lsp-fixture",
      restarts: 0,
    });
  });

  it("answers requests through the managed server and tracks the last request", async () => {
    const lsp = manager();
    const outcome = await lsp.request("textDocument/hover", hoverParams("file:///m.ts", 4, 7));
    expect(outcome).toMatchObject({ kind: "ok", value: { contents: { value: "hover:4:7" } } });
    expect(lsp.status()).toMatchObject({ lastRequestMethod: "textDocument/hover" });
    expect(lsp.status().lastRequestAt).toBeTypeOf("number");
  });

  it("an init timeout parks the workspace as timeout instead of respawn-storming", async () => {
    const lsp = manager({
      adapters: [lspFixtureAdapter(["--init=hang"])],
      initTimeoutMs: 300,
    });
    const first = await lsp.acquire();
    expect(first).toMatchObject({ kind: "degraded", reason: "timeout" });
    expect(lsp.status().status).toBe("timeout");

    // Parked: the second acquire degrades immediately from the recorded failure.
    const second = await lsp.acquire();
    expect(second).toMatchObject({ kind: "degraded", reason: "timeout" });
  });

  it("a per-request timeout degrades the call but keeps the server ready", async () => {
    const lsp = manager({ requestTimeoutMs: 300 });
    const outcome = await lsp.request("textDocument/hover", hoverParams("file:///hang.ts"));
    expect(outcome).toMatchObject({ kind: "degraded", reason: "timeout" });
    expect(lsp.status().status).toBe("ready");

    const next = await lsp.request("textDocument/hover", hoverParams("file:///ok.ts", 8, 9));
    expect(next).toMatchObject({ kind: "ok", value: { contents: { value: "hover:8:9" } } });
  });

  it("restarts once after a crash, then parks as error when the budget is spent", async () => {
    const lsp = manager({ maxAutoRestarts: 1 });

    // First crash: the in-flight request degrades and one restart is consumed.
    const crashed = await lsp.request("textDocument/hover", hoverParams("file:///crash.ts"));
    expect(crashed).toMatchObject({ kind: "degraded", reason: "server_error" });
    await expect.poll(() => lsp.status().restarts).toBe(1);
    expect(lsp.status().lastError).toBeTypeOf("string");

    // The budgeted restart: the next use respawns and answers.
    const recovered = await lsp.request("textDocument/hover", hoverParams("file:///ok.ts", 3, 4));
    expect(recovered).toMatchObject({ kind: "ok", value: { contents: { value: "hover:3:4" } } });

    // Second crash exceeds the budget: parked as error, later acquires degrade immediately.
    await lsp.request("textDocument/hover", hoverParams("file:///crash.ts"));
    await expect.poll(() => lsp.status().status).toBe("error");
    const parked = await lsp.acquire();
    expect(parked).toMatchObject({ kind: "degraded", reason: "server_error" });
  });

  it("a crash after a long-healthy run resets the restart budget instead of parking", async () => {
    let time = 1_000;
    const lsp = manager({ now: () => time, maxAutoRestarts: 1 });

    // Crash 1 consumes the only budgeted restart.
    await lsp.request("textDocument/hover", hoverParams("file:///crash.ts"));
    await expect.poll(() => lsp.status().restarts).toBe(1);

    // The budgeted respawn serves healthily, then sits ready for over ten minutes.
    const recovered = await lsp.request("textDocument/hover", hoverParams("file:///ok.ts", 3, 4));
    expect(recovered).toMatchObject({ kind: "ok" });
    time += 11 * 60_000;

    // Crash 2 lands long after ready: the budget resets first, so the root is NOT parked...
    await lsp.request("textDocument/hover", hoverParams("file:///crash.ts"));
    await expect.poll(() => lsp.status().restarts).toBe(1);
    expect(lsp.status().status).not.toBe("error");

    // ...and the next use respawns and answers.
    const after = await lsp.request("textDocument/hover", hoverParams("file:///again.ts", 5, 6));
    expect(after).toMatchObject({ kind: "ok", value: { contents: { value: "hover:5:6" } } });
  });

  it("statusOf caches the idle binary resolution; acquire re-resolves and refreshes it", async () => {
    let resolves = 0;
    let installed = false;

    const countingAdapter: LanguageServerAdapter = {
      id: "counting",
      displayName: "counting-server",
      detects: () => true,
      resolveCommand: () => {
        resolves += 1;
        return installed ? lspFixtureSpawnSpec() : undefined;
      },
    };
    const lsp = manager({ adapters: [countingAdapter] });

    // Repeated idle status reads resolve the binary exactly once (no PATH walk per call).
    expect(lsp.status().status).toBe("unavailable");
    lsp.status();
    lsp.statusSnapshot();
    expect(resolves).toBe(1);

    // Installing the binary is invisible to the cached idle status, but the next ACQUIRE
    // re-resolves fresh (the e2e install-mid-suite recovery path) and refreshes the cache.
    installed = true;
    expect(lsp.status().status).toBe("unavailable");
    expect(resolves).toBe(1);
    const outcome = await lsp.acquire();
    expect(outcome.kind).toBe("ready");
    expect(lsp.status().status).toBe("ready");
  });

  it("reports a ready server as stale once quiet past the threshold", async () => {
    let time = 1_000;
    const lsp = manager({ now: () => time, staleAfterMs: 60_000 });
    await lsp.acquire();
    expect(lsp.status().status).toBe("ready");

    time += 61_000;
    const status = lsp.status();
    expect(status.status).toBe("stale");
    expect(status.staleAgeMs).toBe(61_000);
  });

  it("close shuts the server down and degrades later use", async () => {
    const lsp = manager();
    await lsp.acquire();
    await lsp.close();
    const outcome = await lsp.acquire();
    expect(outcome).toMatchObject({ kind: "degraded", reason: "unavailable" });
  });
});

describe("lsp manager - diagnostics through an acquired client", () => {
  it("collects publishDiagnostics via didOpen document sync", async () => {
    const lsp = manager();
    const outcome = await lsp.acquire();
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") {
      return;
    }
    outcome.client.openDocument("file:///w/managed.ts", "typescript", "fine\noops in managed");
    const diagnostics = await outcome.client.waitForDiagnostics("file:///w/managed.ts", 5_000);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics?.[0]).toMatchObject({ severity: "warning", message: "oops on line 2" });
  });

  it("summarizes stored diagnostics in the status snapshot (plan 24 M8, counts only)", async () => {
    const lsp = manager();
    const outcome = await lsp.acquire();
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") {
      return;
    }
    // Before any publish arrives, the snapshot carries no summary at all.
    expect(lsp.status().diagnostics).toBeUndefined();

    outcome.client.openDocument("file:///w/summary.ts", "typescript", "fine\noops in summary");
    await outcome.client.waitForDiagnostics("file:///w/summary.ts", 5_000);
    expect(lsp.status().diagnostics).toEqual({ files: 1, errors: 0, warnings: 1 });
    const snapshot = lsp.statusSnapshot();
    expect(snapshot[0]?.diagnostics).toEqual({ files: 1, errors: 0, warnings: 1 });
  });
});

describe("lsp manager - real TS adapter degradation", () => {
  it("degrades a real TS workspace with no installed server binary to unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "belay-lsp-manager-"));
    writeFileSync(join(root, "tsconfig.json"), "{}");
    try {
      const lsp = manager({
        adapters: [createTypeScriptLanguageServerAdapter({ hostEnv: { PATH: "/nonexistent" } })],
        defaultWorkspaceRoot: root,
      });
      const outcome = await lsp.acquire();
      expect(outcome).toMatchObject({ kind: "degraded", reason: "unavailable" });
      expect(lsp.status()).toMatchObject({
        status: "unavailable",
        server: "typescript-language-server",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

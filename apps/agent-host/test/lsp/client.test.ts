import { MAX_LSP_STORED_FILES } from "@host/lsp/caps";
import {
  type LspClient,
  type LspClientOptions,
  type LspExitInfo,
  spawnLspClient,
} from "@host/lsp/client";
import { describe, expect, it } from "vitest";
import { lspFixtureSpawnSpec } from "./fixture-config";

/**
 * LSP client integration (plan 24 M2): drives the REAL fixture LSP server (a spawned child
 * speaking Content-Length-framed JSON-RPC over pipes) through the initialize handshake,
 * request correlation, timeouts, document sync + publishDiagnostics collection, crash and
 * garbage classification, and graceful shutdown.
 */

const WORKSPACE_ROOT = "/tmp/lsp-fixture-workspace";

function clientOptions(overrides: Partial<LspClientOptions> = {}): LspClientOptions {
  return {
    serverName: "trevor-lsp-fixture",
    spawn: lspFixtureSpawnSpec(),
    workspaceRoot: WORKSPACE_ROOT,
    requestTimeoutMs: 5_000,
    initTimeoutMs: 5_000,
    ...overrides,
  };
}

async function withClient(
  options: LspClientOptions,
  run: (client: LspClient) => Promise<void>,
): Promise<void> {
  const client = spawnLspClient(options);
  try {
    await run(client);
  } finally {
    await client.shutdown();
  }
}

function hover(client: LspClient, uri: string, line = 2, character = 4): Promise<unknown> {
  return client.request("textDocument/hover", {
    textDocument: { uri },
    position: { line, character },
  });
}

describe("lsp client - handshake", () => {
  it("initializes: captures server capabilities and reaches initialized", async () => {
    await withClient(clientOptions(), async (client) => {
      const init = await client.initialize();
      expect(init.serverInfo).toMatchObject({ name: "trevor-lsp-fixture" });
      expect(client.capabilities()).toMatchObject({ hoverProvider: true });
      expect(client.state()).toMatchObject({ alive: true, initialized: true });
    });
  });

  it("captures a --no-capability server as lacking that provider (unsupported seam)", async () => {
    await withClient(
      clientOptions({ spawn: lspFixtureSpawnSpec(["--no-capability=hover"]) }),
      async (client) => {
        await client.initialize();
        const capabilities = client.capabilities();
        expect(capabilities).toMatchObject({ documentSymbolProvider: true });
        expect(capabilities?.hoverProvider).toBeUndefined();
      },
    );
  });

  it("an initialize timeout is TERMINAL: the child is reaped, later requests fail typed", async () => {
    await withClient(
      clientOptions({ spawn: lspFixtureSpawnSpec(["--init=hang"]), initTimeoutMs: 300 }),
      async (client) => {
        await expect(client.initialize()).rejects.toMatchObject({ _tag: "LspTimeoutError" });
        await expect(hover(client, "file:///a.ts")).rejects.toMatchObject({
          _tag: "LspTimeoutError",
        });
        expect(client.state().lastErrorTag).toBe("LspTimeoutError");
      },
    );
  });

  it("classifies a command that cannot spawn as a server crash", async () => {
    await withClient(
      clientOptions({ spawn: { command: "/nonexistent/trevor-lsp-binary", args: [] } }),
      async (client) => {
        await expect(client.initialize()).rejects.toMatchObject({ _tag: "LspServerCrashError" });
        expect(client.state().alive).toBe(false);
      },
    );
  });
});

describe("lsp client - requests", () => {
  it("round-trips a hover request and correlates concurrent responses", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      const [one, two] = await Promise.all([
        hover(client, "file:///a.ts", 1, 2),
        hover(client, "file:///b.ts", 3, 4),
      ]);
      expect(one).toMatchObject({ contents: { value: "hover:1:2" } });
      expect(two).toMatchObject({ contents: { value: "hover:3:4" } });
    });
  });

  it("times out a request the server never answers; the client stays usable", async () => {
    await withClient(clientOptions({ requestTimeoutMs: 300 }), async (client) => {
      await client.initialize();
      await expect(hover(client, "file:///hang.ts")).rejects.toMatchObject({
        _tag: "LspTimeoutError",
        timeoutMs: 300,
      });
      // Per-request deadline: the transport itself stays up.
      await expect(hover(client, "file:///fine.ts", 5, 6)).resolves.toMatchObject({
        contents: { value: "hover:5:6" },
      });
      expect(client.state().alive).toBe(true);
    });
  });

  it("drains pending requests when the child crashes, keeps a bounded stderr tail", async () => {
    const exits: { expected: boolean; detail: string }[] = [];
    await withClient(clientOptions({ onExit: (info) => exits.push(info) }), async (client) => {
      await client.initialize();
      await expect(hover(client, "file:///crash.ts")).rejects.toMatchObject({
        _tag: "LspServerCrashError",
      });
      expect(client.state().alive).toBe(false);
      await expect(hover(client, "file:///late.ts")).rejects.toMatchObject({
        _tag: "LspServerCrashError",
      });
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({ expected: false });
      expect(exits[0]?.detail).toContain("fixture crashing on request");
    });
  });

  it("classifies a well-framed non-JSON response as malformed", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      await expect(hover(client, "file:///garbage.ts")).rejects.toMatchObject({
        _tag: "LspMalformedResponseError",
      });
    });
  });

  it("a failure-path terminate SIGKILLs a child that ignores SIGTERM", async () => {
    const exits: LspExitInfo[] = [];
    await withClient(
      clientOptions({
        spawn: lspFixtureSpawnSpec(["--ignore-sigterm"]),
        closeGraceMs: 250,
        onExit: (info) => exits.push(info),
      }),
      async (client) => {
        await client.initialize();
        // The garbage body poisons the stream: a terminal failure that must reap the child
        // even though it ignores SIGTERM (the awaitExit -> SIGKILL ladder).
        await expect(hover(client, "file:///garbage.ts")).rejects.toMatchObject({
          _tag: "LspMalformedResponseError",
        });
        await expect.poll(() => exits.length, { timeout: 5_000 }).toBe(1);
        expect(exits[0]).toMatchObject({ expected: false });
        expect(exits[0]?.detail).toContain("SIGKILL");
      },
    );
  });
});

describe("lsp client - document sync and diagnostics", () => {
  it("collects publishDiagnostics after didOpen, decoded to the 1-based contract", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      client.openDocument(
        "file:///w/one.ts",
        "typescript",
        "clean line\noops here\nfine\noops again",
      );
      const diagnostics = await client.waitForDiagnostics("file:///w/one.ts", 5_000);
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics?.[0]).toMatchObject({
        severity: "warning",
        source: "fixture",
        message: "oops on line 2",
        range: { start: { line: 2, column: 1 } },
      });
      expect(client.diagnosticsFor("file:///w/one.ts")).toHaveLength(2);
    });
  });

  it("re-opening a document syncs as a change and replaces its diagnostics", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      client.openDocument("file:///w/two.ts", "typescript", "oops");
      expect(await client.waitForDiagnostics("file:///w/two.ts", 5_000)).toHaveLength(1);
      client.openDocument("file:///w/two.ts", "typescript", "all clean now");
      expect(await client.waitForDiagnostics("file:///w/two.ts", 5_000)).toHaveLength(0);
    });
  });

  it("waitForDiagnostics returns undefined when the server never publishes", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      client.openDocument("file:///w/silent.ts", "typescript", "oops but silent");
      expect(await client.waitForDiagnostics("file:///w/silent.ts", 300)).toBeUndefined();
    });
  });

  it("didClose clears the document's diagnostics", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      client.openDocument("file:///w/three.ts", "typescript", "oops");
      await client.waitForDiagnostics("file:///w/three.ts", 5_000);
      client.closeDocument("file:///w/three.ts");
      expect(await client.waitForDiagnostics("file:///w/three.ts", 5_000)).toHaveLength(0);
    });
  });

  it("drops a publish tagged with an older document version (the stale-wave race)", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      const uri = "file:///w/stale-wave.ts";
      client.openDocument(uri, "typescript", "oops v1");
      expect(await client.waitForDiagnostics(uri, 5_000)).toHaveLength(1);

      // didChange bumps the document to v2; the fixture answers with a LATE v1-tagged wave.
      // The client must drop it: the store keeps waiting for v2 instead of serving stale data.
      client.openDocument(uri, "typescript", "clean v2");
      expect(await client.waitForDiagnostics(uri, 400)).toBeUndefined();
      expect(client.diagnosticsFor(uri)).toBeUndefined();
    });
  });

  it("skips the didChange for unchanged content and keeps the published entry", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      const uri = "file:///w/same.ts";
      client.openDocument(uri, "typescript", "oops same");
      const first = await client.waitForDiagnostics(uri, 5_000);
      expect(first).toHaveLength(1);

      // Identical content: no re-sync, and the stored publish answers waiters instantly.
      client.openDocument(uri, "typescript", "oops same");
      expect(await client.waitForDiagnostics(uri, 5_000)).toEqual(first);

      const syncs = (await client.request("fixture/documentSyncs")) as Record<
        string,
        { didOpen: number; didChange: number }
      >;
      expect(syncs[uri]).toEqual({ didOpen: 1, didChange: 0 });
    });
  });

  it("waits at most the dedicated publish deadline, still capped by the request timeout", async () => {
    // A silent server must release the waiter at the publish deadline, not the (much longer)
    // request timeout.
    await withClient(
      clientOptions({ requestTimeoutMs: 30_000, publishWaitMs: 300 }),
      async (client) => {
        await client.initialize();
        client.openDocument("file:///w/silent-wait.ts", "typescript", "oops but silent");
        const startedAt = Date.now();
        expect(await client.waitForDiagnostics("file:///w/silent-wait.ts")).toBeUndefined();
        expect(Date.now() - startedAt).toBeLessThan(5_000);
      },
    );

    // And the request timeout stays the ceiling when the knob is set higher.
    await withClient(
      clientOptions({ requestTimeoutMs: 300, publishWaitMs: 60_000 }),
      async (client) => {
        await client.initialize();
        client.openDocument("file:///w/silent-cap.ts", "typescript", "oops but silent");
        const startedAt = Date.now();
        expect(await client.waitForDiagnostics("file:///w/silent-cap.ts")).toBeUndefined();
        expect(Date.now() - startedAt).toBeLessThan(5_000);
      },
    );
  });

  it("caps the published store at MAX_LSP_STORED_FILES, evicting the oldest uri", async () => {
    await withClient(clientOptions(), async (client) => {
      await client.initialize();
      const uris = Array.from(
        { length: MAX_LSP_STORED_FILES + 1 },
        (_, index) => `file:///w/cap-${index}.ts`,
      );
      for (const uri of uris) {
        client.openDocument(uri, "typescript", "oops");
      }
      // The pipe is FIFO: once the LAST publish arrived, every earlier one did too.
      expect(await client.waitForDiagnostics(uris.at(-1) as string, 5_000)).toHaveLength(1);

      const stored = client.diagnosticsSnapshot().map((entry) => entry.uri);
      expect(stored).toHaveLength(MAX_LSP_STORED_FILES);
      expect(stored).not.toContain(uris[0]);
      expect(client.diagnosticsFor(uris[0] as string)).toBeUndefined();
    });
  });
});

describe("lsp client - shutdown", () => {
  it("shuts down gracefully: shutdown request, exit notification, expected exit", async () => {
    const exits: { expected: boolean; detail: string }[] = [];
    const client = spawnLspClient(clientOptions({ onExit: (info) => exits.push(info) }));
    await client.initialize();
    await client.shutdown();
    expect(client.state().alive).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ expected: true });
    await expect(hover(client, "file:///after.ts")).rejects.toMatchObject({
      _tag: "LspClosedError",
    });
  });

  it("shutdown is idempotent", async () => {
    const client = spawnLspClient(clientOptions());
    await client.initialize();
    await client.shutdown();
    await client.shutdown();
    expect(client.state().alive).toBe(false);
  });
});

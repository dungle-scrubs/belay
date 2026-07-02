import { pumpStdinFrames, send, sendRaw } from "../support/stdio-frames";

/**
 * A minimal stdio LSP fixture server for the lsp/ integration tests (plan 24 M2). Speaks
 * JSON-RPC 2.0 over LSP Content-Length frames through the shared fixture frame pump
 * (../support/stdio-frames - deliberately independent of src/mcp/framing.ts, per the MCP
 * fixture precedent, so the tests are cross-implementation, not self-confirming).
 *
 * Requests: initialize (capabilities per the --no-capability flag), shutdown,
 * textDocument/hover (answers `hover:<line>:<character>` markdown), textDocument/documentSymbol
 * (a nested fixture outline), workspace/symbol (a small catalog filtered by query),
 * textDocument/codeAction (a quickfix with an edit, a source action without one, a command-only
 * refactor, and - when the request carries context diagnostics - a context-echo action naming
 * the first one, which is how the tests pin that the tool forwards published diagnostics), and
 * fixture/documentSyncs (the per-uri didOpen/didChange counters, for the unchanged-content
 * sync-guard tests).
 *
 * Notifications: initialized (ignored), exit (exits 0), and didOpen/didChange/didClose document
 * sync - didOpen/didChange publish one warning diagnostic per line containing "oops" (none for
 * a uri containing "silent"), tagged with the synced document version; didClose publishes
 * empty. A uri containing "stale-wave" publishes NORMALLY on didOpen but answers didChange
 * with a wave tagged one version BEHIND the sync (the late previous-version publish the
 * client's version gate must drop).
 *
 * Uri triggers on hover requests: "hang" never answers, "crash" writes stderr then exits 7,
 * "garbage" answers a well-framed non-JSON body.
 *
 * Flags: `--init=hang` never answers initialize (init-timeout tests); `--no-capability=<list>`
 * drops providers (comma list of hover, documentSymbol, workspaceSymbol, codeAction) from the
 * initialize result for unsupported-capability tests; `--ignore-sigterm` installs a SIGTERM
 * no-op handler (failure-path kill-ladder tests).
 *
 * Exits 0 when stdin ends.
 */

interface JsonRpcIn {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: {
    readonly textDocument?: {
      readonly uri?: string;
      readonly text?: string;
      readonly version?: number;
    };
    readonly position?: { readonly line?: number; readonly character?: number };
    readonly contentChanges?: readonly { readonly text?: string }[];
    readonly query?: string;
    readonly range?: {
      readonly start?: { readonly line?: number; readonly character?: number };
      readonly end?: { readonly line?: number; readonly character?: number };
    };
    readonly context?: { readonly diagnostics?: readonly ContextDiagnostic[] };
  };
}

interface ContextDiagnostic {
  readonly range?: { readonly start?: { readonly line?: number; readonly character?: number } };
  readonly severity?: number;
  readonly message?: string;
}

const initMode = process.argv.find((arg) => arg.startsWith("--init="))?.slice("--init=".length);

const droppedCapabilities = new Set(
  process.argv
    .find((arg) => arg.startsWith("--no-capability="))
    ?.slice("--no-capability=".length)
    .split(",") ?? [],
);

if (process.argv.includes("--ignore-sigterm")) {
  process.on("SIGTERM", () => {
    // Deliberately ignored: the kill-ladder tests need a child SIGTERM cannot reap.
  });
}

/** The open documents' current full text, keyed by uri (full-sync fixture). */
const documents = new Map<string, string>();

/** The open documents' last synced version, keyed by uri (version-tagged publishes). */
const versions = new Map<string, number>();

/** Per-uri didOpen/didChange counters, answered by fixture/documentSyncs. */
const syncCounts = new Map<string, { didOpen: number; didChange: number }>();

function countSync(uri: string, kind: "didOpen" | "didChange"): void {
  const counts = syncCounts.get(uri) ?? { didOpen: 0, didChange: 0 };
  counts[kind] += 1;
  syncCounts.set(uri, counts);
}

pumpStdinFrames((body) => handle(JSON.parse(body) as JsonRpcIn));

function result(id: JsonRpcIn["id"], value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function initializeResult(): unknown {
  return {
    capabilities: {
      textDocumentSync: 1,
      ...(droppedCapabilities.has("hover") ? {} : { hoverProvider: true }),
      ...(droppedCapabilities.has("documentSymbol") ? {} : { documentSymbolProvider: true }),
      ...(droppedCapabilities.has("workspaceSymbol") ? {} : { workspaceSymbolProvider: true }),
      ...(droppedCapabilities.has("codeAction") ? {} : { codeActionProvider: true }),
    },
    serverInfo: { name: "trevor-lsp-fixture", version: "0.0.1" },
  };
}

/** One warning per line containing "oops"; a uri containing "silent" publishes nothing.
 *  Publishes are tagged with the synced document version when one is known. */
function publishDiagnostics(uri: string, text: string, version?: number): void {
  if (uri.includes("silent")) {
    return;
  }
  const diagnostics = text.split("\n").flatMap((line, index) => {
    const character = line.indexOf("oops");
    if (character === -1) {
      return [];
    }
    return [
      {
        range: {
          start: { line: index, character },
          end: { line: index, character: character + 4 },
        },
        severity: 2,
        source: "fixture",
        message: `oops on line ${index + 1}`,
      },
    ];
  });
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics, ...(version !== undefined ? { version } : {}) },
  });
}

const WORKSPACE_SYMBOLS = [
  { name: "FixtureClass", kind: 5 },
  { name: "fixtureFunction", kind: 12 },
  { name: "FIXTURE_CONST", kind: 14 },
] as const;

function handle(message: JsonRpcIn): void {
  const { method, id, params } = message;
  if (method === undefined) {
    return; // the client never sends us responses in this fixture
  }

  if (method === "initialize") {
    if (initMode === "hang") {
      return; // deliberately never answers the handshake (init-timeout tests)
    }
    result(id, initializeResult());
    return;
  }
  if (method === "shutdown") {
    result(id, null);
    return;
  }
  if (method === "exit") {
    process.exit(0);
  }

  if (method === "textDocument/didOpen") {
    const uri = params?.textDocument?.uri ?? "";
    const text = params?.textDocument?.text ?? "";
    const version = params?.textDocument?.version ?? 1;
    documents.set(uri, text);
    versions.set(uri, version);
    countSync(uri, "didOpen");
    publishDiagnostics(uri, text, version);
    return;
  }
  if (method === "textDocument/didChange") {
    const uri = params?.textDocument?.uri ?? "";
    const text = params?.contentChanges?.[0]?.text ?? "";
    const version = params?.textDocument?.version ?? (versions.get(uri) ?? 0) + 1;
    documents.set(uri, text);
    versions.set(uri, version);
    countSync(uri, "didChange");
    // The stale-wave trigger: this change's publish arrives tagged one version BEHIND the
    // sync - the late previous-version wave the client's version gate must drop (C1).
    publishDiagnostics(uri, text, uri.includes("stale-wave") ? version - 1 : version);
    return;
  }
  if (method === "textDocument/didClose") {
    const uri = params?.textDocument?.uri ?? "";
    documents.delete(uri);
    versions.delete(uri);
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    });
    return;
  }

  if (method === "fixture/documentSyncs") {
    result(id, Object.fromEntries(syncCounts));
    return;
  }

  if (method === "textDocument/hover") {
    const uri = params?.textDocument?.uri ?? "";
    if (uri.includes("hang")) {
      return; // deliberately never responds (per-request timeout tests)
    }
    if (uri.includes("crash")) {
      process.stderr.write("fixture crashing on request\n", () =>
        setTimeout(() => process.exit(7), 25),
      );
      return;
    }
    if (uri.includes("garbage")) {
      sendRaw("this is not json {");
      return;
    }
    const line = params?.position?.line ?? 0;
    const character = params?.position?.character ?? 0;
    result(id, {
      contents: { kind: "markdown", value: `hover:${line}:${character}` },
      range: { start: { line, character }, end: { line, character: character + 1 } },
    });
    return;
  }

  if (method === "textDocument/documentSymbol") {
    result(id, [
      {
        name: "FixtureClass",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 18 } },
        children: [
          {
            name: "fixtureMethod",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 15 } },
            children: [],
          },
        ],
      },
    ]);
    return;
  }

  if (method === "workspace/symbol") {
    const query = (params?.query ?? "").toLowerCase();
    result(
      id,
      WORKSPACE_SYMBOLS.filter((symbol) => symbol.name.toLowerCase().includes(query)).map(
        (symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          location: {
            uri: "file:///fixture/workspace/symbols.ts",
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
          },
        }),
      ),
    );
    return;
  }

  if (method === "textDocument/codeAction") {
    const uri = params?.textDocument?.uri ?? "";
    // Echo the received CodeActionContext (plan 24 M9): real servers (tsserver) only produce
    // quickfixes from the diagnostics the CLIENT forwards in context AND only when the request
    // range intersects the error span, so this proposal exists exactly when the tool forwarded
    // overlapping published diagnostics - in 0-based wire shape - and names the request range.
    const context = params?.context?.diagnostics ?? [];
    const first = context[0];
    const requestRange =
      `${params?.range?.start?.line ?? "?"}:${params?.range?.start?.character ?? "?"}-` +
      `${params?.range?.end?.line ?? "?"}:${params?.range?.end?.character ?? "?"}`;
    const contextEcho =
      first === undefined
        ? []
        : [
            {
              title:
                `context-echo: ${context.length} diagnostic(s): ` +
                `sev${first.severity ?? "?"} ${first.range?.start?.line ?? "?"}:` +
                `${first.range?.start?.character ?? "?"} ${first.message ?? ""} ` +
                `@${requestRange}`,
              kind: "source.contextEcho",
            },
          ];
    result(id, [
      ...contextEcho,
      {
        title: "Fix the oops",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          changes: {
            [uri]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
                newText: "okay",
              },
            ],
          },
        },
      },
      { title: "Organize imports", kind: "source.organizeImports" },
      {
        title: "Move to a new file",
        kind: "refactor.move",
        command: {
          title: "Move to a new file",
          command: "_typescript.applyRefactoring",
          arguments: [],
        },
      },
    ]);
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }
}

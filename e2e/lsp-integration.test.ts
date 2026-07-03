import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvalWorkspace, installEvalServer } from "@trevor/agent-host/testing/lsp-fixtures";
import type { RunningServer } from "@trevor/server-kit";
import type { SessionEvent } from "@trevor/session";
import { afterAll, beforeAll, describe, test } from "vitest";

/**
 * S-E2E LSP suite (plan 24 M9, D-006 / Gate 4): the read-only LSP tool surface, end to end and
 * hermetic. A REAL temp TS workspace (tsconfig + sources) is the host's TREVOR_WORKSPACE, and
 * the eval fixture server installs as its workspace-local `typescript-language-server` binary,
 * so the exact production path (boot/paths -> lsp/host-runtime singleton -> TS/JS adapter
 * detection -> node_modules/.bin resolution -> spawn -> initialize -> lsp_* tools) is exercised
 * with no network and no globally-installed server.
 *
 * Every capability drives the FULL HOST PATH: fake-provider turns publish through a real
 * session-store while the registered lsp_* tools (bound to the host manager SINGLETON) answer
 * status, diagnostics, hover, document symbols, workspace symbols, and code-action proposals.
 * The suite starts with NO server binary anywhere (shim absent, PATH cleared per turn), proving
 * the unavailable path degrades to bounded text while read/grep keep working IN THE SAME TURN
 * (D-006); the shim then installs mid-suite and the manager's next lazy acquire recovers.
 *
 * ORDERING MATTERS: `@trevor/session/node-paths` binds TREVOR_HOME/TREVOR_WORKSPACE at first
 * evaluation, and the host testing surface reaches it (the LSP singleton reads WORKSPACE_ROOT
 * at import). So this file's static imports are strictly side-effect-free (node builtins,
 * types, the LSP fixture-workspace surface); the env override runs at module scope; and every
 * node-paths-reaching module loads DYNAMICALLY in beforeAll.
 */

// --- hermetic home + workspace, BEFORE any node-paths-reaching module loads ---

const HOME = mkdtempSync(join(tmpdir(), "trevor-e2e-lsp-home-"));
const STATE = mkdtempSync(join(tmpdir(), "trevor-e2e-lsp-state-"));

// The workspace starts WITHOUT the server shim: the first describe proves the unavailable path
// through the production adapter's real binary lookup before installEvalServer() flips it.
const WS = createEvalWorkspace({
  server: false,
  files: {
    "src/widgets/factory.ts": [
      "export interface Widget {",
      "  readonly id: string;",
      "  readonly label: string;",
      "}",
      "",
      "export function createWidget(id: string, label: string): Widget {",
      "  return { id, label };",
      "}",
      "",
    ].join("\n"),
    "src/gadgets.ts": [
      "export interface Gadget {",
      "  readonly size: number;",
      "}",
      "",
      "export function makeGadget(size: number): Gadget {",
      "  return { size };",
      "}",
      "",
    ].join("\n"),
    "src/broken.ts": [
      'import { makeGadget } from "./gadgets";',
      "",
      "export const gadget = makeGadget(3);",
      'export const label: number = "not-a-number";',
      "",
    ].join("\n"),
    "src/app.ts": ["export function appMain(): string {", '  return "ok";', "}", ""].join("\n"),
  },
});

const SAVED_ENV = {
  TREVOR_HOME: process.env.TREVOR_HOME,
  TREVOR_STATE_HOME: process.env.TREVOR_STATE_HOME,
  TREVOR_WORKSPACE: process.env.TREVOR_WORKSPACE,
};

process.env.TREVOR_HOME = HOME;
process.env.TREVOR_STATE_HOME = STATE;
process.env.TREVOR_WORKSPACE = WS;

type HostTesting = typeof import("@trevor/agent-host/testing");
type SessionModule = typeof import("@trevor/session");
type TestKit = typeof import("@trevor/test-kit");
type Viewer = ReturnType<TestKit["subscribe"]>;

let host: HostTesting;
let session: SessionModule;
let kit: TestKit;
let store: RunningServer;

beforeAll(async () => {
  session = await import("@trevor/session");
  kit = await import("@trevor/test-kit");
  const { bootStore } = await import("@trevor/test-kit/boot");

  // Only now may the host surface load: its LSP singleton binds WORKSPACE_ROOT at import.
  host = await import("@trevor/agent-host/testing");
  store = await bootStore();
});

afterAll(async () => {
  await host?.lspManager.close();
  await store?.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  rmSync(WS, { recursive: true, force: true });
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

interface ScriptedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** Runs a scripted fake-provider turn through the real store and returns the subscriber. */
async function runLspTurn(
  sessionId: string,
  calls: readonly ScriptedCall[],
  answer: string,
): Promise<Viewer> {
  const transport = session.streamTransport(store.url);
  const viewer = await kit.joinSession(transport, sessionId, "viewer");

  await host.publishTurnVia(
    host.transportEmit(transport, sessionId, "host"),
    host.fakeProvider({ step: host.scriptedStep(calls, answer) }),
    [{ role: "user", content: "Use the language server tools." }],
    { runId: `r-${sessionId}` },
  );

  await viewer.waitForType("assistant.completed", {
    label: `assistant.completed ${sessionId}`,
    timeoutMs: 55_000,
  });
  return viewer;
}

/** The published result of the named tool's completion ("" when it never completed). */
function toolResult(viewer: Viewer, name: string): string {
  const completed = viewer.events.find(
    (e: SessionEvent) => e.type === "tool.completed" && e.payload.name === name,
  );
  return String(completed?.payload.result ?? "");
}

/** Every tool the turn started, in order. */
function toolNames(viewer: Viewer): string[] {
  return viewer.events
    .filter((e: SessionEvent) => e.type === "tool.started")
    .map((e) => String(e.payload.name));
}

function completedError(viewer: Viewer): unknown {
  return viewer.events.find((e: SessionEvent) => e.type === "assistant.completed")?.payload.error;
}

describe("unavailable path - no server binary anywhere (D-006)", () => {
  test("the LSP call degrades to bounded text while read and grep answer in the SAME turn", async () => {
    // The adapter's PATH fallback reads the env at resolve time; clearing it makes "not
    // installed" deterministic even on a machine with a real typescript-language-server.
    const prevPath = process.env.PATH;
    process.env.PATH = "";
    let viewer: Viewer;
    try {
      viewer = await runLspTurn(
        "lsp-unavailable-turn",
        [
          { name: "lsp_workspace_symbols", args: { query: "appMain" } },
          { name: "read", args: { path: join(WS, "src/app.ts") } },
          { name: "grep", args: { pattern: "appMain" } },
        ],
        "No language server here; searched and read the file instead.",
      );
    } finally {
      process.env.PATH = prevPath;
    }

    // Bounded degraded SUCCESS text, not a thrown turn failure.
    const symbols = toolResult(viewer, "lsp_workspace_symbols");
    assert.match(symbols, /not installed/);
    assert.match(symbols, /typescript-language-server/);
    assert.ok(symbols.length < 500, `degraded text stays bounded (${symbols.length} chars)`);

    // One LSP attempt, then normal file/search work in the same turn.
    assert.deepEqual(toolNames(viewer), ["lsp_workspace_symbols", "read", "grep"]);
    assert.ok(toolResult(viewer, "read").includes('return "ok"'));
    assert.ok(toolResult(viewer, "grep").includes("src/app.ts"));
    assert.equal(completedError(viewer), undefined);
    viewer.connection.close();
  });

  test("lsp_status reports the workspace unavailable without spawning anything", async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = "";
    let viewer: Viewer;
    try {
      viewer = await runLspTurn(
        "lsp-unavailable-status",
        [{ name: "lsp_status", args: {} }],
        "The language server is unavailable.",
      );
    } finally {
      process.env.PATH = prevPath;
    }
    assert.match(toolResult(viewer, "lsp_status"), /unavailable/);
    assert.equal(completedError(viewer), undefined);
    viewer.connection.close();
  });
});

describe("ready path - the full read-only matrix through the host tool layer", () => {
  beforeAll(() => {
    // Install the fixture server as the workspace-local binary: the manager's next lazy
    // acquire re-resolves node_modules/.bin and recovers without a restart (D-006).
    installEvalServer(WS);
  });

  test("navigation + orientation: workspace symbols, document symbols, hover", async () => {
    const viewer = await runLspTurn(
      "lsp-navigation",
      [
        { name: "lsp_workspace_symbols", args: { query: "createWidget" } },
        { name: "lsp_document_symbols", args: { file: "src/widgets/factory.ts" } },
        { name: "lsp_hover", args: { file: "src/broken.ts", line: 3, column: 24 } },
      ],
      "createWidget is defined in factory.ts; makeGadget takes a number.",
    );

    // Workspace symbols carry the definition's real provenance: kind, name, file, position.
    const symbols = toolResult(viewer, "lsp_workspace_symbols");
    assert.match(symbols, /workspace symbol\(s\) matching "createWidget"/);
    assert.match(symbols, /- function createWidget src\/widgets\/factory\.ts:6:17/);

    // The outline covers the file's top-level symbols without dumping its body.
    const outline = toolResult(viewer, "lsp_document_symbols");
    assert.match(outline, /^outline of src\/widgets\/factory\.ts /);
    assert.ok(outline.includes("interface Widget"), outline);
    assert.ok(outline.includes("function createWidget"), outline);

    // Hover at the call site returns the declared signature from the other module.
    const hover = toolResult(viewer, "lsp_hover");
    assert.match(hover, /^hover at src\/broken\.ts:3:24/);
    assert.ok(hover.includes("export function makeGadget(size: number): Gadget"), hover);

    assert.equal(completedError(viewer), undefined);
    viewer.connection.close();
  });

  test("typed repair: diagnostics pinpoint the break; code actions stay proposals (D-005)", async () => {
    const brokenPath = join(WS, "src/broken.ts");
    const before = readFileSync(brokenPath, "utf8");

    const viewer = await runLspTurn(
      "lsp-repair",
      [
        { name: "lsp_diagnostics", args: { file: "src/broken.ts" } },
        { name: "lsp_code_actions", args: { file: "src/broken.ts", startLine: 4, endLine: 4 } },
      ],
      "Line 4 assigns a string to a number; a quickfix proposal exists.",
    );

    // Diagnostics carry the exact file, line, severity, and code - never a project dump.
    const diagnostics = toolResult(viewer, "lsp_diagnostics");
    assert.match(diagnostics, /1 diagnostic\(s\) in src\/broken\.ts/);
    assert.match(
      diagnostics,
      /^4:30-4:45 error \[ts 2322\] Type 'string' is not assignable to type 'number'\.$/m,
    );

    // Code actions arrive as read-only proposals with a serialized edit preview.
    const actions = toolResult(viewer, "lsp_code_actions");
    assert.match(actions, /proposals only - nothing is applied/);
    assert.match(actions, /\[quickfix\] \(preferred\)/);
    assert.match(actions, /src\/broken\.ts 4:21-4:27 -> "string"/);

    // NOTHING was applied: the file on disk is byte-identical after the turn (D-005).
    assert.equal(readFileSync(brokenPath, "utf8"), before);

    assert.equal(completedError(viewer), undefined);
    viewer.connection.close();
  });

  test("lsp_status reports the recovered workspace ready through the same singleton", async () => {
    const viewer = await runLspTurn(
      "lsp-ready-status",
      [{ name: "lsp_status", args: {} }],
      "The language server is ready.",
    );
    const status = toolResult(viewer, "lsp_status");
    assert.match(status, /ready/);
    assert.match(status, /typescript-language-server/);
    assert.equal(completedError(viewer), undefined);
    viewer.connection.close();
  });
});

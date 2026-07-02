import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, test } from "vitest";
import { createEvalWorkspace } from "./eval-workspace";
import { finalAnswer, scriptedProvider, toolCallNames, toolResult } from "./scripted-turn";

/**
 * Plan 24 M7 distraction regression, missing-binary case (D-009, D-006): a TS workspace with NO
 * language server installed anywhere (no workspace-local binary, PATH cleared) must degrade to
 * bounded "not installed" text inside a full fake-provider turn that then proceeds to normal
 * read/answer work. Its own file because the workspace binds per test module (TREVOR_WORKSPACE
 * is read at host-module load) and this one must NOT carry the fixture server shim.
 */

const ws = createEvalWorkspace({
  server: false,
  files: {
    "src/app.ts": ["export function appMain(): string {", '  return "ok";', "}", ""].join("\n"),
  },
});

const prevWorkspace = process.env.TREVOR_WORKSPACE;
process.env.TREVOR_WORKSPACE = ws;

const { runTurn } = await import("../support/fake-provider");
const { executeTool } = await import("@host/tools/index");
const { lspManager } = await import("@host/lsp/host-runtime");

// The adapter's PATH fallback reads the env at resolve time, so clearing PATH here (after the
// imports, before any turn) makes "not installed" deterministic even on a machine that has a
// real typescript-language-server on PATH.
const prevPath = process.env.PATH;

beforeAll(() => {
  process.env.PATH = "";
});

afterAll(async () => {
  await lspManager.close();
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  if (prevWorkspace === undefined) delete process.env.TREVOR_WORKSPACE;
  else process.env.TREVOR_WORKSPACE = prevWorkspace;
  rmSync(ws, { recursive: true, force: true });
});

test("a missing server binary degrades in-turn to bounded text and normal work continues", async () => {
  const provider = await scriptedProvider(
    [
      { name: "lsp_workspace_symbols", args: { query: "appMain" } },
      { name: "read", args: { path: join(ws, "src/app.ts") } },
    ],
    "No language server here; read the file instead: appMain returns ok.",
  );
  const events = await runTurn(provider, [{ role: "user", content: "Where is appMain?" }], {
    runId: "distract-missing",
  });

  // The lsp result is bounded degraded SUCCESS text, not a thrown turn failure.
  const symbols = toolResult(events, "lsp_workspace_symbols");
  assert.match(symbols, /not installed/);
  assert.match(symbols, /typescript-language-server/);
  assert.ok(symbols.length < 500, `degraded text stays bounded (${symbols.length} chars)`);

  // One LSP attempt, then straight to normal read/answer work.
  assert.deepEqual(toolCallNames(events), ["lsp_workspace_symbols", "read"]);
  assert.ok(toolResult(events, "read").includes('return "ok"'));

  const final = finalAnswer(events);
  assert.equal(final.error, undefined);
  assert.ok(final.text.includes("read the file instead"), final.text);
});

test("lsp_status reports the unavailable workspace without spawning anything", async () => {
  const status = await Effect.runPromise(executeTool("lsp_status", "{}"));
  assert.match(status, /unavailable/);
});

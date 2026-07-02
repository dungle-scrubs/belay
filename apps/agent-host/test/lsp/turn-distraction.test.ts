import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createEvalWorkspace } from "./eval-workspace";
import { finalAnswer, scriptedProvider, toolCallNames, toolResult } from "./scripted-turn";

/**
 * Plan 24 M7 distraction regressions (D-009, D-006): a degraded language server must never
 * derail a turn. Each case drives a FULL fake-provider turn through the production path (the
 * host LSP singleton over TREVOR_WORKSPACE) that calls one lsp tool and then proceeds to normal
 * read/answer work, asserting the turn COMPLETES with the normal answer, the LSP result stays
 * bounded, and no further LSP calls follow the degraded one:
 *
 * - hanging (slow) server: the hover result degrades to bounded timeout text within the
 *   env-tuned request timeout (TREVOR_LSP_REQUEST_TIMEOUT_MS - the M7 runtime fix), so the
 *   turn's wall clock stays far below the 15s compile-time default;
 * - noisy server: hundreds of published diagnostics come back capped, never a dump;
 * - stale server: a long-quiet server reports "stale" as data, and requests still answer -
 *   staleness never blocks work.
 *
 * The missing-binary case lives in ./turn-missing-binary.test.ts (it needs a workspace without
 * the fixture server and a cleared PATH). Env binds before the dynamic host import.
 */

const NOISY_LINES = 300;

const ws = createEvalWorkspace({
  server: true,
  files: {
    "src/app.ts": ["export function appMain(): string {", '  return "ok";', "}", ""].join("\n"),
    "src/hang.ts": ["export const hangMarker = 1;", ""].join("\n"),
    "src/noisy.ts": `${Array.from(
      { length: NOISY_LINES },
      (_, index) => `const entry${index} = ${index}; // noisy_diag`,
    ).join("\n")}\n`,
  },
});

const prevEnv = {
  TREVOR_WORKSPACE: process.env.TREVOR_WORKSPACE,
  TREVOR_LSP_REQUEST_TIMEOUT_MS: process.env.TREVOR_LSP_REQUEST_TIMEOUT_MS,
  TREVOR_LSP_INIT_TIMEOUT_MS: process.env.TREVOR_LSP_INIT_TIMEOUT_MS,
  TREVOR_LSP_STALE_AFTER_MS: process.env.TREVOR_LSP_STALE_AFTER_MS,
};

process.env.TREVOR_WORKSPACE = ws;
process.env.TREVOR_LSP_REQUEST_TIMEOUT_MS = "700";
process.env.TREVOR_LSP_INIT_TIMEOUT_MS = "8000";
process.env.TREVOR_LSP_STALE_AFTER_MS = "40";

const { runTurn } = await import("../support/fake-provider");
const { lspManager } = await import("@host/lsp/host-runtime");

beforeAll(async () => {
  // Warm the server once so the hang case times the REQUEST timeout, not spawn+initialize.
  const acquired = await lspManager.acquire();
  assert.equal(acquired.kind, "ready", JSON.stringify(acquired));
});

afterAll(async () => {
  await lspManager.close();
  for (const [name, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(ws, { recursive: true, force: true });
});

const user = (content: string) => [{ role: "user" as const, content }];

test("a hanging LSP request degrades to bounded timeout text within the request timeout - no turn hang", async () => {
  const provider = await scriptedProvider(
    [
      { name: "lsp_hover", args: { file: "src/hang.ts", line: 1, column: 14 } },
      { name: "read", args: { path: join(ws, "src/app.ts") } },
    ],
    "LSP was slow, proceeding from the file itself: appMain returns ok.",
  );
  const startedAt = Date.now();
  const events = await runTurn(provider, user("What does hangMarker mean?"), {
    runId: "distract-slow",
  });
  const elapsedMs = Date.now() - startedAt;

  // The hover degraded to bounded SUCCESS text at the env-tuned 700ms timeout: the whole
  // multi-step turn stays far below the 15s compile-time default (the env knob demonstrably
  // applied) and nothing hung.
  const hover = toolResult(events, "lsp_hover");
  assert.match(hover, /language server timed out/i);
  assert.ok(hover.length < 500, `degraded text stays bounded (${hover.length} chars)`);
  assert.ok(elapsedMs < 5_000, `turn took ${elapsedMs}ms - the request timeout did not apply`);

  // One LSP attempt, then straight to normal work - never a retry loop on a degraded server.
  assert.deepEqual(toolCallNames(events), ["lsp_hover", "read"]);
  assert.ok(toolResult(events, "read").includes('return "ok"'));

  const final = finalAnswer(events);
  assert.equal(final.error, undefined);
  assert.ok(final.text.includes("proceeding from the file itself"), final.text);
});

test("a noisy server's hundreds of diagnostics come back capped, and the turn completes", async () => {
  const provider = await scriptedProvider(
    [
      { name: "lsp_diagnostics", args: { file: "src/noisy.ts" } },
      { name: "read", args: { path: join(ws, "src/app.ts") } },
    ],
    "The noise is capped; the app itself is fine.",
  );
  const events = await runTurn(provider, user("Anything wrong in src/noisy.ts?"), {
    runId: "distract-noisy",
  });

  // 300 published diagnostics arrive bounded twice over: the client retains a capped store and
  // the tool renders at most its result cap - never a dump that buries the turn.
  const diagnostics = toolResult(events, "lsp_diagnostics");
  assert.match(diagnostics, /showing the first 50/);
  assert.ok(
    diagnostics.split("\n").length <= 52,
    `diagnostic lines stay capped (${diagnostics.split("\n").length})`,
  );
  assert.ok(diagnostics.length < 8_100, `result stays bounded (${diagnostics.length} chars)`);

  assert.deepEqual(toolCallNames(events), ["lsp_diagnostics", "read"]);
  const final = finalAnswer(events);
  assert.equal(final.error, undefined);
  assert.ok(final.text.includes("capped"), final.text);
});

test("a stale server reports stale as data and still answers - staleness never blocks work", async () => {
  // The server answered last in a previous test; with the env-tuned 40ms threshold it is now
  // long quiet, so status reports stale age instead of ready.
  await new Promise((resolvePause) => setTimeout(resolvePause, 120));

  const provider = await scriptedProvider(
    [
      { name: "lsp_status", args: {} },
      { name: "lsp_hover", args: { file: "src/app.ts", line: 1, column: 17 } },
      { name: "read", args: { path: join(ws, "src/app.ts") } },
    ],
    "The server sat idle but still answers; appMain returns a string.",
  );
  const events = await runTurn(provider, user("Is the language server still fine?"), {
    runId: "distract-stale",
  });

  assert.match(toolResult(events, "lsp_status"), /stale/);
  // Stale is advisory: the very next request still answers with the real signature.
  assert.ok(
    toolResult(events, "lsp_hover").includes("export function appMain(): string"),
    toolResult(events, "lsp_hover"),
  );

  assert.deepEqual(toolCallNames(events), ["lsp_status", "lsp_hover", "read"]);
  const final = finalAnswer(events);
  assert.equal(final.error, undefined);
  assert.ok(final.text.includes("still answers"), final.text);
});

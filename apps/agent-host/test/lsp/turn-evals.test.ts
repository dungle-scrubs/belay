import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, test } from "vitest";
import { createEvalWorkspace } from "./eval-workspace";
import { finalAnswer, scriptedProvider, toolResult } from "./scripted-turn";

/**
 * Plan 24 M7 fixture evals (D-009): full fake-provider turns through the PRODUCTION path
 * (TREVOR_WORKSPACE -> boot/paths -> host LSP singleton -> tool registry -> turn pipeline)
 * against a real fixture TS workspace whose language server answers from workspace content
 * (./fixture-eval-lsp-server.ts). Each eval renders the plan's value claim as a measured
 * assertion:
 *
 * - navigation: `lsp_workspace_symbols` returns the named definition's real location in far
 *   fewer characters than the equivalent broad grep dump over the same workspace;
 * - file orientation: `lsp_document_symbols` covers every top-level symbol of a large file in
 *   far fewer characters than reading the file;
 * - typed repair: `lsp_diagnostics` pinpoints the offending file+line and `lsp_hover` returns
 *   the exact declared signature - the tool results carry the precise fact needed.
 *
 * The workspace root is read at host-module load, so TREVOR_WORKSPACE binds before the dynamic
 * import (the grep.test.ts precedent).
 */

// --- the fixture workspace: one definition, many usages, a large file, a typed break ---

const CONSUMERS = 6;
const USAGES_PER_CONSUMER = 8;

function consumerModule(index: number): string {
  const lines = [
    'import { createWidget } from "../widgets/factory";',
    "",
    `export const widgets${index} = [`,
  ];
  for (let usage = 0; usage < USAGES_PER_CONSUMER; usage += 1) {
    lines.push(
      `  createWidget("id-${index}-${usage}", "widget ${index}-${usage} via createWidget"),`,
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

const PIPELINE_STAGES = [
  "loadSource",
  "tokenizeSource",
  "parseTokens",
  "bindSymbols",
  "checkTypes",
  "lowerToIr",
  "optimizeIr",
  "allocateRegisters",
  "scheduleInstructions",
  "emitObjectCode",
  "linkArtifacts",
  "reportPipeline",
] as const;

function pipelineModule(): string {
  const lines = [
    "export interface PipelineOptions {",
    "  readonly strict: boolean;",
    "  readonly verbose: boolean;",
    "}",
    "",
  ];
  for (const stage of PIPELINE_STAGES) {
    lines.push(`export function ${stage}(input: string, options: PipelineOptions): string {`);
    for (let step = 0; step < 24; step += 1) {
      lines.push(`  // step ${step}: ${stage} keeps transforming the input toward the next stage`);
    }
    lines.push("  return options.strict ? input.trim() : input;", "}", "");
  }
  return lines.join("\n");
}

const ws = createEvalWorkspace({
  server: true,
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
    ...Object.fromEntries(
      Array.from({ length: CONSUMERS }, (_, index) => [
        `src/consumers/consumer-${index + 1}.ts`,
        consumerModule(index + 1),
      ]),
    ),
    "src/pipeline.ts": pipelineModule(),
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
  },
});

const prevWorkspace = process.env.TREVOR_WORKSPACE;
process.env.TREVOR_WORKSPACE = ws;

const { runTurn } = await import("../support/fake-provider");
const { executeTool } = await import("@host/tools/index");
const { lspManager } = await import("@host/lsp/host-runtime");

afterAll(async () => {
  await lspManager.close();
  if (prevWorkspace === undefined) delete process.env.TREVOR_WORKSPACE;
  else process.env.TREVOR_WORKSPACE = prevWorkspace;
  rmSync(ws, { recursive: true, force: true });
});

const user = (content: string) => [{ role: "user" as const, content }];

test("navigation: workspace symbols return the real definition location in far fewer chars than grep", async () => {
  const provider = await scriptedProvider(
    [
      { name: "lsp_workspace_symbols", args: { query: "createWidget" } },
      { name: "read", args: { path: join(ws, "src/widgets/factory.ts") } },
    ],
    "createWidget is defined in src/widgets/factory.ts.",
  );
  const events = await runTurn(provider, user("Where is createWidget defined?"), {
    runId: "eval-nav",
  });

  // The symbol result carries the definition's provenance: kind, name, file, 1-based position.
  const symbols = toolResult(events, "lsp_workspace_symbols");
  assert.match(symbols, /workspace symbol\(s\) matching "createWidget"/);
  assert.match(symbols, /- function createWidget src\/widgets\/factory\.ts:6:17/);

  // The turn completed normally on the scripted answer - the model could act on the location.
  const final = finalAnswer(events);
  assert.equal(final.error, undefined);
  assert.ok(final.text.includes("src/widgets/factory.ts"), final.text);

  // The equivalent broad grep over the same workspace dwarfs the symbol result: every usage
  // site in every consumer comes back, burying the one definition line.
  const grep = await Effect.runPromise(
    executeTool("grep", JSON.stringify({ pattern: "createWidget" })),
  );
  assert.ok(grep.includes("src/widgets/factory.ts:6"), "grep does contain the definition line");
  assert.ok(
    grep.length >= symbols.length * 8,
    `expected symbols (${symbols.length} chars) << grep (${grep.length} chars)`,
  );
});

test("file orientation: the outline covers every top-level symbol in far fewer chars than reading", async () => {
  const provider = await scriptedProvider(
    [{ name: "lsp_document_symbols", args: { file: "src/pipeline.ts" } }],
    "The pipeline module runs twelve stages from loadSource to reportPipeline.",
  );
  const events = await runTurn(provider, user("What does src/pipeline.ts contain?"), {
    runId: "eval-outline",
  });

  const outline = toolResult(events, "lsp_document_symbols");
  assert.match(outline, /^outline of src\/pipeline\.ts /);
  // Complete coverage: every top-level symbol of the file appears in the outline.
  assert.ok(outline.includes("interface PipelineOptions"), outline);
  for (const stage of PIPELINE_STAGES) {
    assert.ok(outline.includes(`function ${stage}`), `outline misses ${stage}`);
  }
  assert.equal(finalAnswer(events).error, undefined);

  // Orientation cost: the outline is a fraction of what reading the same file returns.
  const read = await Effect.runPromise(
    executeTool("read", JSON.stringify({ path: join(ws, "src/pipeline.ts") })),
  );
  assert.ok(
    read.length >= outline.length * 8,
    `expected outline (${outline.length} chars) << read (${read.length} chars)`,
  );
});

test("typed repair: diagnostics pinpoint the file+line and hover returns the exact signature", async () => {
  const provider = await scriptedProvider(
    [
      { name: "lsp_diagnostics", args: { file: "src/broken.ts" } },
      { name: "lsp_hover", args: { file: "src/broken.ts", line: 3, column: 24 } },
    ],
    "Line 4 assigns a string to a number; makeGadget(size: number) is fine.",
  );
  const events = await runTurn(provider, user("Why does src/broken.ts fail to typecheck?"), {
    runId: "eval-repair",
  });

  // Diagnostics carry the exact file, line, severity, and message - not a project dump.
  const diagnostics = toolResult(events, "lsp_diagnostics");
  assert.match(diagnostics, /1 diagnostic\(s\) in src\/broken\.ts/);
  assert.match(
    diagnostics,
    /^4:30-4:45 error \[ts 2322\] Type 'string' is not assignable to type 'number'\.$/m,
  );

  // Hover at the call site returns the declared signature - the exact fact a repair needs.
  const hover = toolResult(events, "lsp_hover");
  assert.match(hover, /^hover at src\/broken\.ts:3:24/);
  assert.ok(hover.includes("export function makeGadget(size: number): Gadget"), hover);

  assert.equal(finalAnswer(events).error, undefined);
});

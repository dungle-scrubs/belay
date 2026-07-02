import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceConfined, WORKSPACE_CONFINED_TOOLS } from "@host/boot/paths";
import { contextRegistry } from "@host/project-context/registry";
import { test } from "vitest";
import { buildSystemPrompt, SystemPromptBuilder, systemPromptBuilder } from "./system-prompt";

/**
 * Characterization tests for the workspace-confinement policy (M10 / D-010).
 *
 * The confined tool set was tacit (which tools call confine()) and the rule was stated
 * twice, near-verbatim, in two places in the system prompt - and the prompt advertised
 * glob/grep as confined though they enforce it via `cwd: WORKSPACE_ROOT`, not confine().
 * These pin the EXACT two prompt sentences (the hard constraint is no prompt-content
 * change) and the advertised confined set, so the rule can be owned as one policy that
 * both the prompt and the per-tool enforcement derive from without drifting.
 */

const TOOLS = [{ name: "edit", description: "Edit a file.", parameters: {} }];

test("the advertised workspace-confined set is exactly edit, glob, grep", () => {
  assert.deepEqual([...WORKSPACE_CONFINED_TOOLS], ["edit", "glob", "grep"]);
});

test("isWorkspaceConfined matches the set the prompt advertises", () => {
  for (const tool of ["edit", "glob", "grep"]) {
    assert.equal(isWorkspaceConfined(tool), true);
  }
  for (const tool of ["read", "write", "bash"]) {
    assert.equal(isWorkspaceConfined(tool), false);
  }
});

test("buildSystemPrompt states the confinement rule verbatim - the executionContext line", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes(
      "edit, glob, and grep are confined to the workspace root; read, write, and bash run from the host working directory and accept absolute paths.",
    ),
  );
});

test("buildSystemPrompt states the confinement rule verbatim - the tool-selection line", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes(
      "edit, glob, and grep are scoped to the workspace root; use paths relative to it. read, write, and bash use the host working directory and accept absolute paths.",
    ),
  );
});

// --- D-073 M6: the `doctor` tool is diagnostics-only, not routine context-gathering ---

test("buildSystemPrompt guides the model to use doctor only as a diagnostic, not routine context", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  // It explains what doctor is (Trevor's own host self-diagnostic)...
  assert.ok(
    prompt.includes("The doctor tool runs Trevor's own host self-diagnostic"),
    "the prompt describes the doctor self-diagnostic tool",
  );
  // ...and pins the constraint that it is NOT routine context-gathering for ordinary coding.
  assert.ok(
    prompt.includes("never as routine context-gathering for ordinary coding work"),
    "the prompt forbids routine doctor calls during ordinary coding",
  );
});

// --- Plan 17 M8: recurring work is the explicit /loop command, never model-invented ---

test("buildSystemPrompt points recurring work at /loop and forbids hidden self-repeating work", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  // It steers the user to the explicit command...
  assert.ok(prompt.includes("/loop"), "the prompt names the /loop command for recurring work");
  // ...and pins that the model must not start recurring work on its own.
  assert.ok(
    prompt.includes("do NOT invent hidden loops"),
    "the prompt forbids model-invented recurring work",
  );
  assert.ok(
    prompt.includes("only runs when the user explicitly creates one"),
    "the prompt requires explicit user creation for a loop to run",
  );
});

// --- Plan 19 M5: Mermaid is available for inline transcript explanations ---

test("buildSystemPrompt advertises Mermaid fenced blocks on tool routes", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });

  assert.ok(
    prompt.includes("Transcript markdown supports fenced mermaid blocks"),
    "the tool route prompt advertises inline Mermaid rendering",
  );
  assert.ok(
    prompt.includes(
      "flows, sequences, state machines, dependencies, or architecture relationships",
    ),
    "the prompt names the diagram cases Mermaid should cover",
  );
});

test("buildSystemPrompt advertises Mermaid fenced blocks on no-tool routes", () => {
  const prompt = buildSystemPrompt([], { workspaceRoot: "/ws", cwd: "/ws" });

  assert.ok(
    prompt.includes("Transcript markdown supports fenced mermaid blocks"),
    "the answer-only route prompt still advertises transcript Mermaid rendering",
  );
});

test("Mermaid guidance separates inline diagrams from Lucid without advertising a callable Lucid tool", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });

  assert.ok(
    prompt.includes("Mermaid is for inline response explanation"),
    "the prompt defines Mermaid as inline transcript explanation",
  );
  assert.ok(
    prompt.includes("Lucid/artifacts are reviewable external iteration surfaces when available"),
    "the prompt names the Lucid boundary without making it the inline diagram surface",
  );
  assert.doesNotMatch(prompt, /call (the )?Lucid/i);
});

// --- Plan 04 M7: web_search (discovery) vs web_fetch (reading) guidance ---

test("buildSystemPrompt distinguishes web_search for discovery from web_fetch for reading", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("Use web_search for DISCOVERY"),
    "the prompt frames web_search as discovery",
  );
  assert.ok(
    prompt.includes("web_fetch to READ a source you already have a URL for"),
    "the prompt frames web_fetch as reading a selected source URL",
  );
});

test("buildSystemPrompt describes the static -> Jina -> Firecrawl ladder with Firecrawl as a scarce final fallback", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("static first"),
    "the prompt explains the ladder starts with the static backend",
  );
  assert.ok(
    prompt.includes("Jina reader only when the static page is unusable"),
    "the prompt explains Jina is the unusable-static fallback",
  );
  assert.ok(
    prompt.includes("Firecrawl is a scarce final fallback"),
    "the prompt marks Firecrawl as a scarce final fallback",
  );
});

// --- Plan 05 M7: docs (external documentation) vs workspace-truth guidance (D-008) ---

test("buildSystemPrompt tells the model to use docs for current external documentation", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("Use docs for CURRENT EXTERNAL documentation"),
    "the prompt frames docs as the external-documentation lookup",
  );
  assert.ok(
    prompt.includes("product, API, library, SDK, or service"),
    "the prompt enumerates the external documentation subjects docs covers",
  );
});

test("buildSystemPrompt tells the model NOT to use docs for active workspace source truth", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("Do NOT use docs for the active workspace's own source truth"),
    "the prompt forbids docs for the workspace's own code truth",
  );
  assert.ok(
    prompt.includes("docs is for external documentation"),
    "the prompt restates that docs is external-only",
  );
});

test("a local-repo question is routed to files/search/tests, not docs (workspace-truth boundary)", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  // The workspace-truth boundary names the local tools as the route for THIS repo's facts...
  assert.ok(
    prompt.includes("read, glob, grep, ast_grep, the tests, and the compiler"),
    "the prompt routes local-repo truth to the local file/search/test/compiler tools",
  );
  // ...and explicitly forbids substituting docs for reading the repo under work.
  assert.ok(
    prompt.includes("never a substitute for reading the repo you are working in"),
    "the prompt forbids docs as a stand-in for reading the active repository",
  );
});

// --- Plan 23 M7: MCP guidance is generic, bounded, and prefers built-in tools (D-001/D-003) ---

test("buildSystemPrompt frames mcp as the configured-external-integrations tool, preferring built-ins", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  // It names MCP generically as the route to the user's configured external integrations...
  assert.ok(
    prompt.includes("The mcp tool talks to the user's configured MCP servers"),
    "the prompt describes mcp as the configured MCP-server surface",
  );
  // ...and pins the preference order: built-in Trevor tools first, MCP only when they don't fit.
  assert.ok(
    prompt.includes("prefer Trevor's built-in tools when they fit"),
    "the prompt prefers built-in tools over MCP",
  );
});

test("MCP guidance uses qualified identity and capped discovery, never a catalog dump (D-003/D-005)", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("'<server>:<tool>'"),
    "the guidance addresses capabilities by their qualified identity",
  );
  assert.ok(
    prompt.includes("never expect or dump a full server catalog"),
    "the guidance forbids full-catalog dumps",
  );
});

test("generic MCP guidance never names tool_proxy (D-001)", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.doesNotMatch(prompt, /tool[-_ ]proxy/i, "tool-proxy must not appear in generic guidance");
});

// --- Plan 24 M3: LSP is pull-only - the prompt never carries an ambient diagnostics feed (D-003) ---

test("D-003: LSP appears in the prompt ONLY as the advertised tool inventory lines", () => {
  contextRegistry.reset();
  const lspTools = [
    ...TOOLS,
    { name: "lsp_status", description: "Report language server health.", parameters: {} },
    { name: "lsp_diagnostics", description: "Pull diagnostics for a file.", parameters: {} },
  ];
  const prompt = buildSystemPrompt(lspTools, { workspaceRoot: "/ws", cwd: "/ws" });
  // Every line that mentions LSP or plural "diagnostics" must be an inventory line derived from
  // the tool defs themselves - never an injected diagnostics block or ambient feed. (The doctor
  // guidance says "self-diagnostic", singular, so the \bdiagnostics\b probe skips it.)
  const mentions = prompt.split("\n").filter((line) => /lsp|\bdiagnostics\b/i.test(line));
  assert.deepEqual(mentions, [
    "- lsp_status: Report language server health.",
    "- lsp_diagnostics: Pull diagnostics for a file.",
  ]);
});

test("plan 24 M4: literal text search guidance still prefers grep/ast_grep over LSP symbols", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  // The grep guidance line survives untouched (M6 owns LSP guidance; M4 must not undermine it)...
  assert.ok(
    prompt.includes(
      "Use grep (ripgrep-backed text/regex search) for exact strings, symbols, error text, or regular expressions",
    ),
    "grep stays the literal/text search channel",
  );
  // ...and nothing tells the model to swap grep/rg/ast_grep for symbol lookups.
  assert.doesNotMatch(
    prompt,
    /symbols? (instead of|rather than|over) (grep|rg|ast_grep)/i,
    "no guidance replaces grep with LSP symbols",
  );
});

test("D-003: prompt content is a pure function of its inputs - no diagnostics side channel", () => {
  contextRegistry.reset();
  // Two builds with identical inputs are byte-identical: nothing (an LSP manager, a diagnostics
  // store) can inject content between calls. Diagnostics reach the model only as tool RESULTS
  // (see agent/history-projection.test.ts), never through prompt construction.
  const first = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  const second = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.equal(first, second);
});

// --- Phase 7 M2: nested AGENTS.md context injected into the per-turn prompt (D-080) ---

test("buildSystemPrompt injects the AGENTS.md context block when a file exists", () => {
  contextRegistry.reset();
  const root = mkdtempSync(join(tmpdir(), "sysprompt-ctx-"));
  writeFileSync(join(root, "AGENTS.md"), "TEAM RULE: always run pnpm lint.", "utf8");
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: root, cwd: root });
  assert.match(prompt, /Project context \(AGENTS\.md\)/, "the labeled context block appears");
  assert.match(prompt, /TEAM RULE: always run pnpm lint\./, "the file content is injected");
  // It is rendered BEFORE the guardrails, so the "block above" reference holds.
  assert.ok(
    prompt.indexOf("TEAM RULE") < prompt.indexOf("project-context block above"),
    "the context block precedes the guardrail that references it",
  );
});

test("buildSystemPrompt omits the context block when no AGENTS.md exists (prompt unchanged)", () => {
  contextRegistry.reset();
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(!prompt.includes("Project context (AGENTS.md)"), "no context block without files");
});

test("the reworded guardrail points the model at the already-provided context block", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.match(prompt, /already provided in the project-context block above/);
  assert.ok(
    !prompt.includes("begin from existing top-level files like README.md or AGENTS.md"),
    "the old wording (telling the model to re-read AGENTS.md) is gone",
  );
});

// --- M22: SystemPromptBuilder owns the prompt's registry reads (D-029) ---

test("the builder's build() equals the buildSystemPrompt free function (parity)", () => {
  contextRegistry.reset();
  const opts = { workspaceRoot: "/ws", cwd: "/ws" };

  // The free function delegates to the module singleton, so they must produce the same prompt.
  assert.equal(systemPromptBuilder.build(TOOLS, opts), buildSystemPrompt(TOOLS, opts));

  // ...with and without tools, to cover both assembly branches.
  assert.equal(systemPromptBuilder.build([], opts), buildSystemPrompt([], opts));
});

test("a fresh SystemPromptBuilder defaults to the module registries (same prompt)", () => {
  contextRegistry.reset();
  const opts = { workspaceRoot: "/ws", cwd: "/ws" };

  // Constructed without args, the builder wires the module-singleton registries, so a new
  // instance assembles the byte-identical prompt the shared singleton does.
  assert.equal(new SystemPromptBuilder().build(TOOLS, opts), buildSystemPrompt(TOOLS, opts));
});

/**
 * Output-style guidance (plan 03, M6): a selected style threads ONLY a presentation-only response-shape
 * block into the prompt - it never changes the tool inventory, identity, execution context, or any other
 * behavior. These pin that invariant.
 */

test("style guidance is threaded into the prompt as a presentation-only block (03 M6)", () => {
  const prompt = buildSystemPrompt(TOOLS, { styleGuidance: "Lead with the result." });
  assert.match(prompt, /Response style \(presentation only/);
  assert.match(prompt, /Lead with the result\./);
});

test("the default style (no guidance) adds no style block and equals the no-style prompt", () => {
  const prompt = buildSystemPrompt(TOOLS, { styleGuidance: "" });
  assert.ok(!prompt.includes("Response style"));
  assert.equal(prompt, buildSystemPrompt(TOOLS));
});

test("style affects ONLY its block - tools, identity, and execution are unchanged across styles (03 M6)", () => {
  const a = buildSystemPrompt(TOOLS, { styleGuidance: "Be concise." });
  const b = buildSystemPrompt(TOOLS, { styleGuidance: "Teach as you go." });
  const stripStyle = (s: string): string =>
    s.replace(/Response style \(presentation only[^\n]*/g, "");
  assert.equal(stripStyle(a), stripStyle(b), "everything but the style sentence is identical");
  // The advertised tool inventory is present and unchanged regardless of the active style.
  assert.match(a, /- edit: Edit a file\./);
  assert.match(b, /- edit: Edit a file\./);
});

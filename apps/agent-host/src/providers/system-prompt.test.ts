import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceConfined, WORKSPACE_CONFINED_TOOLS } from "@host/boot/paths";
import { contextRegistry } from "@host/project-context/registry";
import { test } from "vitest";
import {
  buildSystemPrompt,
  guidanceTier,
  promptOverheadChars,
  SystemPromptBuilder,
  systemPromptBuilder,
} from "./system-prompt";

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
  // It explains what doctor is (Belay's own host self-diagnostic)...
  assert.ok(
    prompt.includes("The doctor tool runs Belay's own host self-diagnostic"),
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
  // ...and pins the preference order: built-in Belay tools first, MCP only when they don't fit.
  assert.ok(
    prompt.includes("prefer Belay's built-in tools when they fit"),
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

test("D-003: LSP appears in the prompt ONLY as inventory lines and the fixed M6 guidance copy", () => {
  contextRegistry.reset();
  const lspTools = [
    ...TOOLS,
    { name: "lsp_status", description: "Report language server health.", parameters: {} },
    { name: "lsp_diagnostics", description: "Pull diagnostics for a file.", parameters: {} },
  ];
  const prompt = buildSystemPrompt(lspTools, { workspaceRoot: "/ws", cwd: "/ws" });
  // Every line that mentions LSP or plural "diagnostics" must be either an inventory line derived
  // from the tool defs themselves or the STATIC M6 selective-use guidance copy - never an injected
  // diagnostics block or ambient feed. (The doctor guidance says "self-diagnostic", singular, so
  // the \bdiagnostics\b probe skips it.) The two guidance sentences are pinned by prefix here; the
  // purity test below proves nothing dynamic can ride along between builds.
  const mentions = prompt.split("\n").filter((line) => /lsp|\bdiagnostics\b/i.test(line));
  assert.equal(mentions.length, 4, mentions.join("\n"));
  assert.equal(mentions[0], "- lsp_status: Report language server health.");
  assert.equal(mentions[1], "- lsp_diagnostics: Pull diagnostics for a file.");
  assert.match(mentions[2] ?? "", /^Use the lsp_\* tools for precise language-server facts/);
  assert.match(mentions[3] ?? "", /^Do NOT use lsp_\* tools for literal text or string search/);
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

// --- Plan 24 M6: selective-use LSP guidance (D-002/D-003/D-006) ---

test("24 M6: guidance names the LSP use-cases - symbols, orientation, hover facts, targeted diagnostics, proposals", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("lsp_workspace_symbols to find where a NAMED symbol"),
    "workspace symbols are the named-definition lookup",
  );
  assert.ok(
    prompt.includes("lsp_document_symbols to orient in a large file"),
    "document symbols are the large-file orientation move",
  );
  assert.ok(
    prompt.includes("lsp_hover for the type signature or docs at an exact file:line:column"),
    "hover is the positional type/signature/doc fact",
  );
  assert.ok(
    prompt.includes("lsp_diagnostics for a targeted post-edit check"),
    "diagnostics are the targeted post-edit check",
  );
  assert.ok(
    prompt.includes("lsp_code_actions to propose safe fixes"),
    "code actions are the safe-fix proposal channel",
  );
});

test("24 M6: guidance names the not-cases and keeps grep/ast_grep/glob/read as the search channels", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("Do NOT use lsp_* tools for literal text or string search"),
    "literal/string search is an explicit not-case",
  );
  assert.ok(
    prompt.includes("config/docs/route discovery, or broad exploration"),
    "config, docs, routes, and broad exploration are explicit not-cases",
  );
  assert.ok(
    prompt.includes("grep, ast_grep, glob, and read stay the right tools there"),
    "the normal search/read tools remain the route for those tasks",
  );
});

test("24 M6: correctness truth stays with tests, typecheck, and compiler output; LSP is auxiliary", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  assert.ok(
    prompt.includes("correctness truth stays with the tests, typecheck, and compiler output"),
    "tests/typecheck/compiler remain the final correctness channels",
  );
  assert.ok(
    prompt.includes("LSP is auxiliary and OPTIONAL"),
    "LSP is framed as auxiliary and optional, never a dependency",
  );
});

test("24 M6: nothing asks the model to wait for LSP before editing (D-003)", () => {
  const prompt = buildSystemPrompt(TOOLS, { workspaceRoot: "/ws", cwd: "/ws" });
  // The one permitted wait+LSP phrasing is the PROHIBITION itself; any other line pairing
  // "wait" with LSP would be a blocking instruction and must not exist.
  for (const line of prompt.split("\n")) {
    if (/wait[^.]*\b(lsp|language.server)/i.test(line)) {
      assert.match(line, /never wait/i, `a wait+LSP line must be the prohibition: ${line}`);
    }
  }
  assert.ok(
    prompt.includes("never wait for LSP before editing"),
    "the non-blocking rule is stated explicitly",
  );
  assert.doesNotMatch(
    prompt,
    /(run|call|check|consult)\s+lsp_\w+\s+(before|prior to)\s+(editing|each edit|any edit|writing)/i,
    "no guidance gates an edit on an LSP call",
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

/**
 * Route-aware guidance density (plan 50). The served context window drives a guidance TIER: a large
 * or absent window renders the full prompt (byte-identical to before this plan); a smaller local
 * window emits a leaner prompt so the fixed overhead does not blow the budget or trigger silent
 * truncation. Only the tool guidance narrows - identity, execution context, coding conduct,
 * confinement, and calibration hold across all tiers.
 */

const CAPS = { images: false, tools: true, contextLength: 200_000 } as const;
const WS = { workspaceRoot: "/ws", cwd: "/ws" } as const;

// --- M2: the guidanceTier policy is pure and served-window-driven (D-004) ---

test("guidanceTier: an absent or non-positive window falls back to full (never narrow on missing data)", () => {
  assert.equal(guidanceTier(undefined), "full");
  assert.equal(guidanceTier(0), "full");
  assert.equal(guidanceTier(-1), "full");
});

test("guidanceTier: thresholds are full >= 64k, core >= 16k, minimal below (boundaries inclusive)", () => {
  assert.equal(guidanceTier(200_000), "full");
  assert.equal(guidanceTier(64_000), "full");
  assert.equal(guidanceTier(63_999), "core");
  assert.equal(guidanceTier(32_000), "core");
  assert.equal(guidanceTier(16_000), "core");
  assert.equal(guidanceTier(15_999), "minimal");
  assert.equal(guidanceTier(8_000), "minimal");
});

// --- M1: threading the route data is a transparent seam - a large/absent window is byte-identical ---

test("M1: a large or absent contextWindow (with capabilities) is byte-identical to the pre-plan-50 prompt", () => {
  const base = buildSystemPrompt(TOOLS, WS);
  assert.equal(
    buildSystemPrompt(TOOLS, { ...WS, contextWindow: 200_000, capabilities: CAPS }),
    base,
    "a large window renders the full prompt unchanged",
  );
  assert.equal(
    buildSystemPrompt(TOOLS, { ...WS, contextWindow: undefined, capabilities: CAPS }),
    base,
    "an absent window renders the full prompt unchanged",
  );
});

// --- M2: the minimal tier drops the detailed tool blocks but keeps the safety-critical core ---

test("M2: a small window (< 16k) omits the detailed LSP/MCP/docs/archive/tool_script blocks", () => {
  const minimal = buildSystemPrompt(TOOLS, { ...WS, contextWindow: 8_000 });
  for (const dropped of [
    "Use the lsp_* tools for precise language-server facts",
    "The mcp tool talks to the user's configured MCP servers",
    "Use docs for CURRENT EXTERNAL documentation",
    "Use archive_read with path for local zip inspection",
    "The tool_script tool runs a short READ-ONLY TypeScript script",
    "Use ast_grep for STRUCTURAL",
    "The doctor tool runs Belay's own host self-diagnostic",
    "do NOT invent hidden loops",
  ]) {
    assert.ok(!minimal.includes(dropped), `minimal tier omits: ${dropped}`);
  }
});

test("M2: the minimal tier still keeps identity, execution context, core coding guidance, and confinement", () => {
  const minimal = buildSystemPrompt(TOOLS, { ...WS, contextWindow: 8_000 });
  assert.ok(minimal.includes("You are Belay"), "identity is retained");
  assert.ok(minimal.includes("Workspace root: /ws"), "execution context is retained");
  assert.ok(
    minimal.includes("Use glob to discover files by name or path, and grep to find exact strings"),
    "core coding guidance is retained",
  );
  assert.ok(
    minimal.includes("edit, glob, and grep are scoped to the workspace root"),
    "the confinement contract is retained at every tier",
  );
  assert.ok(
    minimal.includes("Use grep (ripgrep-backed text/regex search)"),
    "the core search guidance is retained",
  );
  assert.ok(minimal.includes("Resist sycophancy"), "the calibration rules are retained");
});

// --- M2: the core (medium) tier condenses the high-value blocks and drops the niche ones ---

test("M2: the core tier keeps a CONDENSED form of the high-value blocks (retained, not verbatim)", () => {
  const core = buildSystemPrompt(TOOLS, { ...WS, contextWindow: 32_000 });
  // A representative phrase from each retained block's CONDENSED form is present...
  assert.ok(core.includes("symbol definitions, large-file orientation"), "lsp condensed present");
  assert.ok(core.includes("Use the mcp tool's search action to DISCOVER"), "mcp condensed present");
  assert.ok(
    core.includes("a cached, citeable corpus you search and read; not for this repo's own source"),
    "docs condensed present",
  );
  assert.ok(
    core.includes("Use tool_script to batch many READ-ONLY"),
    "tool_script condensed present",
  );
  assert.ok(core.includes("Use ast_grep for STRUCTURAL"), "ast_grep condensed present");
  // ...while the VERBATIM long form of each is gone.
  assert.ok(
    !core.includes("lsp_workspace_symbols to find where a NAMED symbol"),
    "the verbatim LSP block is dropped at core",
  );
  assert.ok(
    !core.includes("The mcp tool talks to the user's configured MCP servers"),
    "the verbatim MCP block is dropped at core",
  );
  assert.ok(
    !core.includes("resolves a subject into a cached, citeable corpus you then search and read"),
    "the verbatim docs block is dropped at core",
  );
});

test("M2: the core tier DROPS the niche low-value blocks entirely", () => {
  const core = buildSystemPrompt(TOOLS, { ...WS, contextWindow: 32_000 });
  for (const dropped of [
    "The doctor tool runs Belay's own host self-diagnostic",
    "The belay_expert tool answers questions",
    "Use archive_unpack only when the user asks",
    "Firecrawl is a scarce final fallback",
    "never wait for LSP before editing",
    "do NOT invent hidden loops",
  ]) {
    assert.ok(!core.includes(dropped), `core tier drops the niche block: ${dropped}`);
  }
  // The core coding + confinement guidance still holds at the medium tier.
  assert.ok(core.includes("edit, glob, and grep are scoped to the workspace root"));
  assert.ok(core.includes("edit requires its 'old' text to appear exactly once"));
});

test("M2: an unknown window never silently narrows - it renders the full prompt", () => {
  const unknown = buildSystemPrompt(TOOLS, { ...WS, contextWindow: undefined });
  assert.ok(
    unknown.includes("The mcp tool talks to the user's configured MCP servers"),
    "the full MCP block is present when the window is unknown",
  );
});

// --- M3: promptOverheadChars reflects the tier the model actually receives ---

test("M3: promptOverheadChars shrinks as the served window shrinks (overhead tracks the tier)", () => {
  const overhead = (window: number): number =>
    promptOverheadChars(buildSystemPrompt(TOOLS, { ...WS, contextWindow: window }), TOOLS);
  const full = overhead(200_000);
  const core = overhead(32_000);
  const minimal = overhead(8_000);
  assert.ok(core < full, "the core-tier overhead is below the full-tier overhead");
  assert.ok(minimal < core, "the minimal-tier overhead is below the core-tier overhead");
});

// --- M4 (D-004): the SERVED window wins over the model's native contextLength ---

test("M4: a large native contextLength but a small served window still gets the small tier", () => {
  const prompt = buildSystemPrompt(TOOLS, {
    ...WS,
    contextWindow: 8_000,
    capabilities: { images: false, tools: true, contextLength: 200_000 },
  });
  assert.ok(
    !prompt.includes("The mcp tool talks to the user's configured MCP servers"),
    "the served window (8k) drives the tier, not the 200k native contextLength",
  );
  assert.ok(prompt.includes("You are Belay"), "the minimal prompt is still well-formed");
});

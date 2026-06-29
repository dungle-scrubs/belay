import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { contextRegistry } from "../context/registry";
import { isWorkspaceConfined, WORKSPACE_CONFINED_TOOLS } from "../paths";
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

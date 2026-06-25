import assert from "node:assert/strict";
import { test } from "vitest";
import { isWorkspaceConfined, WORKSPACE_CONFINED_TOOLS } from "../tools/workspace";
import { buildSystemPrompt } from "./system-prompt";

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

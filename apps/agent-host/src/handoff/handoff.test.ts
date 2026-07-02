import assert from "node:assert/strict";
import { test } from "vitest";
import { parseHandoff } from "./handoff";

/**
 * The /handoff argument parser (M1): mode selection (default generate, --generate, --direct), the
 * prompt remainder, empty prompts, and quoted arguments. Pure - no host orchestration.
 */

test("/handoff with no args is generate mode with no request", () => {
  assert.deepEqual(parseHandoff(""), { mode: "generate", prompt: "" });
  assert.deepEqual(parseHandoff("   "), { mode: "generate", prompt: "" });
});

test("/handoff <text> defaults to generate with the text as the request", () => {
  assert.deepEqual(parseHandoff("refactor the auth layer"), {
    mode: "generate",
    prompt: "refactor the auth layer",
  });
});

test("--generate is the explicit generate form, carrying the request", () => {
  assert.deepEqual(parseHandoff("--generate"), { mode: "generate", prompt: "" });
  assert.deepEqual(parseHandoff("--generate write the migration plan"), {
    mode: "generate",
    prompt: "write the migration plan",
  });
});

test("--direct sends the supplied text as the target prompt", () => {
  assert.deepEqual(parseHandoff("--direct do the thing"), {
    mode: "direct",
    prompt: "do the thing",
  });
});

test("--direct with no prompt parses to an empty direct prompt (M2 rejects it)", () => {
  assert.deepEqual(parseHandoff("--direct"), { mode: "direct", prompt: "" });
  assert.deepEqual(parseHandoff("--direct    "), { mode: "direct", prompt: "" });
});

test("a surrounding pair of matching quotes is stripped from the prompt", () => {
  assert.equal(parseHandoff('--direct "do the thing"').prompt, "do the thing");
  assert.equal(parseHandoff("--direct 'do the thing'").prompt, "do the thing");
  assert.equal(parseHandoff('--generate "summarize this"').prompt, "summarize this");
  // Mismatched / unbalanced quotes are left as-is (not stripped).
  assert.equal(parseHandoff('--direct "half quoted').prompt, '"half quoted');
});

test("the flag must be a leading token, not matched mid-prompt", () => {
  assert.deepEqual(parseHandoff("explain the --direct flag"), {
    mode: "generate",
    prompt: "explain the --direct flag",
  });
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyResponseOverflow,
  isAuthError,
  isContextLengthError,
  promptTooBig,
} from "./error-classifier";

/**
 * Characterization tests for the provider error/overflow classifier (M4 / D-007). These pin the
 * exact decisions pi-ai.ts used to inline: which error texts are refused credentials, which are LM
 * Studio's context-length rejection, the one prompt-too-big wording, and when a finished response
 * counts as overflow - so the classification can move out of the adapter without changing behavior.
 */

test("isAuthError matches refused-credential signals, not generic outages", () => {
  for (const detail of [
    "HTTP 401 Unauthorized",
    "403 Forbidden",
    "invalid api key",
    "authentication failed",
    "your token has expired",
    "x-api-key invalid",
  ]) {
    assert.ok(isAuthError(detail), `should classify as auth: ${detail}`);
  }
  for (const detail of ["connection refused", "ECONNRESET", "503 service unavailable", "timeout"]) {
    assert.ok(!isAuthError(detail), `should NOT classify as auth: ${detail}`);
  }
});

test("isContextLengthError matches LM Studio's context-length rejection variants", () => {
  for (const detail of [
    "the context length is exceeded",
    "not enough tokens to keep",
    "model requires a larger context",
    "exceeds the context window",
  ]) {
    assert.ok(isContextLengthError(detail), `should be context-length: ${detail}`);
  }
  assert.ok(!isContextLengthError("invalid api key"), "auth errors are not context-length");
});

test("promptTooBig formats the one too-big message with the estimate and window", () => {
  assert.equal(
    promptTooBig(9000, 8192),
    "the prompt (~9000 tokens) is too big for the 8192-token context window",
  );
});

test("classifyResponseOverflow flags a window-filling length stop as mid-response overflow", () => {
  const reason = classifyResponseOverflow(
    { stopReason: "length", usage: { input: 7000, output: 1200 } } as never,
    8000,
  );
  assert.equal(reason, "hit the context window mid-response — output was truncated");
});

test("classifyResponseOverflow does NOT flag a long answer that didn't fill the window", () => {
  // A "length" stop where input+output is well under the window is a max-output cap, not overflow.
  const reason = classifyResponseOverflow(
    { stopReason: "length", usage: { input: 1000, output: 500 } } as never,
    100000,
  );
  assert.equal(reason, null);
});

test("classifyResponseOverflow returns null for a normal stop and for a missing message", () => {
  assert.equal(
    classifyResponseOverflow(
      { stopReason: "stop", usage: { input: 10, output: 5 } } as never,
      8000,
    ),
    null,
  );
  assert.equal(classifyResponseOverflow(undefined, 8000), null);
});

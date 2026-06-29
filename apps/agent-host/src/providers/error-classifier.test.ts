import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyResponseOverflow,
  isAuthFailure,
  isContextOverflow,
  isRetryable,
  parseOverflowWindow,
  promptTooBig,
} from "./error-classifier";

/**
 * Characterization tests for the provider error/overflow classifier (M4 / D-007). These pin the
 * exact decisions pi-ai.ts used to inline: which error texts are refused credentials, which are LM
 * Studio's context-length rejection, the one prompt-too-big wording, and when a finished response
 * counts as overflow - so the classification can move out of the adapter without changing behavior.
 */

test("isAuthFailure matches refused-credential signals, not generic outages", () => {
  for (const detail of [
    "HTTP 401 Unauthorized",
    "403 Forbidden",
    "invalid api key",
    "authentication failed",
    "your token has expired",
    "x-api-key invalid",
  ]) {
    assert.ok(isAuthFailure(detail), `should classify as auth: ${detail}`);
  }
  for (const detail of ["connection refused", "ECONNRESET", "503 service unavailable", "timeout"]) {
    assert.ok(!isAuthFailure(detail), `should NOT classify as auth: ${detail}`);
  }
});

test("isContextOverflow matches LM Studio's context-length rejection variants", () => {
  for (const detail of [
    "the context length is exceeded",
    "not enough tokens to keep",
    "model requires a larger context",
    "exceeds the context window",
  ]) {
    assert.ok(isContextOverflow(detail), `should be context-length: ${detail}`);
  }
  assert.ok(!isContextOverflow("invalid api key"), "auth errors are not context-length");
});

test("isRetryable derives retry eligibility from the normalized failure class", () => {
  assert.equal(isRetryable("transient_transport"), true);
  assert.equal(isRetryable("rate_limited"), true);
  assert.equal(isRetryable("provider_overloaded"), true);
  assert.equal(isRetryable("provider_unavailable"), true);
  assert.equal(isRetryable("auth"), false);
  assert.equal(isRetryable("context_overflow"), false);
  assert.equal(isRetryable("unknown"), false);
});

test("promptTooBig formats the one too-big message with the estimate and window", () => {
  assert.equal(
    promptTooBig(9000, 8192),
    "the prompt (~9000 tokens) is too big for the 8192-token context window",
  );
});

/**
 * 03.2 M3: the inverse of `promptTooBig` - read the real context window `N` back out of an overflow
 * message so a stale bundled window can self-heal from the provider's own rejection. It reads both our
 * own wording and a provider's native max-context phrasing, and never mistakes the prompt size for the
 * window.
 */

test("parseOverflowWindow reads the window from the promptTooBig wording, not the prompt size", () => {
  assert.equal(parseOverflowWindow(promptTooBig(412369, 262144)), 262144);
});

test("parseOverflowWindow reads a provider's native max-context phrasing", () => {
  assert.equal(
    parseOverflowWindow(
      "This model's maximum context length is 262144 tokens. However, your messages resulted in 412369 tokens.",
    ),
    262144,
  );
  assert.equal(parseOverflowWindow("context window of 200,000 tokens exceeded"), 200000);
});

test("parseOverflowWindow returns null when no window number is present", () => {
  assert.equal(parseOverflowWindow("invalid api key"), null);
  assert.equal(parseOverflowWindow("please reduce the length of the messages"), null);
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

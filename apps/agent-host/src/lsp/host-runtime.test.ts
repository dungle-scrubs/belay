import assert from "node:assert/strict";
import { test } from "vitest";
import { lspManagerEnvOptions } from "./host-runtime";

/**
 * The host-wide LSP manager singleton's env knobs (plan 24 M7, D-006): the singleton is built at
 * import with no config seam, so its request/init timeouts and stale threshold were fixed at
 * compile time. `lspManagerEnvOptions` is the pure env -> options mapping (the host reads pure
 * env, never a config folder): a slow language server can be tuned per machine, and the hermetic
 * distraction-regression turns can bound their wall time. Absent or malformed values contribute
 * nothing, so the manager's own defaults keep applying.
 */

test("an empty env contributes no overrides (the manager defaults apply)", () => {
  assert.deepEqual(lspManagerEnvOptions({}), {});
});

test("each TREVOR_LSP_* knob maps to its manager option", () => {
  assert.deepEqual(lspManagerEnvOptions({ TREVOR_LSP_REQUEST_TIMEOUT_MS: "800" }), {
    requestTimeoutMs: 800,
  });
  assert.deepEqual(lspManagerEnvOptions({ TREVOR_LSP_INIT_TIMEOUT_MS: "1500" }), {
    initTimeoutMs: 1500,
  });
  assert.deepEqual(lspManagerEnvOptions({ TREVOR_LSP_STALE_AFTER_MS: "1" }), {
    staleAfterMs: 1,
  });
  assert.deepEqual(
    lspManagerEnvOptions({
      TREVOR_LSP_REQUEST_TIMEOUT_MS: "800",
      TREVOR_LSP_INIT_TIMEOUT_MS: "1500",
      TREVOR_LSP_STALE_AFTER_MS: "60000",
    }),
    { requestTimeoutMs: 800, initTimeoutMs: 1500, staleAfterMs: 60000 },
  );
});

test("malformed, zero, or negative values are ignored, never a crash or a zero timeout", () => {
  for (const bad of ["", "abc", "0", "-5", "NaN", "1.5e999"]) {
    assert.deepEqual(
      lspManagerEnvOptions({
        TREVOR_LSP_REQUEST_TIMEOUT_MS: bad,
        TREVOR_LSP_INIT_TIMEOUT_MS: bad,
        TREVOR_LSP_STALE_AFTER_MS: bad,
      }),
      {},
      `"${bad}" must be ignored`,
    );
  }
});

test("fractional values truncate to whole milliseconds", () => {
  assert.deepEqual(lspManagerEnvOptions({ TREVOR_LSP_REQUEST_TIMEOUT_MS: "800.9" }), {
    requestTimeoutMs: 800,
  });
});

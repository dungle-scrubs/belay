import assert from "node:assert/strict";
import { test } from "vitest";
import { ensureSessionWithRetry } from "./startup";

/**
 * Regression guard for the host startup race: under `pnpm dev` the host's first
 * `ensureSession` can hit the session-store before it is listening ("fetch failed"). The
 * host must RETRY through that, not exit on the first failure. `sleep` is injected so the
 * retries are instant.
 */

const noSleep = async () => {};

test("retries a not-yet-ready store, then resolves once ensureSession succeeds", async () => {
  let calls = 0;
  await ensureSessionWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed"); // store not listening yet
    },
    { delayMs: 0, sleep: noSleep },
  );
  assert.equal(calls, 3);
});

test("calls onRetry for each failed attempt, never for the success", async () => {
  const retried: number[] = [];
  let calls = 0;
  await ensureSessionWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
    },
    { delayMs: 0, sleep: noSleep, onRetry: (attempt) => retried.push(attempt) },
  );
  assert.deepEqual(retried, [1, 2]);
});

test("gives up and rethrows after `attempts`, so a truly-down store fails loud (not a hang)", async () => {
  let calls = 0;
  await assert.rejects(
    ensureSessionWithRetry(
      async () => {
        calls += 1;
        throw new Error("always down");
      },
      { attempts: 4, delayMs: 0, sleep: noSleep },
    ),
    /always down/,
  );
  assert.equal(calls, 4); // exactly `attempts` tries, then throws
});

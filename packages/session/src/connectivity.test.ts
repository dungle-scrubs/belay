import assert from "node:assert/strict";
import { test } from "vitest";
import {
  coerceInternetSnapshot,
  type InternetSnapshot,
  isSnapshotStale,
  UNKNOWN_INTERNET,
} from "./connectivity";

/**
 * D-060: the shared internet-snapshot wire helpers - staleness and the forward-compatible decode
 * the web uses to read the snapshot off `host.online` / `host.internet`.
 */

const ONLINE: InternetSnapshot = {
  status: "online",
  checking: false,
  checkedAt: "2026-06-26T12:00:00.000Z",
  error: null,
  targetClass: "dns+https",
};

test("isSnapshotStale: a never-probed snapshot is always stale", () => {
  assert.equal(isSnapshotStale(UNKNOWN_INTERNET, 1_000_000, 30_000), true);
});

test("isSnapshotStale: fresh within the window, stale past it", () => {
  const at = Date.parse(ONLINE.checkedAt as string);
  assert.equal(isSnapshotStale(ONLINE, at + 10_000, 30_000), false, "10s < 30s window: fresh");
  assert.equal(isSnapshotStale(ONLINE, at + 40_000, 30_000), true, "40s > 30s window: stale");
});

test("coerceInternetSnapshot defaults junk to unknown but keeps a valid snapshot", () => {
  assert.deepEqual(coerceInternetSnapshot(null), UNKNOWN_INTERNET);
  assert.deepEqual(coerceInternetSnapshot({ status: "banana" }).status, "unknown");
  assert.deepEqual(coerceInternetSnapshot(ONLINE), ONLINE);
});

test("coerceInternetSnapshot preserves checking + sanitized error fields", () => {
  const decoded = coerceInternetSnapshot({
    status: "offline",
    checking: true,
    checkedAt: "2026-06-26T12:00:00.000Z",
    error: "HTTPS probe failed",
    targetClass: "dns+https",
  });
  assert.equal(decoded.status, "offline");
  assert.equal(decoded.checking, true);
  assert.equal(decoded.error, "HTTPS probe failed");
});

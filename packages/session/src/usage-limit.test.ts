import assert from "node:assert/strict";
import { test } from "vitest";
import {
  LIMIT_STATUSES,
  parseAnthropicUnifiedHeaders,
  parseResetToEpochSeconds,
  unifiedHeaderKeys,
} from "./usage-limit";

/**
 * Plan 44.4 Step 0: the pure Anthropic unified rate-limit header normalizer. Fed faked header records
 * (the shape pi-ai surfaces on the success path via `onResponse`), it maps `-status`
 * allowed/allowed_warning/rejected -> ok/approaching/reached, the 5h/7d window -> scope, `-reset`
 * -> unix-seconds resetsAt, and remaining/limit -> utilization. No network, no clock.
 */

test("maps allowed -> ok with the constraining window scope", () => {
  const limit = parseAnthropicUnifiedHeaders({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-status": "allowed",
  });
  assert.deepEqual(limit, { status: "ok", scope: "five_hour" });
});

test("maps allowed_warning -> approaching (the transition this plan cares about)", () => {
  const limit = parseAnthropicUnifiedHeaders({
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-5h-status": "allowed_warning",
  });
  assert.equal(limit?.status, "approaching");
  assert.equal(limit?.scope, "five_hour");
});

test("maps rejected -> reached and reads an RFC3339 reset into unix SECONDS", () => {
  const limit = parseAnthropicUnifiedHeaders({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": "2026-07-05T00:00:00Z",
  });
  assert.equal(limit?.status, "reached");
  assert.equal(limit?.scope, "seven_day");
  assert.equal(limit?.resetsAt, Date.parse("2026-07-05T00:00:00Z") / 1000);
});

test("picks the MOST-CONSTRAINING window when several are present", () => {
  const limit = parseAnthropicUnifiedHeaders({
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-status": "allowed_warning",
    "anthropic-ratelimit-unified-7d-opus-status": "allowed",
  });
  // 7d is the warning window, so it - not the allowed 5h/opus windows - owns the scope.
  assert.equal(limit?.scope, "seven_day");
});

test("derives utilization from a window's remaining/limit pair", () => {
  const limit = parseAnthropicUnifiedHeaders({
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-5h-status": "allowed_warning",
    "anthropic-ratelimit-unified-5h-remaining": "10",
    "anthropic-ratelimit-unified-5h-limit": "100",
  });
  assert.equal(limit?.utilization, 0.9);
});

test("is case-insensitive over header keys and reads epoch-seconds resets too", () => {
  const limit = parseAnthropicUnifiedHeaders({
    "Anthropic-RateLimit-Unified-Status": "rejected",
    "Anthropic-RateLimit-Unified-Reset": "1780000000",
  });
  assert.equal(limit?.status, "reached");
  // No per-window header -> a generic scope, top-level reset used.
  assert.equal(limit?.scope, "unified");
  assert.equal(limit?.resetsAt, 1_780_000_000);
});

test("returns null when the unified status header is absent (not the Claude path)", () => {
  assert.equal(parseAnthropicUnifiedHeaders({ "x-request-id": "req_1" }), null);
  assert.equal(parseAnthropicUnifiedHeaders({}), null);
});

test("unifiedHeaderKeys lists the inspected unified keys for the detect-only gap log", () => {
  const keys = unifiedHeaderKeys({
    "anthropic-ratelimit-unified-status": "allowed",
    "content-type": "application/json",
    "Anthropic-RateLimit-Unified-Reset": "1780000000",
  });
  assert.deepEqual(keys.sort(), [
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-unified-status",
  ]);
});

test("parseResetToEpochSeconds handles integer seconds, RFC3339, and HTTP-date forms", () => {
  assert.equal(parseResetToEpochSeconds("1780000000"), 1_780_000_000);
  assert.equal(
    parseResetToEpochSeconds("2026-07-05T00:00:00Z"),
    Date.parse("2026-07-05T00:00:00Z") / 1000,
  );
  // HTTP-date form (the deliberate gap in failure-evidence's retry-after) parses here.
  assert.equal(
    parseResetToEpochSeconds("Wed, 05 Jul 2026 00:00:00 GMT"),
    Date.parse("Wed, 05 Jul 2026 00:00:00 GMT") / 1000,
  );
  assert.equal(parseResetToEpochSeconds(undefined), undefined);
  assert.equal(parseResetToEpochSeconds("not-a-date"), undefined);
});

test("LIMIT_STATUSES is the ordered ok -> approaching -> reached vocabulary", () => {
  assert.deepEqual([...LIMIT_STATUSES], ["ok", "approaching", "reached"]);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createProviderTraceWriter } from "./telemetry-provider-trace";

/**
 * Opt-in local provider-attempt tracing (plan 13 M6): disabled by default (no disk touched), and when
 * enabled it appends bounded, redacted JSONL - failure class / attempt / tokens / timing, never the raw
 * prompt, provider body, or a secret.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "belay-ptrace-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tracePath = () => join(dir, "provider-attempts.jsonl");
const readLines = () =>
  readFileSync(tracePath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("a disabled writer is a no-op: it records nothing and creates no file", () => {
  const writer = createProviderTraceWriter({ enabled: false, dir });
  writer.record({
    provider: "lmstudio",
    model: "q",
    attemptId: "a1",
    outcome: "ok",
    attempt: 1,
    durationMs: 5,
  });
  assert.equal(existsSync(tracePath()), false, "no trace file is created when disabled");
  assert.deepEqual(writer.stats(), { written: 0, dropped: 0 });
});

test("an enabled writer appends bounded provider-attempt records with redacted detail", () => {
  const writer = createProviderTraceWriter({ enabled: true, dir, now: () => 1_700_000_000_000 });
  writer.record({
    provider: "lmstudio",
    model: "qwen3.6-27b",
    attemptId: "a1",
    outcome: "error",
    failureClass: "transport_loss",
    retryable: true,
    attempt: 2,
    durationMs: 1234,
    inputTokens: 900,
    outputTokens: 0,
    detail: "socket hung up (key sk-abcdefgh12345678)",
  });

  const [rec] = readLines();
  assert.equal(rec.provider, "lmstudio");
  assert.equal(rec.model, "qwen3.6-27b");
  assert.equal(rec.failureClass, "transport_loss");
  assert.equal(rec.attempt, 2);
  assert.equal(rec.inputTokens, 900);
  assert.equal(rec.at, "2023-11-14T22:13:20.000Z");
  assert.ok(!JSON.stringify(rec).includes("sk-abcdefgh"), "a secret in the detail is redacted");
  assert.equal(writer.stats().written, 1);
});

test("writes past the byte cap are dropped and counted, never thrown", () => {
  const writer = createProviderTraceWriter({ enabled: true, dir, maxBytes: 250 });
  for (let i = 0; i < 20; i++) {
    writer.record({
      provider: "p",
      model: "m",
      attemptId: `a${i}`,
      outcome: "ok",
      attempt: 1,
      durationMs: i,
    });
  }
  const stats = writer.stats();
  assert.ok(stats.written >= 1 && stats.dropped >= 1);
  assert.equal(stats.written + stats.dropped, 20);
});

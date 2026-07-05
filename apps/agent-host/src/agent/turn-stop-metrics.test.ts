import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

const savedStateHome = process.env.XDG_STATE_HOME;
let stateHome: string;

beforeEach(() => {
  vi.resetModules();
  stateHome = mkdtempSync(join(tmpdir(), "trevor-state-"));
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  if (savedStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = savedStateHome;
  }
  rmSync(stateHome, { recursive: true, force: true });
});

test("turn stop debug metrics append under XDG state", async () => {
  const { recordTurnStop, turnStopMetricsPath } = await import("./turn-stop-metrics");

  await recordTurnStop({
    runId: "run-1",
    provider: "deepseek",
    model: "deepseek-v4",
    at: "2026-06-27T00:00:00.000Z",
    stop: {
      cause: "step_backstop",
      action: "paused",
      summary: "Paused at the step backstop.",
    },
  });

  assert.equal(turnStopMetricsPath(), join(stateHome, "trevor", "turn-stops.jsonl"));
  const rows = readFileSync(turnStopMetricsPath(), "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0] ?? "{}"), {
    runId: "run-1",
    provider: "deepseek",
    model: "deepseek-v4",
    at: "2026-06-27T00:00:00.000Z",
    stop: {
      cause: "step_backstop",
      action: "paused",
      summary: "Paused at the step backstop.",
    },
  });
});

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DEFAULT_VIRTUALIZATION_PERFORMANCE_ARTIFACT_ROOT,
  writeVirtualizationPerformanceArtifacts,
} from "../src/perf-artifacts";

test("virtualization performance artifacts default to the local state directory", () => {
  assert.ok(
    DEFAULT_VIRTUALIZATION_PERFORMANCE_ARTIFACT_ROOT.endsWith(
      ".local/state/trevor/virtualization-performance/artifacts",
    ),
  );
});

test("writes local artifacts only when a virtualization performance budget fails", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "trevor-virtualization-artifacts-"));
  const passing = await writeVirtualizationPerformanceArtifacts(
    {
      budgets: {
        bottomDeltaPx: 80,
        keyToPaintP95Ms: 50,
        mountedRows: 80,
        replayToInteractiveMs: 1000,
      },
      metrics: {
        bottomDeltaPx: 0,
        keyToPaintSamplesMs: [12, 18, 22],
        mountedRows: 20,
        replayToInteractiveMs: 420,
        totalRows: 1600,
      },
      sessionId: "passing",
      url: "http://localhost:17420/?session=passing",
    },
    { rootDir },
  );
  assert.equal(passing.status, "passed");

  const failing = await writeVirtualizationPerformanceArtifacts(
    {
      budgets: {
        bottomDeltaPx: 80,
        keyToPaintP95Ms: 50,
        mountedRows: 80,
        replayToInteractiveMs: 1000,
      },
      consoleLines: ["warning: slow commit"],
      metrics: {
        bottomDeltaPx: 0,
        keyToPaintSamplesMs: [20, 40, 75],
        mountedRows: 1600,
        replayToInteractiveMs: 420,
        totalRows: 1600,
      },
      sessionId: "failing",
      trace: { sample: true },
      url: "http://localhost:17420/?session=failing",
    },
    { now: new Date("2026-06-27T00:00:00.000Z"), rootDir },
  );

  assert.equal(failing.status, "written");
  assert.deepEqual(failing.failures, ["mountedRows 1600 > 80", "keyToPaintP95Ms 75 > 50"]);
  const dir = failing.status === "written" ? failing.dir : "";
  const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as {
    failures: string[];
    sessionId: string;
  };
  assert.equal(summary.sessionId, "failing");
  assert.deepEqual(summary.failures, failing.failures);
  assert.match(await readFile(join(dir, "console.log"), "utf8"), /slow commit/u);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "performance-trace.json"), "utf8")), {
    sample: true,
  });
});

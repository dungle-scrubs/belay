import { expect, test } from "@playwright/test";
import {
  type VirtualizationPerformanceBudgets,
  writeVirtualizationPerformanceArtifacts,
} from "@trevor/test-kit/perf-artifacts";
import { appendExchange, seedExchanges, storeTransport } from "./lane-b-fixtures";

/**
 * M4 (plan 09.2): the virtualization perf-metric PRODUCER for the pre-built sink
 * (e2e/virtualization-performance-artifacts.ts). It measures the real browser run and, on a budget
 * breach, writes summary/metrics/console/screenshot artifacts. Perf numbers are machine-variable, so this
 * NEVER gates a PR (D-006): it is skipped unless RUN_PERF=1 (a separate nightly workflow), and even then
 * it asserts only that the producer ran - a breach emits artifacts, it does not fail the run.
 */

const PERF = process.env.RUN_PERF === "1";

// Generous starting budgets - tune from the nightly artifacts (see the nightly workflow). They bound the
// virtualizer's mounted-row cap, append key->paint latency, replay-to-interactive, and pinned scroll drift.
const BUDGETS: VirtualizationPerformanceBudgets = {
  bottomDeltaPx: 8,
  keyToPaintP95Ms: 400,
  mountedRows: 120,
  replayToInteractiveMs: 8000,
};

test.describe("transcript virtualization perf (nightly / artifact-only)", () => {
  test.skip(
    !PERF,
    "perf metrics are nightly + artifact-only and never gate a PR (D-006); set RUN_PERF=1",
  );

  test("produces VirtualizationPerformanceMetrics and writes artifacts on a budget breach", async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));

    const transport = storeTransport();
    const sessionId = `perf-${test.info().workerIndex}-${Date.now()}`;
    await seedExchanges(transport, sessionId, 200); // a large transcript - the virtualizer must cap mounts

    const startedAt = Date.now();
    await page.goto(`/?session=${sessionId}`);
    const list = page.locator("[data-transcript-virtual-list]");
    await expect(list).toHaveAttribute("data-transcript-ready", "true");
    const replayToInteractiveMs = Date.now() - startedAt;

    const totalRows = Number(await list.getAttribute("data-transcript-row-count"));
    const mountedRows = await page.locator("[data-index]").count();

    const scroller = page.locator("[data-transcript-scroll]");
    const keyToPaintSamplesMs: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const at = Date.now();
      await appendExchange(transport, sessionId, `perf-${i}`);
      await expect(scroller).toContainText(`reply perf-${i}`);
      keyToPaintSamplesMs.push(Date.now() - at);
    }

    const bottomDeltaPx = await scroller.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    );

    const result = await writeVirtualizationPerformanceArtifacts(
      {
        budgets: BUDGETS,
        metrics: {
          bottomDeltaPx,
          keyToPaintSamplesMs,
          mountedRows,
          replayToInteractiveMs,
          totalRows,
        },
        sessionId,
        url: page.url(),
        consoleLines,
        screenshotBase64Png: (await page.screenshot()).toString("base64"),
      },
      process.env.TREVOR_PERF_ARTIFACT_DIR ? { rootDir: process.env.TREVOR_PERF_ARTIFACT_DIR } : {},
    );

    // The producer's contract is to MEASURE + emit, not to gate. A breach writes artifacts; the run stays
    // green either way.
    console.log(
      `[perf] status=${result.status} mounted=${mountedRows}/${totalRows} ` +
        `replayMs=${replayToInteractiveMs} bottomDeltaPx=${bottomDeltaPx} failures=${result.failures.join("; ")}`,
    );
    expect(["passed", "written"]).toContain(result.status);
  });
});

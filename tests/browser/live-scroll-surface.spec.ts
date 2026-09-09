import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  announceBrowserJob,
  browserJobSnapshot,
  browserJobTail,
  growRunningAgentChild,
  growTangentSession,
  seedExchanges,
  seedInlineAgentParent,
  seedRunningAgentChild,
  seedTangentSession,
  storeTransport,
} from "./lane-b-fixtures";

const PIN_TOLERANCE_PX = 4;
const ANCHOR_TOLERANCE_PX = 2;
const MONOTONIC_SLACK_PX = 2;

interface LiveScrollProbe {
  readonly bottomDistance: number;
  readonly clientHeight: number;
  readonly pinned: string | null;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

function detailScroller(page: Page): Locator {
  return page.locator("[data-tool-detail-scroll]");
}

function tangentScroller(page: Page): Locator {
  return page.locator("[data-tangent-transcript]");
}

function agentScroller(page: Page): Locator {
  return page.locator("[data-agent-transcript]");
}

function bottomDistance(scroller: Locator): Promise<number> {
  return scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

function liveScrollProbe(scroller: Locator): Promise<LiveScrollProbe> {
  return scroller.evaluate((el) => ({
    bottomDistance: el.scrollHeight - el.scrollTop - el.clientHeight,
    clientHeight: el.clientHeight,
    pinned: el.getAttribute("data-live-scroll-pinned"),
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
  }));
}

async function settleFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function openRunningJobDetail(page: Page, label: string): Promise<string> {
  const transport = storeTransport();
  const sessionId = `${label}-${test.info().workerIndex}-${Date.now()}`;
  await seedExchanges(transport, sessionId, 8);
  await announceBrowserJob(
    transport,
    sessionId,
    browserJobSnapshot({ id: `job-${label}`, tail: browserJobTail(label, 70) }),
  );

  await page.goto(`/?session=${sessionId}`);
  await expect(page.locator("[data-transcript-virtual-list]")).toHaveAttribute(
    "data-transcript-ready",
    "true",
  );
  await page.getByRole("button", { name: `Inspect job-${label}` }).click();
  await expect(detailScroller(page)).toContainText(`${label} output line 69`);
  await expect.poll(() => bottomDistance(detailScroller(page))).toBeLessThan(PIN_TOLERANCE_PX);
  return sessionId;
}

async function ensureRightPanelOpen(page: Page): Promise<void> {
  const tangentsButton = page.getByRole("button", { name: "Tangents from this session" });
  if (await tangentsButton.isVisible()) {
    return;
  }
  const openPanel = page.getByRole("button", { name: "Open panel" });
  if (await openPanel.isVisible()) {
    await openPanel.click();
  }
}

async function expectUnpinnedGrowthPreservesAnchor(input: {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly scroller: Locator;
  readonly anchorText: string;
  readonly afterText: string;
  readonly attachmentName: string;
  readonly anchorDescription: string;
  readonly grow: () => Promise<void>;
}): Promise<void> {
  const {
    page,
    testInfo,
    scroller,
    anchorText,
    afterText,
    attachmentName,
    anchorDescription,
    grow,
  } = input;

  await scroller.hover();
  await page.mouse.wheel(0, -520);
  await settleFrames(page, 6);
  await expect(scroller).toHaveAttribute("data-live-scroll-pinned", "false");

  const anchorLine = page.getByText(anchorText, { exact: false });
  await expect(anchorLine).toBeVisible();
  const before = {
    probe: await liveScrollProbe(scroller),
    anchorBox: await anchorLine.boundingBox(),
  };
  expect(before.anchorBox, `expected ${anchorDescription} anchor to be visible`).toBeTruthy();

  await grow();
  await expect(scroller).toContainText(afterText);
  await settleFrames(page, 6);

  const after = {
    probe: await liveScrollProbe(scroller),
    anchorBox: await anchorLine.boundingBox(),
  };

  await testInfo.attach(attachmentName, {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: "application/json",
  });

  expect(after.probe.pinned).toBe("false");
  expect(after.probe.scrollHeight).toBeGreaterThan(before.probe.scrollHeight);
  expect(after.probe.bottomDistance).toBeGreaterThanOrEqual(
    before.probe.bottomDistance - MONOTONIC_SLACK_PX,
  );
  expect(after.anchorBox, `expected ${anchorDescription} anchor to stay visible`).toBeTruthy();
  expect(Math.abs((after.anchorBox?.y ?? 0) - (before.anchorBox?.y ?? 0))).toBeLessThanOrEqual(
    ANCHOR_TOLERANCE_PX,
  );
}

test("shared live scroll surface follows growing job output only while pinned", async ({
  page,
}, testInfo) => {
  const sessionId = await openRunningJobDetail(page, "job-pinned");
  const scroller = detailScroller(page);
  const before = await liveScrollProbe(scroller);

  await announceBrowserJob(
    storeTransport(),
    sessionId,
    browserJobSnapshot({ id: "job-job-pinned", tail: browserJobTail("job-pinned", 95) }),
  );
  await expect(scroller).toContainText("job-pinned output line 94");
  await settleFrames(page);
  const after = await liveScrollProbe(scroller);

  await testInfo.attach("job-detail-pinned-scroll-metrics.json", {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: "application/json",
  });

  expect(before.pinned).toBe("true");
  expect(after.pinned).toBe("true");
  expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);
  expect(after.bottomDistance).toBeLessThan(PIN_TOLERANCE_PX);
});

test("shared live scroll surface preserves a reading anchor while job output grows", async ({
  page,
}, testInfo) => {
  const sessionId = await openRunningJobDetail(page, "job-unpinned");
  const scroller = detailScroller(page);

  await expectUnpinnedGrowthPreservesAnchor({
    page,
    testInfo,
    scroller,
    anchorText: "job-unpinned output line 39",
    afterText: "job-unpinned output line 94",
    attachmentName: "job-detail-unpinned-scroll-metrics.json",
    anchorDescription: "job output-line",
    grow: () =>
      announceBrowserJob(
        storeTransport(),
        sessionId,
        browserJobSnapshot({ id: "job-job-unpinned", tail: browserJobTail("job-unpinned", 95) }),
      ),
  });

  await expect(page.getByRole("button", { name: /Scroll to (bottom|new content)/ })).toBeVisible();
});

test("shared live scroll surface preserves a reading anchor while tangent output grows", async ({
  page,
}, testInfo) => {
  const transport = storeTransport();
  const parentSessionId = `tangent-parent-${test.info().workerIndex}-${Date.now()}`;
  const tangentSessionId = `tangent-child-${test.info().workerIndex}-${Date.now()}`;
  const runId = `tangent-run-${tangentSessionId}`;
  const quote = "selected scroll anchor for tangent";
  await seedExchanges(transport, parentSessionId, 8);
  await seedTangentSession(transport, {
    parentSessionId,
    tangentSessionId,
    runId,
    quote,
    lineLabel: "tangent-unpinned",
    lines: 70,
  });

  await page.goto(`/?session=${parentSessionId}`);
  await expect(page.locator("[data-transcript-virtual-list]")).toHaveAttribute(
    "data-transcript-ready",
    "true",
  );
  await ensureRightPanelOpen(page);
  await page.getByRole("button", { name: "Tangents from this session" }).click();
  await page.getByText(quote).click();
  await expect(page.getByText("TANGENT", { exact: true })).toBeVisible();
  const scroller = tangentScroller(page);
  await expect(scroller).toContainText("tangent-unpinned output line 69");
  await expect.poll(() => bottomDistance(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  await expectUnpinnedGrowthPreservesAnchor({
    page,
    testInfo,
    scroller,
    anchorText: "tangent-unpinned output line 39",
    afterText: "tangent-unpinned output line 94",
    attachmentName: "tangent-unpinned-scroll-metrics.json",
    anchorDescription: "tangent line",
    grow: () => growTangentSession(transport, tangentSessionId, runId, "tangent-unpinned", 70, 95),
  });
});

test("shared live scroll surface preserves a reading anchor while delegated agent output grows", async ({
  page,
}, testInfo) => {
  const transport = storeTransport();
  const parentSessionId = `agent-parent-${test.info().workerIndex}-${Date.now()}`;
  const childSessionId = `agent-child-${test.info().workerIndex}-${Date.now()}`;
  const runId = `agent-run-${childSessionId}`;
  await seedInlineAgentParent(transport, {
    parentSessionId,
    childSessionId,
    agent: "e2e-explorer",
  });
  await seedRunningAgentChild(transport, {
    childSessionId,
    runId,
    lineLabel: "agent-unpinned",
    lines: 70,
  });

  await page.goto(`/?session=${parentSessionId}`);
  await expect(page.locator("[data-transcript-virtual-list]")).toHaveAttribute(
    "data-transcript-ready",
    "true",
  );
  await page.getByRole("button", { name: /e2e-explorer/ }).click();
  const scroller = agentScroller(page);
  await expect(scroller).toContainText("agent-unpinned output line 69");
  await expect.poll(() => bottomDistance(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  await expectUnpinnedGrowthPreservesAnchor({
    page,
    testInfo,
    scroller,
    anchorText: "agent-unpinned output line 39",
    afterText: "agent-unpinned output line 94",
    attachmentName: "agent-unpinned-scroll-metrics.json",
    anchorDescription: "agent line",
    grow: () => growRunningAgentChild(transport, childSessionId, runId, "agent-unpinned", 70, 95),
  });
});

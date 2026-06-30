import { expect, test } from "@playwright/test";
import { seedExchanges, storeTransport } from "./lane-b-fixtures";

/**
 * M2 (plan 09.2): the REAL web app (vite preview against a build) serves, auto-connects to the hermetic
 * store the runner booted, and renders a transcript published straight into that store. This is the
 * boot harness smoke - it fails until the preview server, the /sessions proxy, the store, and the app's
 * replay-then-render path all line up. Settle via `data-transcript-ready` (no sleeps).
 */
test("the app serves, connects to the hermetic store, and renders a published transcript", async ({
  page,
}) => {
  const transport = storeTransport();
  const sessionId = `boot-${test.info().workerIndex}-${Date.now()}`;
  await seedExchanges(transport, sessionId, 20);

  await page.goto(`/?session=${sessionId}`);

  const list = page.locator("[data-transcript-virtual-list]");
  await expect(list).toHaveAttribute("data-transcript-ready", "true");

  const rowCount = Number(await list.getAttribute("data-transcript-row-count"));
  expect(rowCount).toBeGreaterThanOrEqual(20);

  // The store-published content actually reached the DOM (replay path works end to end).
  await expect(page.locator("[data-transcript-scroll]")).toContainText("answer 19");
});

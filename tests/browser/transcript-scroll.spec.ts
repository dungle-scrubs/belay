import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  appendExchange,
  seedExchanges,
  startStreamingTurn,
  storeTransport,
} from "./lane-b-fixtures";

/**
 * M3 (plan 09.2): the transcript's pin / stick-to-bottom / no-yank / jump behavior, asserted against the
 * REAL virtualized layout (not jsdom). A transcript taller than the viewport is seeded into the hermetic
 * store, the app renders it, and we drive the scroll container the way a user would (wheel, click), then
 * publish more rows to test follow vs. no-yank. Settle on `data-transcript-ready`; no sleeps.
 */

const SEED_EXCHANGES = 30; // ~60 rows -> taller than the 800px viewport, so the transcript scrolls.

/** Open the app on a fresh session seeded with a tall, scrollable transcript; return its scroller. */
async function openTallTranscript(
  page: Page,
  label: string,
): Promise<{ sessionId: string; scroller: Locator }> {
  const transport = storeTransport();
  const sessionId = `${label}-${test.info().workerIndex}-${Date.now()}`;
  await seedExchanges(transport, sessionId, SEED_EXCHANGES);
  await page.goto(`/?session=${sessionId}`);
  await expect(page.locator("[data-transcript-virtual-list]")).toHaveAttribute(
    "data-transcript-ready",
    "true",
  );
  return { sessionId, scroller: page.locator("[data-transcript-scroll]") };
}

/** Distance from the scroller's current position to the live (bottom) edge, in px. ~0 when pinned. */
function bottomDeltaPx(scroller: Locator): Promise<number> {
  return scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

const jumpButton = (page: Page): Locator =>
  page.locator('button[aria-label="Scroll to bottom"], button[aria-label="Scroll to new content"]');

test("appending while pinned keeps the last row at the live edge (stick-to-bottom)", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "pin");
  // Opens pinned: at the live edge, no jump affordance.
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(4);
  await expect(jumpButton(page)).toHaveCount(0);

  await appendExchange(storeTransport(), sessionId, "while-pinned");

  // The new row lands at the live edge and is visible; still pinned (no jump button).
  await expect(scroller).toContainText("reply while-pinned");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(4);
  await expect(jumpButton(page)).toHaveCount(0);
});

test("scrolling up unpins, the jump affordance appears, and a later append does NOT yank the viewport", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "unpin");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(4);

  // A real wheel-up over the scroller is a user scroll-intent -> unpin.
  await scroller.hover();
  await page.mouse.wheel(0, -1200);

  // Unpinned: the jump-to-bottom button shows and we are no longer at the live edge.
  await expect(jumpButton(page)).toHaveCount(1);
  await expect.poll(() => bottomDeltaPx(scroller)).toBeGreaterThan(20);

  const before = await scroller.evaluate((el) => el.scrollTop);
  await appendExchange(storeTransport(), sessionId, "while-unpinned");
  // The appended content exists in the log, but the viewport must not jump to it (no yank).
  await expect(jumpButton(page)).toHaveCount(1);
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(4);
});

test("a mid-stream growing row is auto-followed while pinned (bottomDelta stays small, no yank)", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "stream");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(4);

  const turn = await startStreamingTurn(storeTransport(), sessionId);
  for (let i = 0; i < 8; i += 1) {
    await turn.delta(`streamed line ${i}\n`);
    // While pinned, each growth keeps us at the live edge rather than leaving a gap below.
    await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(8);
  }
  await turn.complete(" done");
  await expect(scroller).toContainText("streamed line 7");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(8);
});

test("clicking jump-to-bottom re-pins and returns to the live edge", async ({ page }) => {
  const { sessionId, scroller } = await openTallTranscript(page, "jump");

  // Unpin first.
  await scroller.hover();
  await page.mouse.wheel(0, -1200);
  await expect(jumpButton(page)).toHaveCount(1);

  await jumpButton(page).click();

  // Re-pinned: the button is gone and we are back at the live edge.
  await expect(jumpButton(page)).toHaveCount(0);
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(4);

  // And a subsequent append now sticks again (re-pin actually re-engaged follow).
  await appendExchange(storeTransport(), sessionId, "after-jump");
  await expect(scroller).toContainText("reply after-jump");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(4);
});

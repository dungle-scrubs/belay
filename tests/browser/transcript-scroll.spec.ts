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
const PIN_TOLERANCE_PX = 4; // within this of the bottom counts as pinned/at-the-live-edge.
const STREAM_TOLERANCE_PX = 8; // a growing row may briefly trail the edge by a partial row height.
// The pre-12.2 AT_BOTTOM_TOLERANCE (scroll.ts): a scroll-up that lands within this of the bottom used
// to still read as "pinned", so the old code kept following. The 12.2 regression specs deliberately
// read within this band to prove a small upward gesture no longer traps the viewport at the live edge.
const OLD_TOLERANCE_PX = 40;
// Slack for sub-pixel rounding when asserting a scrollTop trajectory is non-increasing (monotonic
// upward progress). Any real "tug"/"snap" back toward the bottom is tens of px, far past this.
const MONOTONIC_SLACK_PX = 2;

/** Total rows the virtualized list reports (data-transcript-row-count). */
function rowCount(page: Page): Promise<number> {
  return page
    .locator("[data-transcript-virtual-list]")
    .getAttribute("data-transcript-row-count")
    .then((v) => Number(v));
}

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

/** The scroller's current top offset. Compared before/after an event to prove the viewport did (not) move. */
function scrollTopOf(scroller: Locator): Promise<number> {
  return scroller.evaluate((el) => el.scrollTop);
}

/** Yield `count` animation frames inside the page, so any deferred (double-rAF) follow write has applied
 *  before the next scrollTop sample. Frame-based, not a wall-clock sleep - deterministic under load. */
function settleFrames(page: Page, count = 3): Promise<void> {
  return page.evaluate(async (n) => {
    for (let i = 0; i < n; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

test("appending while pinned keeps the last row at the live edge (stick-to-bottom)", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "pin");
  // Opens pinned: at the live edge, no jump affordance.
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);
  await expect(jumpButton(page)).toHaveCount(0);

  await appendExchange(storeTransport(), sessionId, "while-pinned");

  // The new row lands at the live edge and is visible; still pinned (no jump button).
  await expect(scroller).toContainText("reply while-pinned");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);
  await expect(jumpButton(page)).toHaveCount(0);
});

test("scrolling up unpins, the jump affordance appears, and a later append does NOT yank the viewport", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "unpin");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  // A real wheel-up over the scroller is a user scroll-intent -> unpin.
  await scroller.hover();
  await page.mouse.wheel(0, -1200);

  // Unpinned: the jump-to-bottom button shows and we are no longer at the live edge.
  await expect(jumpButton(page)).toHaveCount(1);
  await expect.poll(() => bottomDeltaPx(scroller)).toBeGreaterThan(20);

  const before = await scroller.evaluate((el) => el.scrollTop);
  const beforeRows = await rowCount(page);
  await appendExchange(storeTransport(), sessionId, "while-unpinned");
  // Wait until the append is actually observed (the row is off-screen/virtualized, so we can't assert on
  // its text) BEFORE measuring - otherwise "no yank" passes trivially because the row-add hasn't landed.
  await expect.poll(() => rowCount(page)).toBeGreaterThan(beforeRows);
  await expect(jumpButton(page)).toHaveCount(1);
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(PIN_TOLERANCE_PX);
});

test("a mid-stream growing row is auto-followed while pinned (bottomDelta stays small, no yank)", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "stream");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  const turn = await startStreamingTurn(storeTransport(), sessionId);
  for (let i = 0; i < 8; i += 1) {
    await turn.delta(`streamed line ${i}\n`);
    // While pinned, each growth keeps us at the live edge rather than leaving a gap below.
    await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(STREAM_TOLERANCE_PX);
  }
  await turn.complete(" done");
  await expect(scroller).toContainText("streamed line 7");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(STREAM_TOLERANCE_PX);
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
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  // And a subsequent append now sticks again (re-pin actually re-engaged follow).
  await appendExchange(storeTransport(), sessionId, "after-jump");
  await expect(scroller).toContainText("reply after-jump");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);
});

/**
 * plan 12.2 regression specs. These are authored RED against the pre-12.2 code (the lagging derived
 * pin state + ~6 independent follow effects) and go green once the single follow controller lands
 * (M3). Each reproduces one of the three user-visible regressions with direction / monotonicity
 * assertions rather than exact pixel targets, so they read behavior, not layout.
 */

test("an append while the user is reading near the bottom does not yank the viewport to the live edge", async ({
  page,
}) => {
  // Read a SMALL amount up - a nudge that lands WITHIN the old 40px tolerance band, where the pre-12.2
  // code still counted the viewport as pinned. Under that code the reading nudge is not honored at all:
  // `followOnAppend` + the last-row layout effect (and even the lingering post-reveal re-measure) pull
  // the column straight back to the live edge, so an append never leaves the reader where they were.
  const { sessionId, scroller } = await openTallTranscript(page, "read-det");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  await scroller.hover();
  await page.mouse.wheel(0, -24); // a small "reading" nudge, still inside the old tolerance band

  const beforeRows = await rowCount(page);
  await appendExchange(storeTransport(), sessionId, "while-reading");
  // Wait until the appended rows are actually part of the list before measuring, so the assertion can't
  // pass just because the append has not landed yet.
  await expect.poll(() => rowCount(page)).toBeGreaterThan(beforeRows);
  await settleFrames(page);

  // Outcome: the reader is still up the transcript, NOT snapped to the live edge, and the jump affordance
  // is showing (unpinned). The old code lands here at the live edge (bottomDelta ~0, no jump button).
  expect(
    await bottomDeltaPx(scroller),
    "the reading nudge + append must leave the viewport off the live edge",
  ).toBeGreaterThan(PIN_TOLERANCE_PX);
  await expect(jumpButton(page)).toHaveCount(1);
});

test("a slow upward wheel during a streaming turn makes monotonic upward progress (no tug)", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "monotonic");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  // A live streaming row keeps re-measuring (its height grows per delta) - the churn the old code let
  // tug the viewport back down while the user scrolled up in small steps within the tolerance band.
  const turn = await startStreamingTurn(storeTransport(), sessionId, `stream-${sessionId}`);
  for (let i = 0; i < 4; i += 1) {
    await turn.delta(`priming line ${i}\n`);
  }
  await settleFrames(page);

  await scroller.hover();
  const samples: number[] = [];
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, -30); // a small, deliberate reading step upward
    await turn.delta(`growing line ${step}\n`); // grow the streaming row between steps
    await settleFrames(page); // let any (old) re-measure follow apply before sampling
    samples.push(await scrollTopOf(scroller));
  }
  await turn.complete(" end");

  // Scrolling up only ever decreases scrollTop; the "tug" is any sample that rises above its predecessor.
  for (let i = 1; i < samples.length; i += 1) {
    expect(
      samples[i],
      `sample ${i} (${samples[i]}) rose above sample ${i - 1} (${samples[i - 1]}) - the tug`,
    ).toBeLessThanOrEqual((samples[i - 1] ?? 0) + MONOTONIC_SLACK_PX);
  }
  // And the gesture actually took us well up the transcript (not repeatedly snapped back to the edge).
  expect(await bottomDeltaPx(scroller)).toBeGreaterThan(OLD_TOLERANCE_PX);
});

test("a rapid wheel flick from the bottom unpins, stays unpinned, and never snaps back down", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "flick");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  // Rapid consecutive upward bursts from the pinned bottom while new rows keep arriving at the live edge -
  // the "flick away while it's still generating" case. Under the old code every arriving row, seen while
  // the lagging pin state was still true, re-ran `followOnAppend` + the last-row follow and snapped the
  // column back to the (now taller) live edge, so the flick never broke free and the position kept
  // resetting downward. Each burst starts inside the 40px band the old code re-pinned.
  await scroller.hover();
  const samples: number[] = [];
  for (let burst = 0; burst < 6; burst += 1) {
    await page.mouse.wheel(0, -30);
    await appendExchange(storeTransport(), sessionId, `flick-${burst}`);
    await settleFrames(page);
    samples.push(await scrollTopOf(scroller));
  }

  // Stays unpinned: the flick broke free and the jump affordance is present (post-M3 this also reads
  // data-transcript-pinned). The old code re-pins on every arriving row, so the button never appears.
  await expect(jumpButton(page)).toHaveCount(1);

  // The trajectory is monotonic upward (scrollTop non-increasing) - no arriving row snapped the column
  // back down to the live edge. The old code yanks scrollTop down to each new, taller bottom instead.
  for (let i = 1; i < samples.length; i += 1) {
    expect(
      samples[i],
      `flick sample ${i} (${samples[i]}) snapped below sample ${i - 1} (${samples[i - 1]})`,
    ).toBeLessThanOrEqual((samples[i - 1] ?? 0) + MONOTONIC_SLACK_PX);
  }
  // Final position reflects the gesture (scrolled well up), not a reset back to the live edge.
  expect(await bottomDeltaPx(scroller)).toBeGreaterThan(OLD_TOLERANCE_PX);
});

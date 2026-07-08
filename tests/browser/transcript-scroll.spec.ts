import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  appendExchange,
  completeMixedTool,
  seedExchanges,
  seedMixedToolTranscript,
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
// Slack for sub-pixel rounding when asserting a bottomDelta trajectory is non-decreasing (monotonic
// upward progress away from the live edge). Any real "tug"/"snap" back toward the bottom is tens of
// px, far past this. bottomDelta (not raw scrollTop) is sampled because a legitimate above-fold
// anchor compensation shifts scrollTop a few px while keeping the viewport visually stationary.
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

interface ScrollProbe {
  readonly bottomDistance: number;
  readonly clientHeight: number;
  readonly pinned: string | null;
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly topVisibleId: string | null;
  readonly topVisibleOffset: number | null;
  readonly visibleIds: readonly string[];
  readonly visibleIndexes: readonly number[];
  readonly visibleRows: readonly {
    readonly id: string;
    readonly index: number;
    readonly top: number;
  }[];
}

function scrollProbe(scroller: Locator): Promise<ScrollProbe> {
  return scroller.evaluate((el) => {
    const scrollerRect = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-transcript-virtual-row]"));
    const visible = rows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        const message = row.querySelector<HTMLElement>("[data-message-id]");
        return {
          id: message?.dataset.messageId ?? null,
          index: Number(row.dataset.index ?? "-1"),
          top: rect.top - scrollerRect.top,
          visible: rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom,
        };
      })
      .filter((row) => row.visible)
      .sort((a, b) => a.top - b.top);
    const top = visible[0];

    return {
      bottomDistance: el.scrollHeight - el.scrollTop - el.clientHeight,
      clientHeight: el.clientHeight,
      pinned: el.getAttribute("data-transcript-pinned"),
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      topVisibleId: top?.id ?? null,
      topVisibleOffset: top?.top ?? null,
      visibleIds: visible.map((row) => row.id ?? `index:${row.index}`),
      visibleIndexes: visible.map((row) => row.index),
      visibleRows: visible.map((row) => ({
        id: row.id ?? `index:${row.index}`,
        index: row.index,
        top: row.top,
      })),
    };
  });
}

async function wheelUntilVisible(page: Page, scroller: Locator, text: string): Promise<void> {
  await scroller.hover();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await page.getByText(text, { exact: true }).isVisible()) {
      return;
    }
    await page.mouse.wheel(0, -650);
    await settleFrames(page, 2);
  }
  throw new Error(`could not wheel to visible transcript text: ${text}`);
}

const jumpButton = (page: Page): Locator =>
  page.locator('button[aria-label="Scroll to bottom"], button[aria-label="Scroll to new content"]');

/** Assert the controller's pin state via the additive `data-transcript-pinned` hook (plan 12.2 D-003):
 *  the direct read of the follow authority, crisper than inferring it from the jump affordance. */
function expectPinned(scroller: Locator, pinned: boolean): Promise<void> {
  return expect(scroller).toHaveAttribute("data-transcript-pinned", pinned ? "true" : "false");
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
  // Opens pinned: at the live edge, pinned attribute set, no jump affordance.
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);
  await expectPinned(scroller, true);
  await expect(jumpButton(page)).toHaveCount(0);

  await appendExchange(storeTransport(), sessionId, "while-pinned");

  // The new row lands at the live edge and is visible; still pinned (attribute + no jump button).
  await expect(scroller).toContainText("reply while-pinned");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);
  await expectPinned(scroller, true);
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

  // Unpinned: the attribute flips, the jump-to-bottom button shows, and we left the live edge.
  await expectPinned(scroller, false);
  await expect(jumpButton(page)).toHaveCount(1);
  await expect.poll(() => bottomDeltaPx(scroller)).toBeGreaterThan(20);

  const before = await bottomDeltaPx(scroller);
  const beforeRows = await rowCount(page);
  await appendExchange(storeTransport(), sessionId, "while-unpinned");
  // Wait until the append is actually observed (the row is off-screen/virtualized, so we can't assert on
  // its text) BEFORE measuring - otherwise "no yank" passes trivially because the row-add hasn't landed.
  await expect.poll(() => rowCount(page)).toBeGreaterThan(beforeRows);
  await expectPinned(scroller, false);
  await expect(jumpButton(page)).toHaveCount(1);
  // No yank: the distance from the live edge never shrinks (the append below only grows it). Sampled as
  // bottomDelta, not raw scrollTop - an above-viewport estimate correction legitimately shifts scrollTop
  // a few px (anchor compensation, visually stationary) and must not read as movement.
  const after = await bottomDeltaPx(scroller);
  expect(
    after,
    "an append while unpinned must not pull the viewport toward the live edge",
  ).toBeGreaterThanOrEqual(before - MONOTONIC_SLACK_PX);
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
  await expectPinned(scroller, true);
});

test("streaming tokens do not move the visible anchor while the user is reading above the live edge", async ({
  page,
}, testInfo) => {
  const { sessionId, scroller } = await openTallTranscript(page, "stream-anchor");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  const turn = await startStreamingTurn(storeTransport(), sessionId, `stream-anchor-${sessionId}`);
  for (let i = 0; i < 6; i += 1) {
    await turn.delta(`priming streamed line ${i}\n`);
  }
  await settleFrames(page, 4);

  await scroller.hover();
  await page.mouse.wheel(0, -420);
  await settleFrames(page, 4);
  await expectPinned(scroller, false);

  const before = await scrollProbe(scroller);
  const anchor = before.visibleRows.find(
    (row) => row.top >= 40 && row.top <= before.clientHeight - 120,
  );
  expect(anchor, `expected an interior visible anchor row: ${JSON.stringify(before)}`).toBeTruthy();

  const samples: ScrollProbe[] = [before];
  for (let i = 0; i < 8; i += 1) {
    await turn.delta(`reading-mode streamed line ${i}\n`);
    await settleFrames(page, 4);
    samples.push(await scrollProbe(scroller));
  }
  await turn.complete("done");

  await testInfo.attach("stream-anchor-scroll-metrics.json", {
    body: JSON.stringify({ anchor, samples }, null, 2),
    contentType: "application/json",
  });

  for (const [index, sample] of samples.entries()) {
    expect(sample.pinned).toBe("false");
    const sampleAnchor = sample.visibleRows.find((row) => row.id === anchor?.id);
    expect(
      sampleAnchor,
      `anchor row disappeared at sample ${index}: ${JSON.stringify(sample)}`,
    ).toBeTruthy();
    expect(
      Math.abs((sampleAnchor?.top ?? 0) - (anchor?.top ?? 0)),
      `streaming sample ${index} moved anchor: before=${JSON.stringify(before)} sample=${JSON.stringify(sample)}`,
    ).toBeLessThanOrEqual(2);
  }
});

test("streaming tokens do not move an earlier visible line in the same assistant message", async ({
  page,
}, testInfo) => {
  const { sessionId, scroller } = await openTallTranscript(page, "stream-line-anchor");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  const turn = await startStreamingTurn(
    storeTransport(),
    sessionId,
    `stream-line-anchor-${sessionId}`,
  );
  for (let i = 0; i < 40; i += 1) {
    await turn.delta(`visible streamed anchor block line ${i}\n\n`);
  }
  await settleFrames(page, 6);

  await scroller.hover();
  await page.mouse.wheel(0, -760);
  await settleFrames(page, 6);
  await expectPinned(scroller, false);

  const anchorLine = page.getByText("visible streamed anchor block line 16", { exact: true });
  await expect(anchorLine).toBeVisible();
  const before = {
    probe: await scrollProbe(scroller),
    anchorBox: await anchorLine.boundingBox(),
  };
  expect(before.anchorBox, "expected streamed line anchor to have a bounding box").toBeTruthy();

  const samples: {
    readonly probe: ScrollProbe;
    readonly anchorBox: Awaited<ReturnType<typeof anchorLine.boundingBox>>;
  }[] = [before];
  for (let i = 0; i < 8; i += 1) {
    await turn.delta(`later streamed line while reading ${i}\n\n`);
    await settleFrames(page, 4);
    samples.push({
      probe: await scrollProbe(scroller),
      anchorBox: await anchorLine.boundingBox(),
    });
  }
  await turn.complete("done");

  await testInfo.attach("stream-line-anchor-scroll-metrics.json", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });

  for (const [index, sample] of samples.entries()) {
    expect(sample.probe.pinned).toBe("false");
    expect(sample.anchorBox, `anchor line disappeared at sample ${index}`).toBeTruthy();
    expect(
      Math.abs((sample.anchorBox?.y ?? 0) - (before.anchorBox?.y ?? 0)),
      `streaming sample ${index} moved the visible line: before=${JSON.stringify(before)} sample=${JSON.stringify(sample)}`,
    ).toBeLessThanOrEqual(2);
  }
});

test("clicking jump-to-bottom re-pins and returns to the live edge", async ({ page }) => {
  const { sessionId, scroller } = await openTallTranscript(page, "jump");

  // Unpin first.
  await scroller.hover();
  await page.mouse.wheel(0, -1200);
  await expectPinned(scroller, false);
  await expect(jumpButton(page)).toHaveCount(1);

  await jumpButton(page).click();

  // Re-pinned: the attribute flips back, the button is gone, and we are back at the live edge.
  await expectPinned(scroller, true);
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

  // Outcome: the reader is still up the transcript, NOT snapped to the live edge, and the transcript is
  // unpinned (attribute + jump affordance). The old code lands here at the live edge (bottomDelta ~0).
  expect(
    await bottomDeltaPx(scroller),
    "the reading nudge + append must leave the viewport off the live edge",
  ).toBeGreaterThan(PIN_TOLERANCE_PX);
  await expectPinned(scroller, false);
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
    samples.push(await bottomDeltaPx(scroller));
  }
  await turn.complete(" end");

  // The distance from the live edge only ever grows (the user reads up, the stream grows below); the
  // "tug" is any sample that collapses back toward the edge. We sample bottomDelta, not raw scrollTop:
  // a legitimate above-fold anchor compensation shifts scrollTop a few px while keeping the viewport
  // visually stationary, and must not read as a tug.
  for (let i = 1; i < samples.length; i += 1) {
    expect(
      samples[i],
      `sample ${i} (bottomDelta ${samples[i]}) fell below sample ${i - 1} (${samples[i - 1]}) - the tug`,
    ).toBeGreaterThanOrEqual((samples[i - 1] ?? 0) - MONOTONIC_SLACK_PX);
  }
  // And the gesture actually took us well up the transcript (not repeatedly snapped back to the edge),
  // leaving the transcript unpinned.
  expect(await bottomDeltaPx(scroller)).toBeGreaterThan(OLD_TOLERANCE_PX);
  await expectPinned(scroller, false);
});

test("a rapid wheel flick from the bottom unpins, stays unpinned, and never snaps back down", async ({
  page,
}) => {
  const { sessionId, scroller } = await openTallTranscript(page, "flick");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  // Rapid consecutive upward bursts from the pinned bottom while new rows keep arriving at the live edge -
  // the "flick away while it's still generating" case. Under the old code every arriving row, seen while
  // the lagging pin state was still true, re-ran `followOnAppend` + the last-row follow and snapped the
  // column back to the (now taller) live edge, so the flick never broke free and the distance-from-bottom
  // kept resetting to ~0. Each burst starts inside the 40px band the old code re-pinned.
  await scroller.hover();
  const samples: number[] = [];
  for (let burst = 0; burst < 6; burst += 1) {
    await page.mouse.wheel(0, -30);
    await appendExchange(storeTransport(), sessionId, `flick-${burst}`);
    await settleFrames(page);
    samples.push(await bottomDeltaPx(scroller));
  }

  // Stays unpinned: the flick broke free - the pinned attribute reads false and the jump affordance is
  // present. The old code re-pins on every arriving row, so neither ever shows.
  await expectPinned(scroller, false);
  await expect(jumpButton(page)).toHaveCount(1);

  // The distance from the live edge never collapses back toward it - no arriving row snapped the column
  // to the bottom. (We sample bottomDelta, not raw scrollTop: an above-fold re-measure legitimately
  // shifts scrollTop a few px to keep the viewport visually stationary, which is not a downward snap.)
  // The old code resets bottomDelta to ~0 on every append.
  for (let i = 1; i < samples.length; i += 1) {
    expect(
      samples[i],
      `flick sample ${i} (bottomDelta ${samples[i]}) snapped toward the edge from ${samples[i - 1]}`,
    ).toBeGreaterThanOrEqual((samples[i - 1] ?? 0) - MONOTONIC_SLACK_PX);
  }
  // Final position reflects the gesture (scrolled well up), not a reset back to the live edge.
  expect(await bottomDeltaPx(scroller)).toBeGreaterThan(OLD_TOLERANCE_PX);
});

test("a tool result expanding above the viewport preserves the reader's visual anchor", async ({
  page,
}, testInfo) => {
  const transport = storeTransport();
  const sessionId = `tool-anchor-${test.info().workerIndex}-${Date.now()}`;
  const tool = await seedMixedToolTranscript(transport, sessionId);
  await page.goto(`/?session=${sessionId}`);
  await expect(page.locator("[data-transcript-virtual-list]")).toHaveAttribute(
    "data-transcript-ready",
    "true",
  );

  const scroller = page.locator("[data-transcript-scroll]");
  await expect.poll(() => bottomDeltaPx(scroller)).toBeLessThan(PIN_TOLERANCE_PX);

  await wheelUntilVisible(page, scroller, tool.anchorText);
  await expectPinned(scroller, false);
  await expect(jumpButton(page)).toHaveCount(1);

  const before = await scrollProbe(scroller);
  await completeMixedTool(transport, sessionId, tool);
  await expect
    .poll(async () => Math.abs((await scrollProbe(scroller)).scrollHeight - before.scrollHeight))
    .toBeGreaterThan(20);
  await settleFrames(page, 6);
  const after = await scrollProbe(scroller);

  await testInfo.attach("tool-anchor-scroll-metrics.json", {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: "application/json",
  });

  expect(after.pinned).toBe("false");
  const anchor = before.visibleRows.find(
    (row) => row.top >= 40 && row.top <= before.clientHeight - 120,
  );
  expect(anchor, `expected an interior visible anchor row: ${JSON.stringify(before)}`).toBeTruthy();
  const afterAnchor = after.visibleRows.find((row) => row.id === anchor?.id);
  expect(
    afterAnchor,
    `anchor row disappeared: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  ).toBeTruthy();
  expect(
    Math.abs((afterAnchor?.top ?? 0) - (anchor?.top ?? 0)),
    `visible anchor row moved: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  ).toBeLessThanOrEqual(2);
  expect(
    after.bottomDistance,
    "expanding an above-viewport tool must not pull the viewport toward the live edge",
  ).toBeGreaterThanOrEqual(before.bottomDistance - MONOTONIC_SLACK_PX);
});

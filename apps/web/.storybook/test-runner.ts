import path from "node:path";
import type { TestRunnerConfig } from "@storybook/test-runner";
import { toMatchImageSnapshot } from "jest-image-snapshot";
import {
  BROWSER_VIEWPORT,
  DISABLE_ANIMATIONS_CSS,
  SCREENSHOT_MAX_DIFF_PIXEL_RATIO,
} from "../../../tests/browser/shared";

/**
 * Lane A (plan 09.2 M1): the Storybook visual-regression test-runner config. Every story gets a SMOKE
 * check (rendered with real size, did not throw or collapse to zero height) plus a
 * SCREENSHOT DIFF against a committed, container-generated baseline (D-001/D-002). Animations, the clock,
 * and RNG are frozen before each story renders so a mid-flight transition / shimmer frame / relative
 * timestamp can never flake the capture (D-003). Stories are auto-discovered, so anything added to
 * Storybook is covered with no per-story wiring.
 *
 * Baselines are written ONLY under `--update-snapshots`, in the pinned container (see
 * tests/browser/update-storybook-baselines.sh); a missing baseline is a HARD failure on a normal run, so
 * a new story can never silently pass without one.
 */

/** Committed baselines live beside the web app (`apps/web/__snapshots__`), keyed by story id. The
 *  test-runner script runs with cwd = apps/web, so this resolves there regardless of the temp test file. */
const SNAPSHOTS_DIR = path.join(process.cwd(), "__snapshots__");

/** Freeze the clock + RNG in the page before the story renders, so any relative-time or shimmer-keyed
 *  content is identical across runs. Animations themselves are killed by the CSS below. */
const FREEZE_TIME_AND_RNG = `
  Date.now = () => 1767225600000;            /* 2026-01-01T00:00:00Z */
  Math.random = () => 0.42;
  if (window.performance) { window.performance.now = () => 0; }
`;

/**
 * Block until the page is visually settled, then screenshot. Two gates, in order.
 *
 * FONTS FIRST. Storybook loads JetBrains Mono as a webfont (`.storybook/preview.tsx`), so text paints in
 * a fallback face and reflows when the real face arrives. That alone is a large diff on any text-heavy
 * story, and it is worse inside the transcript: the virtualizer sizes rows from TEXT METRICS, so a font
 * swap invalidates every measurement it already took. Whichever side of the swap a run captures decides
 * the pixels, which is how a baseline can be written one way and verified another.
 *
 * LAYOUT SECOND. The transcript virtualizer defers row re-measurement to an animation frame
 * (`useAnimationFrameWithResizeObserver`, virtual-transcript.tsx), so even with fonts resolved the first
 * frame can still hold estimated heights.
 *
 * READINESS THIRD, where the component declares it. VirtualTranscript sets `data-transcript-ready` only
 * once it has revealed, which beats inferring the same thing from geometry: react-virtual reruns its
 * rerender through `flushSync`, and React DROPS that flush when it is already rendering, so the update
 * can land a frame late - after a lull that a pure stability poll would have accepted as settled.
 *
 * The signature stays deliberately cheap - the story root's box plus the scroll geometry of scrollable
 * containers, read through a bounded selector. An earlier version walked every descendant each frame;
 * that forced a synchronous reflow per frame and perturbed the very timing it was trying to observe.
 */
const STABLE_FRAMES_REQUIRED = 5;
const MAX_SETTLE_FRAMES = 120;

const WAIT_FOR_STABLE_LAYOUT = `
  document.fonts.ready.then(() => new Promise((resolve) => {
    const root = document.querySelector("#storybook-root");
    const scrollers = root ? root.querySelectorAll("[class*='overflow-auto'],[class*='overflow-y-auto']") : [];
    const transcriptsRevealed = () => {
      for (const el of document.querySelectorAll("[data-transcript-virtual-list]")) {
        if (el.getAttribute("data-transcript-ready") !== "true") return false;
      }
      return true;
    };
    const signature = () => {
      if (!root) return "";
      const rect = root.getBoundingClientRect();
      let acc = rect.width + "x" + rect.height;
      for (const el of scrollers) {
        acc += "|" + el.scrollHeight + ":" + el.scrollTop;
      }
      return acc;
    };
    let previous = signature();
    let stable = 0;
    let frames = 0;
    const tick = () => {
      frames += 1;
      const current = signature();
      stable = transcriptsRevealed() && current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= ${STABLE_FRAMES_REQUIRED} || frames >= ${MAX_SETTLE_FRAMES}) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }))
`;

const config: TestRunnerConfig = {
  setup() {
    expect.extend({ toMatchImageSnapshot });
  },
  async preVisit(page) {
    // preVisit runs BEFORE the story renders, so these take effect for the render itself. The shared
    // viewport keeps Lane A geometry identical to Lane B and stable across machines.
    await page.setViewportSize(BROWSER_VIEWPORT);
    await page.evaluate(FREEZE_TIME_AND_RNG);
    await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
  },
  async postVisit(page, context) {
    // Smoke: a story that threw or collapsed to zero height (the regression that motivated this lane)
    // fails here, before the screenshot.
    const root = page.locator("#storybook-root");
    const box = await root.boundingBox();
    if (!box || box.width < 1 || box.height < 1) {
      throw new Error(
        `Story "${context.id}" rendered blank or collapsed (${box?.width ?? 0}x${box?.height ?? 0}px) - smoke failed before the screenshot diff.`,
      );
    }

    // Let deferred re-measurement land before capturing, so the pixels do not depend on how fast this
    // particular run reached the story.
    await page.evaluate(WAIT_FOR_STABLE_LAYOUT);

    // Screenshot diff against the committed baseline. A missing baseline throws on a normal run (no
    // silent pass); `--update-snapshots` writes it. The threshold lets antialiasing pass while a
    // collapsed/overlapping layout fails (D-003).
    const image = await page.screenshot({ animations: "disabled", scale: "css" });
    expect(image).toMatchImageSnapshot({
      customSnapshotsDir: SNAPSHOTS_DIR,
      customSnapshotIdentifier: context.id,
      failureThresholdType: "percent",
      failureThreshold: SCREENSHOT_MAX_DIFF_PIXEL_RATIO,
      storeReceivedOnFailure: true,
    });
  },
};

export default config;

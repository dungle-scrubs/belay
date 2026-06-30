/**
 * The shared Playwright foundation (plan 09.2 M0): the container, viewport, screenshot tolerance, and
 * animation-freeze that BOTH browser lanes reuse so they can never drift -
 *   - Lane A (Storybook visual regression) via `@storybook/test-runner` (apps/web/.storybook/test-runner.ts)
 *   - Lane B (app transcript-scroll e2e) via `@playwright/test` (tests/browser/playwright.config.ts)
 * Neither lane redeclares these settings; both import them from here.
 */

/**
 * The pinned Playwright browser container. Screenshot baselines are generated INSIDE this image and
 * committed, so a macOS host and ubuntu CI render identical fonts/antialiasing - host-generated baselines
 * would fail every story on CI (D-002). The tag's Playwright version is pinned to match the
 * `@playwright/test` / `playwright-core` override in pnpm-workspace.yaml.
 */
export const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.50.0-noble";

/** The single fixed viewport both lanes render at, so geometry-dependent screenshots and the Lane B
 *  scroll math are deterministic across machines. */
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Screenshot-diff tolerance (D-003): a small per-image pixel-ratio budget so antialiasing noise passes
 * while a collapsed / overlapping layout (a story whose row list collapses to zero height - the
 * regression that motivated this lane) fails. "Looks remotely right", not pixel-perfect.
 */
export const SCREENSHOT_MAX_DIFF_PIXEL_RATIO = 0.02;

/**
 * CSS that freezes every animation, transition, and the caret blink. Injected before each screenshot so a
 * mid-flight transition (the 600ms treemap, the `tw-shimmer` sweep) or a blinking caret can never capture
 * mid-frame and flake the diff (D-003).
 */
export const DISABLE_ANIMATIONS_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

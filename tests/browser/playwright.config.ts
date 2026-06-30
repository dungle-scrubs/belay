import { defineConfig, devices } from "@playwright/test";
import { BROWSER_VIEWPORT } from "./shared";

/**
 * Lane B (app transcript-scroll e2e) Playwright config (plan 09.2). Chromium-only, headless, and SERIAL
 * (`workers: 1`) because the real app + store + host contend for ephemeral ports and CPU and must stay
 * deterministic (D-009). The app `webServer` (vite preview against a build, booted store/host on
 * ephemeral ports with the fake provider) is wired in M2; M0 only needs the shared viewport + a smoke
 * that headless Chromium runs. Shared container/viewport settings come from ./shared so Lane A and Lane B
 * cannot drift.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: BROWSER_VIEWPORT,
    // Upload a trace + screenshot on a failed run so a CI failure is debuggable without a re-run.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

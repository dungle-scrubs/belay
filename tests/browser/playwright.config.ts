import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { BROWSER_VIEWPORT } from "./shared";

// The runner (run-browser-e2e.ts) boots the store, picks a FREE preview port (so it never collides with
// a dev server on the reserved web port), and exports it + VITE_SESSION_PROXY. `vite preview` serves the
// built app there and proxies /sessions to the ephemeral store.
const WEB_PORT = process.env.TREVOR_E2E_WEB_PORT ?? "17431";
const APP_URL = `http://127.0.0.1:${WEB_PORT}`;
const WEB_DIR = fileURLToPath(new URL("../../apps/web", import.meta.url));

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
    baseURL: APP_URL,
    // Upload a trace + screenshot on a failed run so a CI failure is debuggable without a re-run.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // `vite preview` serves the pre-built app; the runner has already booted the store + set
  // VITE_SESSION_PROXY, so the preview server proxies /sessions to it. Never reuse an existing server:
  // the store port is EPHEMERAL (new each run), so a reused preview would proxy to a now-closed store.
  webServer: {
    // Run vite directly (not via a pnpm wrapper) so Playwright kills the actual server process on exit
    // and nothing lingers on the port between runs.
    command: `node_modules/.bin/vite preview --port ${WEB_PORT} --strictPort`,
    cwd: WEB_DIR,
    url: APP_URL,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});

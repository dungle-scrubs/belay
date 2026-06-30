import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { bootBlob, bootStore } from "@trevor/test-kit/boot";

/** An OS-assigned free TCP port, so the preview never collides with a dev server on the reserved web
 *  port (or a stray previous run). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Lane B runner (plan 09.2 M2): boots a hermetic session-store + blob-store on EPHEMERAL ports, then runs
 * the Playwright app-e2e against them. The store URL is handed to two consumers via the inherited env:
 *   - `VITE_SESSION_PROXY` -> the `vite preview` webServer proxies the browser's same-origin `/sessions`
 *     calls to the ephemeral store (REST + WS), so the built app needs no per-run rebuild.
 *   - `TREVOR_E2E_STORE_URL` -> the specs open their own transport to publish the deterministic transcript
 *     events the browser then renders.
 * Booting here (not in a Playwright hook) keeps the order unambiguous: stores up BEFORE preview + workers,
 * and torn down after. The web app must already be built (`pnpm --filter @trevor/web build`).
 */
async function main(): Promise<number> {
  const store = await bootStore();
  const blob = await bootBlob();
  const webPort = await freePort();

  const env = {
    ...process.env,
    VITE_SESSION_PROXY: store.url,
    TREVOR_E2E_STORE_URL: store.url,
    TREVOR_E2E_BLOB_URL: blob.url,
    TREVOR_E2E_WEB_PORT: String(webPort),
  };

  // ASYNC spawn (not spawnSync): the stores run in THIS process's event loop, so blocking it would stop
  // them serving the browser + the specs. Await the child's exit via a promise instead.
  const child = spawn(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "tests/browser/playwright.config.ts",
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env },
  );
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });

  await store.close();
  await blob.close();
  return code;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

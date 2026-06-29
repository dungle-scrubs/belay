import { rmSync } from "node:fs";
import { createBlobServer } from "@trevor/blob-store/server";
import { type RunningServer, startServer } from "@trevor/server-kit";
import { createSessionStore } from "@trevor/session-store/server";
import { tempDir } from "./index";

/**
 * The node-only half of the test harness: booting real local stores on ephemeral ports. Kept in a
 * separate entry (`@trevor/test-kit/boot`) from the browser-safe fixtures in `index.ts`, because it
 * imports the store apps (`node:http` + node:sqlite) which the web jsdom test project cannot
 * bundle. The two store *app* tests boot their own server from `../src` instead of importing this,
 * to avoid a test-only dependency cycle back through this package.
 */

/**
 * Boots a real session-store on an ephemeral port over an in-memory database, the hermetic backend
 * the e2e lane runs the full host/web stack against. Returns the same `{ url, close }` handle
 * `startServer` does; `close()` stops the listener. The `:memory:` backing store lives here so no
 * e2e file re-spells it.
 */
export function bootStore(): Promise<RunningServer> {
  return startServer(createSessionStore(":memory:"), { port: 0 });
}

/** A booted blob-store handle: the `startServer` handle whose `close()` also removes the temp root. */
export interface BootedBlob extends RunningServer {
  /** The throwaway directory the store wrote blobs into; removed by `close()`. */
  readonly root: string;
}

/**
 * Boots a real blob-store on an ephemeral port over a throwaway temp directory, with the same
 * 25 MiB cap production uses. `close()` stops the listener AND removes the temp root, so the
 * blob lifecycle the web upload and host vision-inlining depend on has one boot+teardown contract.
 */
export async function bootBlob(): Promise<BootedBlob> {
  const root = tempDir("trevor-blob-");
  const server = await startServer(createBlobServer(root, 25 * 1024 * 1024), { port: 0 });
  return {
    ...server,
    root,
    close: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

import { rmSync } from "node:fs";
import { createBlobServer } from "@trevor/blob-store/server";
import { createTrevorClient, type TrevorClient } from "@trevor/sdk";
import { type RunningServer, startServer } from "@trevor/server-kit";
import { streamTransport } from "@trevor/session";
import { createSessionStore } from "@trevor/session-store/server";
import { createWorkflowDriver, tempDir, type WorkflowDriver } from "./index";

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

/** A booted session-store + blob-store with a `@trevor/sdk` client bound to both, and one teardown. */
export interface BootedSdkStack {
  readonly store: RunningServer;
  readonly blob: BootedBlob;
  /** An SDK client bound to the booted store (`sessionUrl`) and blob (`blobUrl`). */
  readonly client: TrevorClient;
  /** Stops both stores (and removes the blob temp root). */
  close(): Promise<void>;
}

/**
 * Boots the real local stores and binds a `@trevor/sdk` client to them, so a test or eval harness drives
 * Trevor through the SAME headless workflow layer a script would, over the same wire the host and web use.
 * test-kit owns only the ephemeral service lifecycle here; the workflows themselves stay in the SDK (M9
 * keeps test-kit test infrastructure, not a second SDK).
 */
export async function bootSdkStack(): Promise<BootedSdkStack> {
  const store = await bootStore();
  const blob = await bootBlob();
  const client = createTrevorClient({ sessionUrl: store.url, blobUrl: blob.url });
  return {
    store,
    blob,
    client,
    close: async () => {
      await blob.close();
      await store.close();
    },
  };
}

export interface BootedWorkflowStack {
  readonly store: RunningServer;
  readonly transport: ReturnType<typeof streamTransport>;
  workflow(
    sessionId: string,
    opts?: {
      readonly who?: string;
      readonly producerId?: string;
      readonly provider?: string;
    },
  ): Promise<WorkflowDriver>;
  close(): Promise<void>;
}

/**
 * Boots the hermetic session-store and binds a workflow driver factory to its transport, so cross-service
 * tests can drive prompt, command, subscribe, wait, and event inspection through one test-kit-owned
 * boundary instead of reassembling store lifecycle plus subscriber mechanics in every e2e file.
 */
export async function bootWorkflowStack(): Promise<BootedWorkflowStack> {
  const store = await bootStore();
  const transport = streamTransport(store.url);
  return {
    store,
    transport,
    workflow: (sessionId, opts) => createWorkflowDriver(transport, sessionId, opts),
    close: () => store.close(),
  };
}

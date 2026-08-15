import type { AddressInfo } from "node:net";
import { type SessionTransport, streamTransport } from "@belay/session";
import { runTransportConformance } from "@belay/session/conformance";
import { afterAll, beforeAll } from "vitest";
import { createSessionStore } from "../src/server";

/**
 * Runs the shared transport conformance suite (owned by @belay/session) against a real
 * local session-store booted in-process on an ephemeral port over an in-memory database.
 * The hermetic proof that the local backend honors the SessionTransport contract. It boots
 * its OWN server from ../src rather than the e2e harness, so the package has no test-only
 * dependency cycle back through @belay/test-kit.
 */

let server: ReturnType<typeof createSessionStore>;
let transport: SessionTransport;

beforeAll(async () => {
  server = createSessionStore(":memory:");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  transport = streamTransport(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

runTransportConformance({ transport: () => transport });

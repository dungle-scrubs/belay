import type { RunningServer } from "@belay/server-kit";
import { events } from "@belay/session";
import { bootStore } from "@belay/test-kit/boot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTrevorClient, SdkError } from "../src/index";

/**
 * SDK transport binding over a REAL local session-store (plan 28 M2 integration): the client binds to
 * an ephemeral store URL through the same `streamTransport` the browser/host use, and ensure/publish/
 * readLog/inventory all round-trip over real HTTP + WebSocket. A binding to an unreachable URL surfaces
 * as a typed `SdkError`. Tether shares this exact wire, so URL-based binding is the whole story (D-004).
 */

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

describe("createTrevorClient over a real session-store (M2)", () => {
  it("ensures a session, publishes an event, and replays it through readLog", async () => {
    const client = createTrevorClient({ sessionUrl: store.url });
    await client.ensureSession("bind-1");
    await client.publishEvent("bind-1", events.userMessage({ text: "hello store", provider: "p" }));

    const log = await client.readLog("bind-1", { timeoutMs: 5_000 });
    const user = log.find((e) => e.type === "user.message");
    expect(user?.payload.text).toBe("hello store");
  });

  it("surfaces the published session in the inventory read model", async () => {
    const client = createTrevorClient({ sessionUrl: store.url });
    await client.ensureSession("bind-2");
    await client.publishEvent("bind-2", events.userMessage({ text: "titled", provider: "p" }));
    const inventory = await client.fetchInventory();
    expect(inventory.some((s) => s.sessionId === "bind-2")).toBe(true);
  });

  it("reports an unreachable backend as a typed SdkError naming the operation", async () => {
    // Port 1 is privileged/closed: the connection is refused, exercising the error-reporting path.
    const client = createTrevorClient({ sessionUrl: "http://127.0.0.1:1" });
    await expect(client.fetchInventory()).rejects.toBeInstanceOf(SdkError);
    await expect(client.fetchInventory()).rejects.toMatchObject({
      operation: "fetchInventory",
      backendUrlClass: "http://127.0.0.1:1",
    });
  });
});

import { events, PRODUCER_IDS } from "@belay/session";
import { recordingTransport, sessionSummary, storedEvent } from "@belay/test-kit";
import { describe, expect, it } from "vitest";
import { createTrevorClient } from "./client";
import { SdkError } from "./errors";
import { SDK_DISPLAY_NAME } from "./identity";

const SESSION_URL = "http://127.0.0.1:17424";

describe("createTrevorClient", () => {
  it("binds to a session backend by URL through the injected transport (M2)", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    await client.ensureSession("s1");
    expect(rec.ensured).toContain("s1");
    expect(client.sessionUrl).toBe(SESSION_URL);
  });

  it("defaults to a non-host viewer identity and the web producer", () => {
    const client = createTrevorClient({ sessionUrl: SESSION_URL });
    expect(client.identity.displayName).toBe(SDK_DISPLAY_NAME);
    expect(client.identity.runtimeKind).toBe("web");
    expect(client.producerId).toBe(PRODUCER_IDS.web);
  });

  it("stamps its producer id on published protocol events", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({
      sessionUrl: SESSION_URL,
      producerId: PRODUCER_IDS.cli,
      transport: rec.transport,
    });
    await client.publishEvent("s1", events.sessionTitle({ title: "Renamed" }));
    expect(rec.publishedBy("s1")[0]).toMatchObject({
      type: "session.title",
      producerId: PRODUCER_IDS.cli,
    });
  });

  it("reads the inventory read model", async () => {
    const rec = recordingTransport();
    rec.setInventory([sessionSummary({ sessionId: "a" }), sessionSummary({ sessionId: "b" })]);
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    const inventory = await client.fetchInventory();
    expect(inventory.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("reports a backend failure as a typed SdkError naming the operation and URL class", async () => {
    const rec = recordingTransport();
    rec.failInventory(new Error("ECONNREFUSED"));
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    await expect(client.fetchInventory()).rejects.toMatchObject({
      operation: "fetchInventory",
      backend: "session",
      backendUrlClass: SESSION_URL,
    });
    await expect(client.fetchInventory()).rejects.toBeInstanceOf(SdkError);
  });

  it("replays the durable log through readLog", async () => {
    const rec = recordingTransport();
    rec.seed("s1", [storedEvent(events.userMessage({ text: "hi", provider: "p" }), { seq: 1 })]);
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    const log = await client.readLog("s1");
    expect(log).toHaveLength(1);
    expect(log[0]?.type).toBe("user.message");
  });
});

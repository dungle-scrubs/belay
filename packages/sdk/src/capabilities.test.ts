import { events, PRODUCER_IDS } from "@trevor/session";
import {
  doctorSnapshot as doctorSnapshotFixture,
  recordingTransport,
  storedEvent,
} from "@trevor/test-kit";
import { describe, expect, it, vi } from "vitest";
import { createTrevorClient, type TrevorClient } from "./client";

const SESSION_URL = "http://127.0.0.1:17424";

/**
 * Drives a `command.result` reply onto the tail of a recording-transport session, the way a live host
 * answers a `user.command`. It waits for the SDK to publish the command (after replay), then pushes the
 * host's structured reply through the open stream's `onEvent`.
 */
async function replyToCommand(
  rec: ReturnType<typeof recordingTransport>,
  sessionId: string,
  command: string,
  text: string,
): Promise<void> {
  rec.seed(sessionId, []);
  await vi.waitFor(() => expect(rec.publishedBy(sessionId).length).toBeGreaterThan(0));
  const connect = rec.connects.find((c) => c.sessionId === sessionId);
  connect?.onEvent(
    storedEvent(events.commandResult({ command, text, ok: true }), { seq: 2, sessionId }),
  );
}

describe("runCommand (M4)", () => {
  it("publishes the user.command and resolves on the host's tail command.result", async () => {
    const rec = recordingTransport();
    const client: TrevorClient = createTrevorClient({
      sessionUrl: SESSION_URL,
      transport: rec.transport,
    });

    const pending = client.runCommand("s1", "/status", "", { timeoutMs: 1_000 });
    await replyToCommand(rec, "s1", "/status", "all good");

    const result = await pending;
    expect(result).toEqual({ command: "/status", text: "all good", ok: true });
    expect(rec.publishedBy("s1")[0]).toMatchObject({
      type: "user.command",
      producerId: PRODUCER_IDS.web,
      payload: { command: "/status", args: "" },
    });
  });

  it("times out with a typed error when no host answers", async () => {
    const rec = recordingTransport();
    rec.seed("s1", []);
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    await expect(client.runCommand("s1", "/status", "", { timeoutMs: 20 })).rejects.toMatchObject({
      operation: "runCommand",
      backend: "session",
    });
  });
});

describe("doctor (M4)", () => {
  it("decodes the /doctor command result into a structured snapshot", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    const snapshot = doctorSnapshotFixture({ state: "ready" });

    const pending = client.doctor("s1", { timeoutMs: 1_000 });
    await replyToCommand(rec, "s1", "/doctor", JSON.stringify(snapshot));

    expect(await pending).toEqual(snapshot);
  });

  it("returns null when the host sent a legacy text dump", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    const pending = client.doctor("s1", { timeoutMs: 1_000 });
    await replyToCommand(rec, "s1", "/doctor", "plain text health dump");
    expect(await pending).toBeNull();
  });
});

describe("exportCapabilities (M4)", () => {
  it("reads the structured manifest from /trevor-export --json (not from prompt text)", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    const manifest = { version: 1, scope: "full", sections: [] };

    const pending = client.exportCapabilities("s1", { format: "json", timeoutMs: 1_000 });
    await replyToCommand(rec, "s1", "/trevor-export", JSON.stringify(manifest));

    const result = await pending;
    expect(result).toEqual({ format: "json", manifest });
    // The export command carried the machine flag, proving the SDK asked for the structured surface.
    expect(rec.publishedBy("s1")[0]?.payload).toMatchObject({
      command: "/trevor-export",
      args: "--json",
    });
  });
});

import { createTrevorClient } from "@belay/sdk";
import { events, PRODUCER_IDS } from "@belay/session";
import { doctorSnapshot, recordingTransport, storedEvent, storedLog } from "@belay/test-kit";
import { describe, expect, it, vi } from "vitest";
import {
  runArtifactPut,
  runCancel,
  runCapabilities,
  runDoctor,
  runPrompt,
  runTranscript,
} from "./headless";

const SESSION_URL = "http://127.0.0.1:17424";
const BLOB_URL = "http://127.0.0.1:17423";

function makeClient(rec = recordingTransport()) {
  const client = createTrevorClient({
    sessionUrl: SESSION_URL,
    blobUrl: BLOB_URL,
    producerId: PRODUCER_IDS.cli,
    transport: rec.transport,
  });
  return { client, rec };
}

/** Pushes a host reply onto the newest open stream once the CLI has published its request. */
async function replyOnTail(
  rec: ReturnType<typeof recordingTransport>,
  sessionId: string,
  predicate: (type: string) => boolean,
  reply: Parameters<typeof storedEvent>[0],
): Promise<void> {
  await vi.waitFor(() =>
    expect(rec.publishedBy(sessionId).some((e) => predicate(e.type))).toBe(true),
  );
  const connect = rec.connects.filter((c) => c.sessionId === sessionId).at(-1);
  connect?.onEvent(storedEvent(reply, { seq: 99, sessionId }));
}

describe("runPrompt (M8)", () => {
  it("streams a turn to completion and returns the assistant text (human mode)", async () => {
    const { client, rec } = makeClient();
    rec.seed("s1", []);
    const pending = runPrompt(client, {
      sessionId: "s1",
      text: "hello",
      provider: "p",
      json: false,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() =>
      expect(rec.publishedBy("s1").some((e) => e.type === "user.message")).toBe(true),
    );
    const connect = rec.connects.filter((c) => c.sessionId === "s1").at(-1);
    connect?.onEvent(
      storedEvent(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "p" }), {
        seq: 10,
        sessionId: "s1",
      }),
    );
    connect?.onEvent(
      storedEvent(events.assistantCompleted({ runId: "r1", text: "the answer" }), {
        seq: 11,
        sessionId: "s1",
      }),
    );
    const result = await pending;
    expect(result.stdout).toBe("the answer");
  });

  it("returns a structured JSON record in --json mode", async () => {
    const { client, rec } = makeClient();
    rec.seed("s1", []);
    const pending = runPrompt(client, {
      sessionId: "s1",
      text: "hello",
      provider: "p",
      json: true,
      timeoutMs: 1_000,
    });
    await replyOnTail(
      rec,
      "s1",
      (t) => t === "user.message",
      events.assistantCompleted({ runId: "r9", text: "json answer" }),
    );
    // The started event set no runId; correlation falls to the completed event.
    const result = await pending;
    expect(JSON.parse(result.stdout)).toMatchObject({ text: "json answer", timedOut: false });
  });

  it("publishes a ModelRef when one is supplied", async () => {
    const { client, rec } = makeClient();
    rec.seed("s1", []);
    const pending = runPrompt(client, {
      sessionId: "s1",
      text: "hello",
      provider: "openai",
      model: { sourceId: "openai", modelId: "gpt-5", reasoning: "high" },
      json: true,
      timeoutMs: 1_000,
    });
    await replyOnTail(
      rec,
      "s1",
      (t) => t === "user.message",
      events.assistantCompleted({ runId: "r9", text: "json answer" }),
    );

    expect(rec.publishedBy("s1")[0]).toMatchObject({
      type: "user.message",
      payload: {
        provider: "openai",
        model: { sourceId: "openai", modelId: "gpt-5", reasoning: "high" },
      },
    });
    await pending;
  });
});

describe("runCancel (M8)", () => {
  it("publishes user.cancel for the run", async () => {
    const { client, rec } = makeClient();
    const result = await runCancel(client, "s1", "r1");
    expect(result.stdout).toContain("r1");
    expect(rec.publishedBy("s1")[0]).toMatchObject({
      type: "user.cancel",
      payload: { runId: "r1" },
    });
  });

  it("returns usage when the run id is missing", async () => {
    const { client } = makeClient();
    expect((await runCancel(client, "s1", "")).stdout).toContain("usage");
  });
});

describe("runTranscript (M8)", () => {
  it("renders a human transcript and a JSON transcript from the same log", async () => {
    const { client, rec } = makeClient();
    rec.seed(
      "s1",
      storedLog(
        events.userMessage({ text: "hi", provider: "p" }),
        events.assistantCompleted({ runId: "r1", text: "hello back" }),
      ),
    );
    const human = await runTranscript(client, "s1", false);
    expect(human.stdout).toContain("[user] hi");
    expect(human.stdout).toContain("[assistant] hello back");

    const json = await runTranscript(client, "s1", true);
    expect(JSON.parse(json.stdout)).toHaveLength(2);
  });
});

describe("runDoctor (M8)", () => {
  it("prints the structured snapshot as JSON in machine mode", async () => {
    const { client, rec } = makeClient();
    rec.seed("s1", []);
    const snapshot = doctorSnapshot({ state: "ready" });
    const pending = runDoctor(client, "s1", true, 1_000);
    await replyOnTail(
      rec,
      "s1",
      (t) => t === "user.command",
      events.commandResult({ command: "/doctor", text: JSON.stringify(snapshot), ok: true }),
    );
    expect(JSON.parse((await pending).stdout)).toEqual(snapshot);
  });
});

describe("runCapabilities (M8)", () => {
  it("prints the structured manifest in --json mode (from /belay-export)", async () => {
    const { client, rec } = makeClient();
    rec.seed("s1", []);
    const manifest = { version: 1, scope: "full", sections: [] };
    const pending = runCapabilities(client, "s1", { json: true, timeoutMs: 1_000 });
    await replyOnTail(
      rec,
      "s1",
      (t) => t === "user.command",
      events.commandResult({ command: "/belay-export", text: JSON.stringify(manifest), ok: true }),
    );
    expect(JSON.parse((await pending).stdout)).toEqual(manifest);
  });
});

describe("runArtifactPut error mapping (M8)", () => {
  it("surfaces a typed SdkError when the blob store is unreachable", async () => {
    // A guaranteed-unreachable blob URL (never the reserved 17423, which a real local store may hold).
    const client = createTrevorClient({
      sessionUrl: SESSION_URL,
      blobUrl: "http://127.0.0.1:1",
      producerId: PRODUCER_IDS.cli,
      transport: recordingTransport().transport,
    });
    await expect(
      runArtifactPut(client, new Uint8Array([1]), "text/plain", { json: true }),
    ).rejects.toMatchObject({ operation: "uploadArtifact", backend: "blob" });
  });
});

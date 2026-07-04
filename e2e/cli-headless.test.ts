import { answerProvider, attachFakeHost, hangingProvider } from "@trevor/agent-host/testing";
import { runCancel, runPrompt, runTranscript } from "@trevor/cli/headless";
import { createTrevorClient } from "@trevor/sdk";
import { decodeTrevorEvent, PRODUCER_IDS, streamTransport } from "@trevor/session";
import { subscribe, waitFor } from "@trevor/test-kit";
import { bootBlob, bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Plan 28 M11: the headless `trevor` CLI drives prompt / stream / cancel over a REAL local session-store
 * and blob-store, through the exact `@trevor/sdk` workflows the SDK and test-kit use - one protocol, three
 * consumers. A fake-provider host (the same one the eval harness attaches) reacts to the CLI's prompts.
 */

describe("headless CLI over local stores", () => {
  let store: Awaited<ReturnType<typeof bootStore>>;
  let blob: Awaited<ReturnType<typeof bootBlob>>;

  beforeAll(async () => {
    store = await bootStore();
    blob = await bootBlob();
  });

  afterAll(async () => {
    await blob.close();
    await store.close();
  });

  function cliClient() {
    return createTrevorClient({
      sessionUrl: store.url,
      blobUrl: blob.url,
      producerId: PRODUCER_IDS.cli,
    });
  }

  it("prompt + transcript: streams a turn to completion and reads it back", async () => {
    const sessionId = "cli-happy";
    const transport = streamTransport(store.url);
    await transport.ensureSession(sessionId);
    const host = attachFakeHost(transport, sessionId, () => answerProvider("42"));
    try {
      const client = cliClient();
      const prompt = await runPrompt(client, {
        sessionId,
        text: "what is six times seven",
        provider: "fake",
        json: true,
        timeoutMs: 10_000,
      });
      const record = JSON.parse(prompt.stdout) as {
        runId: string | null;
        text: string;
        cancelled: boolean;
        timedOut: boolean;
      };
      expect(record.timedOut).toBe(false);
      expect(record.cancelled).toBe(false);
      expect(record.text).toBe("42");
      expect(record.runId).toBeTruthy();

      const transcript = await runTranscript(client, sessionId, true);
      const entries = JSON.parse(transcript.stdout) as { role: string; text: string }[];
      expect(entries.some((e) => e.role === "user" && e.text.includes("six times seven"))).toBe(
        true,
      );
      expect(entries.some((e) => e.role === "assistant" && e.text === "42")).toBe(true);
    } finally {
      host.close();
    }
  });

  it("cancel: a `trevor cancel <run>` mid-turn resolves the streamed prompt as cancelled", async () => {
    const sessionId = "cli-cancel";
    const transport = streamTransport(store.url);
    await transport.ensureSession(sessionId);
    const host = attachFakeHost(transport, sessionId, () => hangingProvider());
    const watcher = subscribe(transport, sessionId, "watcher");
    try {
      const client = cliClient();
      const promptP = runPrompt(client, {
        sessionId,
        text: "start a long turn",
        provider: "fake",
        json: true,
        timeoutMs: 10_000,
      });

      await waitFor(() => watcher.events.some((e) => e.type === "assistant.started"), {
        label: "assistant.started",
      });
      const started = watcher.events.find((e) => e.type === "assistant.started");
      const decoded = started ? decodeTrevorEvent(started) : null;
      const runId = decoded?.type === "assistant.started" ? decoded.runId : "";
      expect(runId).toBeTruthy();

      const cancelResult = await runCancel(client, sessionId, runId);
      expect(cancelResult.stdout).toContain(runId);

      const record = JSON.parse((await promptP).stdout) as {
        cancelled: boolean;
        timedOut: boolean;
      };
      expect(record.cancelled).toBe(true);
      expect(record.timedOut).toBe(false);
    } finally {
      watcher.connection.close();
      host.close();
    }
  });
});

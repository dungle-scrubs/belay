import {
  createFakeEvalHarness,
  type EvalHarness,
  fakeProvider,
  liveLaneStatus,
  type Provider,
  type ProviderEvent,
} from "@trevor/agent-host/testing";
import { Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Plan 28 M10: the eval/automation harness drives Trevor end-to-end through the `@trevor/sdk` layer and
 * returns a structured record to score. The deterministic `fake` lane attaches a fake-provider host, so
 * these assertions are hermetic; the `live` lane is gated by an explicit skip reason.
 */

const USAGE = { input: 1, output: 1, contextWindow: 1000, genMs: 1 };

/** A provider that answers with fixed text in one step (no tool call), for a clean happy-path assertion. */
function answerProvider(text: string): Provider {
  return fakeProvider({
    step: (): ProviderEvent[] => [
      { type: "text", text },
      { type: "usage", usage: USAGE },
    ],
  });
}

/** A provider whose stream emits one delta then never terminates, so a turn stays open for cancel/timeout. */
function hangingProvider(): Provider {
  return fakeProvider({
    stream: () =>
      Stream.concat(
        Stream.fromIterable<ProviderEvent>([{ type: "text", text: "working" }]),
        Stream.never,
      ),
  });
}

describe("eval harness (fake lane)", () => {
  let harness: EvalHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("runs a prompt and returns a structured record with the answer and transcript", async () => {
    harness = await createFakeEvalHarness();
    const record = await harness.run({
      text: "how tall is everest",
      provider: answerProvider("8849m"),
    });

    expect(record.runId).toBeTruthy();
    expect(record.cancelled).toBe(false);
    expect(record.timedOut).toBe(false);
    expect(record.text).toBe("8849m");
    expect(
      record.transcript.some((e) => e.role === "user" && e.text === "how tall is everest"),
    ).toBe(true);
    expect(record.transcript.some((e) => e.role === "assistant" && e.text === "8849m")).toBe(true);
  });

  it("cancels an in-flight turn (D-094): the record is cancelled, not timed out", async () => {
    harness = await createFakeEvalHarness();
    const record = await harness.run({
      text: "start something long",
      provider: hangingProvider(),
      cancel: true,
      timeoutMs: 10_000,
    });

    expect(record.cancelled).toBe(true);
    expect(record.timedOut).toBe(false);
  });

  it("returns timedOut when the turn never completes within the budget", async () => {
    harness = await createFakeEvalHarness();
    const record = await harness.run({
      text: "hang forever",
      provider: hangingProvider(),
      timeoutMs: 300,
    });

    expect(record.timedOut).toBe(true);
    expect(record.cancelled).toBe(false);
  });

  it("uploads an artifact, attaches it to a prompt, and captures it in the transcript run", async () => {
    harness = await createFakeEvalHarness();
    const ref = await harness.uploadArtifact(new TextEncoder().encode("eval-bytes"), "text/plain");

    const bytes = await harness.client.downloadArtifact(ref);
    expect(new TextDecoder().decode(bytes)).toBe("eval-bytes");

    const record = await harness.run({
      text: "here is a file",
      provider: answerProvider("got it"),
      artifacts: [ref],
    });
    expect(record.text).toBe("got it");
    expect(record.transcript.some((e) => e.role === "user" && e.text === "here is a file")).toBe(
      true,
    );
  });
});

describe("eval harness (live lane)", () => {
  const status = liveLaneStatus();
  it.skipIf(!status.available)("reports its gating status with a reason", () => {
    expect(status.reason).toBeTruthy();
  });

  it("is gated with an explicit reason when prerequisites are absent", () => {
    // Not a skip: this asserts the GATE itself is honest - available or not, it always states why.
    expect(status.reason).toMatch(/LMSTUDIO_URL|auth\.json|live provider/);
  });
});

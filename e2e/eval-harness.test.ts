import {
  answerProvider,
  attachFakeHost,
  createFakeEvalHarness,
  type EvalHarness,
  fakeProvider,
  hangingProvider,
  liveLaneStatus,
} from "@trevor/agent-host/testing";
import { type BootedWorkflowStack, bootWorkflowStack } from "@trevor/test-kit/boot";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Plan 28 M10: the eval/automation harness drives Trevor end-to-end through the `@trevor/sdk` layer and
 * returns a structured record to score. The deterministic `fake` lane attaches a fake-provider host, so
 * these assertions are hermetic; the `live` lane is gated by an explicit skip reason.
 */

describe("eval harness (fake lane)", () => {
  let harness: EvalHarness | undefined;
  let stack: BootedWorkflowStack | undefined;

  afterEach(async () => {
    await harness?.close();
    await stack?.close();
    harness = undefined;
    stack = undefined;
  });

  it("attaches a fake-provider host through the public host testing export", async () => {
    stack = await bootWorkflowStack();
    const workflow = await stack.workflow("fake-host-export", {
      who: "viewer",
      producerId: "web",
      provider: "fake",
    });
    const host = attachFakeHost(stack.transport, workflow.sessionId, () => fakeProvider());

    const result = await workflow.promptToCompletion("Please run echo hello-from-tool.", {
      label: "fake host public export completion",
    });

    expect(result.text).toContain("the tool ran.");
    expect(result.events.some((event) => event.type === "tool.completed")).toBe(true);
    host.close();
    workflow.close();
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

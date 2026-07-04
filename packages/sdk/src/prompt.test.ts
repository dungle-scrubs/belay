import { events, PRODUCER_IDS, type SessionEvent } from "@trevor/session";
import { recordingTransport, storedLog } from "@trevor/test-kit";
import { describe, expect, it } from "vitest";
import { createTrevorClient } from "./client";
import { readModelSwitches } from "./prompt";

const SESSION_URL = "http://127.0.0.1:17424";

function client(transport: ReturnType<typeof recordingTransport>["transport"]) {
  return createTrevorClient({ sessionUrl: SESSION_URL, producerId: PRODUCER_IDS.web, transport });
}

describe("prompt / cancel / switch workflows (M5)", () => {
  it("submitPrompt publishes a user.message carrying the model selection", async () => {
    const rec = recordingTransport();
    await client(rec.transport).prompt("s1", {
      text: "hello",
      provider: "deepseek",
      model: { sourceId: "deepseek", modelId: "chat", reasoning: "high" },
    });
    const published = rec.publishedBy("s1")[0];
    expect(published).toMatchObject({ type: "user.message", producerId: PRODUCER_IDS.web });
    expect(published?.payload).toMatchObject({
      text: "hello",
      provider: "deepseek",
      model: { sourceId: "deepseek", modelId: "chat", reasoning: "high" },
    });
  });

  it("cancel publishes user.cancel (D-094 cancel, not an OS stop/kill signal)", async () => {
    const rec = recordingTransport();
    const c = client(rec.transport);
    await c.cancel("s1", "r1");
    expect(rec.publishedBy("s1")).toEqual([
      { type: "user.cancel", producerId: PRODUCER_IDS.web, payload: { runId: "r1" } },
    ]);
    // The SDK exposes no stop/kill: those are OS signals owned by the CLI/local layer.
    expect((c as unknown as Record<string, unknown>).stop).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).kill).toBeUndefined();
  });

  it("switchModel publishes model.switch.requested into the active run (default initiator auto)", async () => {
    const rec = recordingTransport();
    await client(rec.transport).switchModel("s1", {
      runId: "r1",
      model: { sourceId: "openai", modelId: "gpt", reasoning: "low" },
    });
    expect(rec.publishedBy("s1")[0]).toMatchObject({
      type: "model.switch.requested",
      payload: {
        runId: "r1",
        initiator: "auto",
        model: { sourceId: "openai", modelId: "gpt", reasoning: "low" },
      },
    });
  });

  it("readModelSwitches projects typed model.switched records in seq order", () => {
    const endpoint = (model: string, reasoning: string) => ({ model, reasoning });
    const log = storedLog(
      events.modelSwitched({
        runId: "r1",
        from: endpoint("a", "low"),
        to: endpoint("a", "high"),
        initiator: "manual",
        outcome: "applied",
      }),
      events.modelSwitched({
        runId: "r1",
        from: endpoint("a", "high"),
        to: endpoint("b", "high"),
        initiator: "auto",
        outcome: "blocked",
        reason: "context window too small",
      }),
    );
    const records = readModelSwitches(log);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ runId: "r1", outcome: "applied", initiator: "manual" });
    expect(records[1]).toMatchObject({ outcome: "blocked", reason: "context window too small" });
  });
});

describe("streamTurn (M5)", () => {
  it("correlates and collects one turn's events, resolving on assistant.completed", async () => {
    const rec = recordingTransport();
    rec.seed(
      "s1",
      storedLog(
        events.userMessage({ text: "go", provider: "p" }),
        events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "p" }),
        events.assistantDelta({ runId: "r1", text: "part" }),
        events.assistantCompleted({ runId: "r1", text: "the answer" }),
      ),
    );
    const result = await client(rec.transport).streamTurn("s1", { timeoutMs: 1_000 });
    expect(result.runId).toBe("r1");
    expect(result.text).toBe("the answer");
    expect(result.cancelled).toBe(false);
    expect(result.timedOut).toBe(false);
    // Only the correlated run's events (started..completed) were collected, not the bare user.message.
    expect(result.events.every((e: SessionEvent) => e.payload.runId === "r1")).toBe(true);
  });

  it("resolves timedOut when no completion arrives within the timeout", async () => {
    const rec = recordingTransport();
    rec.seed(
      "s1",
      storedLog(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "p" })),
    );
    const result = await client(rec.transport).streamTurn("s1", { timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.runId).toBe("r1");
  });
});

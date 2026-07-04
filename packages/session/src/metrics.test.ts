import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./event";
import { aggregateUsage, collectTurns, formatUsageReport, sessionUsage } from "./metrics";
import type { ProviderDiagnostic, Usage } from "./protocol";
import { events } from "./protocol";

/**
 * The usage-metrics read model (plan 43). These pin the CONTRACT (M1) and the AGGREGATION (M2): a
 * turn's usage is partitioned per model/reasoning segment split at each applied `model.switched`, never
 * attributed to one model per turn; missing usage is untrusted, not guessed; and a failed turn carries
 * only a typed incident reason, never the provider's free-text detail (redaction).
 */

let seq = 0;
function ev(
  built: { type: string; payload: Record<string, unknown> },
  createdAt = "2026-07-04T00:00:00.000Z",
): SessionEvent {
  seq += 1;
  return {
    sessionId: "s",
    seq,
    eventId: `e${seq}`,
    type: built.type,
    producerId: "host",
    payload: built.payload,
    createdAt,
  };
}

const usage = (input: number, output: number, genMs: number, contextWindow = 128_000): Usage => ({
  input,
  output,
  contextWindow,
  genMs,
});

describe("collectTurns - single-model turn", () => {
  it("attributes a whole non-switching turn to one trusted segment", () => {
    const log = [
      ev(events.userMessage({ text: "hi", provider: "deepseek", reasoning: "high" })),
      ev(
        events.assistantStarted({
          runId: "r1",
          warm: false,
          model: "deepseek-chat",
          provider: "deepseek",
        }),
      ),
      ev(events.assistantProgress({ runId: "r1", usage: usage(1000, 40, 800) })),
      ev(events.assistantCompleted({ runId: "r1", text: "hello", usage: usage(1200, 90, 1500) })),
    ];

    const [turn, ...rest] = collectTurns(log);
    expect(rest).toHaveLength(0);
    expect(turn?.segments).toHaveLength(1);
    expect(turn?.outcome).toBe("completed");
    expect(turn?.trusted).toBe(true);
    const seg = turn?.segments[0];
    expect(seg?.model).toBe("deepseek-chat");
    expect(seg?.reasoning).toBe("high");
    expect(seg?.provider).toBe("deepseek");
    expect(seg?.outputTokens).toBe(90); // the final cumulative output
    expect(seg?.inputPeakTokens).toBe(1200); // the peak context, not a sum
    expect(seg?.genMs).toBe(1500);
    expect(turn?.outputTokens).toBe(90);
    expect(turn?.inputPeakTokens).toBe(1200);
  });
});

describe("collectTurns - per-model-segment split at model.switched (M2)", () => {
  it("partitions a mid-turn switch into two segments by cumulative usage delta", () => {
    // Cumulative output/genMs stream on progress; the switch closes segment A, the completion segment B.
    const log = [
      ev(events.userMessage({ text: "go", provider: "deepseek", reasoning: "low" })),
      ev(
        events.assistantStarted({
          runId: "r1",
          warm: false,
          model: "deepseek-chat",
          provider: "deepseek",
        }),
      ),
      ev(events.assistantProgress({ runId: "r1", usage: usage(100, 10, 500, 64_000) })),
      ev(events.assistantProgress({ runId: "r1", usage: usage(150, 25, 900, 64_000) })), // end of A: 25 out
      ev(
        events.modelSwitched({
          runId: "r1",
          from: { model: "deepseek-chat", reasoning: "low" },
          to: { model: "z-ai-glm", reasoning: "high" },
          initiator: "manual",
          outcome: "applied",
        }),
      ),
      ev(events.assistantProgress({ runId: "r1", usage: usage(200, 40, 1300, 200_000) })),
      ev(
        events.assistantCompleted({
          runId: "r1",
          text: "done",
          usage: usage(220, 55, 1600, 200_000),
        }),
      ),
    ];

    const [turn] = collectTurns(log);
    expect(turn?.switches).toBe(1);
    expect(turn?.segments).toHaveLength(2);

    const [a, b] = turn?.segments ?? [];
    // Segment A: the first model, output/genMs up to the switch (deltas from a zero start).
    expect(a?.model).toBe("deepseek-chat");
    expect(a?.reasoning).toBe("low");
    expect(a?.outputTokens).toBe(25);
    expect(a?.genMs).toBe(900);
    expect(a?.inputPeakTokens).toBe(150);
    expect(a?.contextWindow).toBe(64_000);
    expect(a?.trusted).toBe(true);

    // Segment B: the switched-to model, its OWN delta (55-25 out, 1600-900 ms) - NOT the whole turn.
    expect(b?.model).toBe("z-ai-glm");
    expect(b?.reasoning).toBe("high");
    expect(b?.provider).toBe("deepseek"); // a switch keeps the turn's source
    expect(b?.outputTokens).toBe(30);
    expect(b?.genMs).toBe(700);
    expect(b?.inputPeakTokens).toBe(220);
    expect(b?.contextWindow).toBe(200_000);

    // The turn totals sum output/genMs across segments (== the final cumulative) but PEAK the input.
    expect(turn?.outputTokens).toBe(55);
    expect(turn?.genMs).toBe(1600);
    expect(turn?.inputPeakTokens).toBe(220);

    // The read model splits across two model rows, not one model per turn.
    const summary = aggregateUsage(collectTurns(log));
    expect(summary.byModel.map((m) => m.model)).toEqual(["z-ai-glm", "deepseek-chat"]);
    expect(summary.byModel.find((m) => m.model === "deepseek-chat")?.outputTokens).toBe(25);
    expect(summary.byModel.find((m) => m.model === "z-ai-glm")?.outputTokens).toBe(30);
  });

  it("ignores a blocked switch - it opens no new segment", () => {
    const log = [
      ev(events.assistantStarted({ runId: "r1", warm: false, model: "a", provider: "p" })),
      ev(events.assistantProgress({ runId: "r1", usage: usage(100, 20, 400) })),
      ev(
        events.modelSwitched({
          runId: "r1",
          from: { model: "a" },
          to: { model: "b" },
          initiator: "auto",
          outcome: "blocked",
        }),
      ),
      ev(events.assistantCompleted({ runId: "r1", text: "x", usage: usage(120, 30, 600) })),
    ];

    const [turn] = collectTurns(log);
    expect(turn?.switches).toBe(0);
    expect(turn?.segments).toHaveLength(1);
    expect(turn?.segments[0]?.model).toBe("a");
    expect(turn?.outputTokens).toBe(30);
  });
});

describe("collectTurns - missing data and provider differences", () => {
  it("marks a turn with no reported usage as untrusted with zeroed figures", () => {
    const log = [
      ev(
        events.assistantStarted({
          runId: "r1",
          warm: false,
          model: "local-model",
          provider: "ollama",
        }),
      ),
      ev(events.assistantCompleted({ runId: "r1", text: "hi" })), // no usage from this provider
    ];

    const [turn] = collectTurns(log);
    expect(turn?.trusted).toBe(false);
    expect(turn?.outputTokens).toBe(0);
    expect(turn?.inputPeakTokens).toBe(0);
    expect(turn?.segments[0]?.samples).toBe(0);
    expect(turn?.segments[0]?.contextWindow).toBe(0);
  });

  it("counts provider auto-retries and keeps the turn trusted", () => {
    const log = [
      ev(events.assistantStarted({ runId: "r1", warm: false, model: "m", provider: "p" })),
      ev(events.assistantReconnecting({ runId: "r1", attempt: 1, detail: "reconnecting" })),
      ev(events.assistantReconnecting({ runId: "r1", attempt: 2, detail: "reconnecting" })),
      ev(events.assistantCompleted({ runId: "r1", text: "ok", usage: usage(500, 50, 900) })),
    ];

    const [turn] = collectTurns(log);
    expect(turn?.retries).toBe(2);
    expect(turn?.outcome).toBe("completed");
  });
});

describe("collectTurns - outcomes and redaction", () => {
  const diagnostic: ProviderDiagnostic = {
    provider: "deepseek",
    phase: "model-step",
    reason: "rate_limited",
    retryable: true,
    safeToRetry: false,
    attempt: 3,
    detail: "429 too many requests for key sk-SECRET-1234",
    partials: { textChars: 0, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
  };

  it("maps a diagnostic completion to failed with only the typed reason (no free text)", () => {
    const log = [
      ev(events.assistantStarted({ runId: "r1", warm: false, model: "m", provider: "deepseek" })),
      ev(events.assistantCompleted({ runId: "r1", text: "", diagnostic })),
    ];

    const [turn] = collectTurns(log);
    expect(turn?.outcome).toBe("failed");
    expect(turn?.failureReason).toBe("rate_limited");
    // Redaction: the provider's free-text detail / secret never rides the read model.
    expect(JSON.stringify(turn)).not.toContain("sk-SECRET");
    expect(JSON.stringify(turn)).not.toContain("too many requests");
  });

  it("distinguishes cancelled from failed", () => {
    const log = [
      ev(events.assistantStarted({ runId: "r1", warm: false, model: "m", provider: "p" })),
      ev(events.assistantCompleted({ runId: "r1", text: "", cancelled: true })),
    ];
    expect(collectTurns(log)[0]?.outcome).toBe("cancelled");
  });

  it("emits an in-flight turn for a run with no completion", () => {
    const log = [
      ev(events.assistantStarted({ runId: "r1", warm: false, model: "m", provider: "p" })),
      ev(events.assistantProgress({ runId: "r1", usage: usage(300, 12, 400) })),
    ];
    const [turn] = collectTurns(log);
    expect(turn?.outcome).toBe("in_flight");
    expect(turn?.completedAt).toBeNull();
    expect(turn?.outputTokens).toBe(12);
  });
});

describe("aggregateUsage - rollups, windows, and totals", () => {
  function twoTurns(): SessionEvent[] {
    return [
      ev(
        events.assistantStarted({ runId: "r1", warm: false, model: "m1", provider: "deepseek" }),
        "2026-07-04T01:00:00.000Z",
      ),
      ev(
        events.assistantCompleted({ runId: "r1", text: "a", usage: usage(1000, 40, 500) }),
        "2026-07-04T01:00:01.000Z",
      ),
      ev(
        events.assistantStarted({ runId: "r2", warm: false, model: "m2", provider: "zai" }),
        "2026-07-04T02:00:00.000Z",
      ),
      ev(
        events.assistantCompleted({ runId: "r2", text: "b", usage: usage(2000, 60, 700) }),
        "2026-07-04T02:00:01.000Z",
      ),
    ];
  }

  it("sums output/genMs but PEAKS input across turns and providers", () => {
    const s = sessionUsage(twoTurns());
    expect(s.totals.turns).toBe(2);
    expect(s.totals.completed).toBe(2);
    expect(s.totals.outputTokens).toBe(100); // 40 + 60
    expect(s.totals.genMs).toBe(1200); // 500 + 700
    expect(s.totals.peakInputTokens).toBe(2000); // max, never 3000
    expect(s.byProvider.map((p) => p.provider)).toEqual(["zai", "deepseek"]); // by output desc
    expect(s.byProvider.find((p) => p.provider === "zai")?.outputTokens).toBe(60);
  });

  it("filters by a [from, to) time window", () => {
    const turns = collectTurns(twoTurns());
    const onlyFirst = aggregateUsage(turns, { to: Date.parse("2026-07-04T01:30:00.000Z") });
    expect(onlyFirst.totals.turns).toBe(1);
    expect(onlyFirst.turns[0]?.runId).toBe("r1");

    const onlySecond = aggregateUsage(turns, { from: Date.parse("2026-07-04T01:30:00.000Z") });
    expect(onlySecond.totals.turns).toBe(1);
    expect(onlySecond.turns[0]?.runId).toBe("r2");
  });

  it("is empty and trusted for a log with no turns", () => {
    const s = sessionUsage([ev(events.userMessage({ text: "hi", provider: "p" }))]);
    expect(s.totals.turns).toBe(0);
    expect(s.totals.trusted).toBe(true);
    expect(s.byModel).toHaveLength(0);
    expect(s.incidents).toHaveLength(0);
  });
});

describe("formatUsageReport", () => {
  it("returns the empty-state line for no usage", () => {
    expect(formatUsageReport(sessionUsage([]))).toBe("No usage recorded yet.");
  });

  it("labels an untrusted total with ~ and never sums input", () => {
    const log = [
      ev(events.assistantStarted({ runId: "r1", warm: false, model: "m", provider: "ollama" })),
      ev(events.assistantCompleted({ runId: "r1", text: "hi" })), // untrusted (no usage)
    ];
    const report = formatUsageReport(sessionUsage(log));
    expect(report).toContain("Usage summary");
    expect(report).toContain("Output tokens: ~0");
    expect(report).toContain("Peak context:");
  });
});

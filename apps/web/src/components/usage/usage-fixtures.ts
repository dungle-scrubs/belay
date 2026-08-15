import {
  events,
  type ProviderDiagnostic,
  type SessionEvent,
  sessionUsage,
  type Usage,
} from "@belay/session";

/**
 * Shared usage-summary fixtures: small durable-log builders run through the REAL `sessionUsage`
 * projection, so the story and the jsdom test render the same read model the app derives (no
 * hand-authored `SessionUsage` literal that could drift from the aggregation).
 */

let seq = 0;
function ev(built: { type: string; payload: Record<string, unknown> }): SessionEvent {
  seq += 1;
  return {
    sessionId: "story",
    seq,
    eventId: `e${seq}`,
    type: built.type,
    producerId: "host",
    payload: built.payload,
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

const usage = (input: number, output: number, genMs: number, contextWindow = 128_000): Usage => ({
  input,
  output,
  contextWindow,
  genMs,
});

/** A couple of clean, fully-measured turns on two providers. */
export const typicalUsage = () =>
  sessionUsage([
    ev(events.userMessage({ text: "hi", provider: "deepseek", reasoning: "high" })),
    ev(
      events.assistantStarted({
        runId: "r1",
        warm: false,
        model: "deepseek-chat",
        provider: "deepseek",
      }),
    ),
    ev(events.assistantProgress({ runId: "r1", usage: usage(4200, 120, 3400) })),
    ev(events.assistantCompleted({ runId: "r1", text: "a", usage: usage(4800, 260, 5200) })),
    ev(events.userMessage({ text: "again", provider: "zai", reasoning: "high" })),
    ev(events.assistantStarted({ runId: "r2", warm: true, model: "glm-4.6", provider: "zai" })),
    ev(
      events.assistantCompleted({ runId: "r2", text: "b", usage: usage(9200, 180, 4100, 200_000) }),
    ),
  ]);

/** One turn that switches model mid-turn - the read model splits it into two model rows. */
export const midTurnSwitchUsage = () =>
  sessionUsage([
    ev(events.userMessage({ text: "go", provider: "deepseek", reasoning: "low" })),
    ev(
      events.assistantStarted({
        runId: "r1",
        warm: false,
        model: "deepseek-chat",
        provider: "deepseek",
      }),
    ),
    ev(events.assistantProgress({ runId: "r1", usage: usage(1500, 90, 1800, 64_000) })),
    ev(
      events.modelSwitched({
        runId: "r1",
        from: { model: "deepseek-chat", reasoning: "low" },
        to: { model: "glm-4.6", reasoning: "high" },
        initiator: "manual",
        outcome: "applied",
      }),
    ),
    ev(events.assistantProgress({ runId: "r1", usage: usage(3200, 210, 4600, 200_000) })),
    ev(
      events.assistantCompleted({
        runId: "r1",
        text: "done",
        usage: usage(3400, 320, 6000, 200_000),
      }),
    ),
  ]);

const rateLimit: ProviderDiagnostic = {
  provider: "deepseek",
  phase: "model-step",
  reason: "rate_limited",
  retryable: true,
  safeToRetry: false,
  attempt: 3,
  detail: "sanitized at the boundary - never rendered here",
  partials: { textChars: 0, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
};

/** A session with a retried-then-completed turn and a failed turn - drives the failure/retry rows. */
export const withFailuresUsage = () =>
  sessionUsage([
    ev(
      events.assistantStarted({
        runId: "r1",
        warm: false,
        model: "deepseek-chat",
        provider: "deepseek",
      }),
    ),
    ev(events.assistantReconnecting({ runId: "r1", attempt: 1, detail: "reconnecting" })),
    ev(events.assistantCompleted({ runId: "r1", text: "ok", usage: usage(5000, 140, 3000) })),
    ev(
      events.assistantStarted({
        runId: "r2",
        warm: false,
        model: "deepseek-chat",
        provider: "deepseek",
      }),
    ),
    ev(events.assistantCompleted({ runId: "r2", text: "", diagnostic: rateLimit })),
  ]);

/** A local-model turn whose provider reports no usage - every figure is untrusted (~). */
export const untrustedUsage = () =>
  sessionUsage([
    ev(
      events.assistantStarted({
        runId: "r1",
        warm: false,
        model: "qwen-local",
        provider: "ollama",
      }),
    ),
    ev(events.assistantCompleted({ runId: "r1", text: "hi" })),
  ]);

/** An empty session (no turns). */
export const emptyUsage = () => sessionUsage([]);

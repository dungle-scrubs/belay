import type { ChatMessage, Provider, ProviderEvent } from "@host/providers";
import type { TrevorEventInput } from "@trevor/session";

/**
 * Scripted-turn plumbing for the plan 24 M7 eval and distraction suites: a deterministic
 * provider that calls an exact tool sequence (one call per model step, in order) and then
 * answers, plus readers over the published event stream. The provider tries each scripted call
 * exactly ONCE - it never retries a degraded tool result - which is what lets the distraction
 * regressions assert "one LSP call, then normal work" from the tool.started sequence.
 *
 * Only type-only imports are static here: the fake provider loads lazily at call time, AFTER
 * the test file has bound TREVOR_WORKSPACE (and any TREVOR_LSP_* knobs), because the host's
 * boot/paths and the LSP singleton read the env at first import.
 */

const USAGE = { input: 10, output: 5, contextWindow: 100_000, genMs: 1 };

export interface ScriptedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** A provider that runs each scripted tool call once, in order, then answers with `answer`. */
export async function scriptedProvider(
  calls: readonly ScriptedCall[],
  answer: string,
): Promise<Provider> {
  const { fakeProvider } = await import("../support/fake-provider");
  return fakeProvider({
    step: (messages: readonly ChatMessage[]): ProviderEvent[] => {
      const done = messages.filter((message) => message.role === "tool").length;
      const call = calls[done];
      return call
        ? [
            {
              type: "tool_call",
              call: {
                id: `c${done + 1}`,
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
            { type: "usage", usage: USAGE },
          ]
        : [
            { type: "text", text: answer },
            { type: "usage", usage: USAGE },
          ];
    },
  });
}

/** The published result of the named tool's completion ("" when the tool never completed). */
export function toolResult(events: readonly TrevorEventInput[], name: string): string {
  const completed = events.find(
    (event) => event.type === "tool.completed" && event.payload.name === name,
  );
  return String(completed?.payload.result ?? "");
}

/** Every tool the turn started, in order - the "no further LSP calls" probe. */
export function toolCallNames(events: readonly TrevorEventInput[]): string[] {
  return events
    .filter((event) => event.type === "tool.started")
    .map((event) => String(event.payload.name));
}

/** The terminal completion's text + error ("" / undefined when the turn never completed). */
export function finalAnswer(events: readonly TrevorEventInput[]): {
  readonly text: string;
  readonly error: unknown;
} {
  const completed = events.find((event) => event.type === "assistant.completed");
  return { text: String(completed?.payload.text ?? ""), error: completed?.payload.error };
}

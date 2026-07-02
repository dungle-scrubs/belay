import { publishTurn } from "@host/agent/turn";
import type { ChatMessage, Provider, ProviderError, ProviderEvent, ToolDef } from "@host/providers";
import { Emit } from "@host/transport/services";
import { events, type SessionTransport, type TrevorEventInput } from "@trevor/session";
import { Effect, Layer, Stream } from "effect";

/**
 * The deterministic fake provider: it stands in for a real model so a turn test never
 * depends on a model choosing to call a tool, and never reaches LM Studio or the cloud.
 * This is the host's test seam named in apps/agent-host/AGENTS.md; it lives with the host
 * (not @trevor/test-kit) because it is typed by the host's Provider contract. The e2e
 * workspace reaches it through the `@trevor/agent-host/testing` export.
 */

const usage = { input: 10, output: 5, contextWindow: 1000, genMs: 1 };

export interface FakeProviderOptions {
  readonly id?: string;
  readonly reasoningLevels?: readonly string[];
  readonly capabilities?: {
    readonly images: boolean;
    readonly tools: boolean;
    readonly contextLength: number;
  };
  /** One model step's events, given the conversation so far (default: tool then answer). */
  readonly step?: (messages: readonly ChatMessage[]) => readonly ProviderEvent[];
  /** Full control over the step Stream, for non-terminating / overflow cases. Overrides `step`. */
  readonly stream?: (
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
  ) => Stream.Stream<ProviderEvent, ProviderError>;
}

/** Default behavior: request a bash tool on step 1, answer once the tool result is present. */
function defaultStep(messages: readonly ChatMessage[]): ProviderEvent[] {
  const answered = messages.some((m) => m.role === "tool");
  return answered
    ? [
        { type: "text", text: "Done: " },
        { type: "text", text: "the tool ran." },
        { type: "usage", usage },
      ]
    : [
        { type: "text", text: "Let me run a command. " },
        {
          type: "tool_call",
          call: {
            id: "c1",
            name: "bash",
            arguments: JSON.stringify({ command: "echo hello-from-tool" }),
          },
        },
        { type: "usage", usage },
      ];
}

export function fakeProvider(opts: FakeProviderOptions = {}): Provider {
  const reasoningLevels = opts.reasoningLevels ?? [];
  const caps = opts.capabilities ?? { images: false, tools: true, contextLength: 0 };
  const step = opts.step ?? defaultStep;
  const descriptor = {
    label: "Fake",
    model: "fake-1",
    reasoningLevels,
    defaultReasoning: "off",
    kind: "cloud" as const,
  };
  return {
    id: opts.id ?? "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels,
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => descriptor,
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed(caps),
    warm: () => Effect.void,
    stream: (messages, tools) =>
      opts.stream?.(messages, tools) ?? Stream.fromIterable(step(messages)),
  };
}

/** A collecting Emit layer plus the array it appends every published event to. */
export function collectingEmit(): {
  readonly layer: Layer.Layer<Emit>;
  readonly events: TrevorEventInput[];
} {
  const events: TrevorEventInput[] = [];
  const layer = Layer.succeed(Emit, {
    publish: (event) => Effect.sync(() => void events.push(event)),
  });
  return { layer, events };
}

/** Run a turn against a collecting Emit layer and return the events it published, in order. */
export async function runTurn(
  provider: Provider,
  history: readonly ChatMessage[],
  options: {
    readonly runId: string;
    readonly reasoning?: string;
    readonly loop?: Parameters<typeof publishTurn>[2]["loop"];
  },
): Promise<TrevorEventInput[]> {
  const { layer, events } = collectingEmit();
  await Effect.runPromise(publishTurn(provider, history, options).pipe(Effect.provide(layer)));
  return events;
}

/**
 * An Emit layer that publishes a turn's events to a real session-store / Richter transport,
 * rather than collecting them in memory. This is what makes a cross-service e2e possible: the
 * turn pipeline writes to the durable log and an independent subscriber tails the same stream.
 */
export function transportEmit(
  transport: SessionTransport,
  sessionId: string,
  producerId: string,
): Layer.Layer<Emit> {
  return Layer.succeed(Emit, {
    publish: (event) =>
      Effect.promise(() => {
        // Re-stamp the input through the protocol builder (events.raw) so the publish frame's
        // `{ type, payload }` shares the production envelope pipeline instead of being hand-spread.
        const input = events.raw(event.type, event.payload);
        return transport.publishEvent(sessionId, { ...input, producerId });
      }),
  });
}

/** Run a turn providing a caller-supplied Emit layer (e.g. `transportEmit` for cross-service e2e). */
export async function publishTurnVia(
  layer: Layer.Layer<Emit>,
  provider: Provider,
  history: readonly ChatMessage[],
  options: { readonly runId: string; readonly reasoning?: string },
): Promise<void> {
  await Effect.runPromise(publishTurn(provider, history, options).pipe(Effect.provide(layer)));
}

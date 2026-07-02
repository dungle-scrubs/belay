import { envNumber } from "@host/boot/env";
import type { ChatMessage, Provider } from "@host/providers/index";
import type { ModelCapabilities } from "@host/providers/types";
import { Effect } from "effect";
import { type HistoryImageResolver, resolveHistoryImages } from "./image-resolution";

const MIN_CONTEXT_TOKENS = envNumber("TREVOR_MIN_CONTEXT", 16_384);

export type TurnPreflight =
  | {
      readonly type: "ready";
      readonly warm: boolean;
      readonly caps: ModelCapabilities;
      readonly history: readonly ChatMessage[];
      readonly useTools: boolean;
    }
  | {
      readonly type: "blocked";
      readonly warm: boolean;
      readonly error: string;
    };

export function prepareTurn(
  provider: Provider,
  turnHistory: readonly ChatMessage[],
  options: { readonly resolveImages?: HistoryImageResolver } = {},
): Effect.Effect<TurnPreflight> {
  return Effect.gen(function* () {
    const { warm } = yield* provider.readiness();
    const caps = yield* provider.capabilities();

    if (caps.contextLength > 0 && caps.contextLength < MIN_CONTEXT_TOKENS) {
      return {
        type: "blocked" as const,
        warm,
        error: `Model ${provider.model} supports only ${caps.contextLength} tokens of context, below the ${MIN_CONTEXT_TOKENS} (16k) minimum required to run Trevor. Pick a model with at least 16k of context.`,
      };
    }

    const imageResolver = options.resolveImages ?? resolveHistoryImages;
    const history = caps.images
      ? yield* Effect.promise(() => imageResolver(turnHistory))
      : turnHistory;

    return { type: "ready" as const, warm, caps, history, useTools: caps.tools };
  });
}

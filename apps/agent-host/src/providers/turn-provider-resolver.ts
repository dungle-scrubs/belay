import {
  type DecodedEvent,
  decodeTrevorEvent,
  type ModelRef,
  type SessionEvent,
} from "@trevor/session";
import {
  createModelSourceResolver,
  type ModelSourceResolver,
  type ProviderRegistry,
  type ResolvedTurnProvider,
  type TurnProviderInput,
} from "./model-source-resolver";
import type { Provider } from "./types";

/**
 * Responsible for: resolving the provider/model a durable user.message targets, once, for both
 * compaction preflight and turn startup.
 * Not for: residency, internet refresh, or any side effect of starting a turn.
 */

export interface TurnProviderResolver {
  readonly resolveTurnProvider: (input: TurnProviderInput) => ResolvedPreflightTurnProvider;
  readonly resolveUserMessage: (event: SessionEvent) => ResolvedPreflightTurnProvider | null;
  readonly buildProviderForModel: (
    model: Pick<ModelRef, "sourceId" | "modelId">,
  ) => Provider | null;
}

export interface TurnProviderResolverOptions {
  readonly providers: ProviderRegistry;
  readonly defaultProviderKey: string;
}

type UserMessageDecoded = Extract<DecodedEvent, { readonly type: "user.message" }>;

export interface ResolvedPreflightTurnProvider extends ResolvedTurnProvider {
  readonly budgetWindow?: number;
}

function inputFromUserMessage(decoded: UserMessageDecoded): TurnProviderInput {
  return {
    provider: decoded.provider,
    reasoning: decoded.reasoning,
    ...(decoded.model ? { model: decoded.model } : {}),
  };
}

export function createTurnProviderResolver(
  options: TurnProviderResolverOptions,
): TurnProviderResolver {
  const sourceResolver: ModelSourceResolver = createModelSourceResolver(options);

  function providerBudgetWindow(provider: Provider): number | undefined {
    const info = provider.debugInfo?.();
    const value =
      typeof info?.served === "number"
        ? info.served
        : typeof info?.contextWindow === "number"
          ? info.contextWindow
          : undefined;
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  function resolveTurnProvider(input: TurnProviderInput): ResolvedPreflightTurnProvider {
    const resolved = sourceResolver.resolveTurnProvider(input);
    const budgetWindow = providerBudgetWindow(resolved.provider);
    return budgetWindow === undefined ? resolved : { ...resolved, budgetWindow };
  }

  function resolveUserMessage(event: SessionEvent): ResolvedPreflightTurnProvider | null {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type !== "user.message") {
      return null;
    }
    return resolveTurnProvider(inputFromUserMessage(decoded));
  }

  return {
    resolveTurnProvider,
    resolveUserMessage,
    buildProviderForModel: sourceResolver.buildProviderForModel,
  };
}

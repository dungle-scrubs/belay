import { type ModelRef, resolveUserTurnModel } from "@trevor/session";
import { buildSourceProvider } from "./catalog";
import type { Provider } from "./types";

/**
 * Resolves turn-time model/source selection through one boundary.
 *
 * Responsible for: preferring structured catalog ModelRefs, falling back to legacy provider keys,
 * and preserving the default provider behavior.
 * Not for: building the catalog read model or provider adapter internals.
 */

export type ProviderRegistry = Readonly<Record<string, Provider>>;

export interface ModelSourceResolverOptions {
  readonly providers: ProviderRegistry;
  readonly defaultProviderKey: string;
}

export interface TurnProviderInput {
  readonly model?: ModelRef;
  readonly provider?: string;
  readonly reasoning?: string;
}

export interface ResolvedTurnProvider {
  readonly provider: Provider;
  readonly model: ReturnType<typeof resolveUserTurnModel>;
  readonly source: "catalog" | "legacy" | "default";
}

export interface ModelSourceResolver {
  readonly pickProvider: (key: unknown) => Provider;
  readonly resolveTurnProvider: (input: TurnProviderInput) => ResolvedTurnProvider;
  readonly buildProviderForModel: (
    model: Pick<ModelRef, "sourceId" | "modelId">,
  ) => Provider | null;
}

export function createModelSourceResolver(
  options: ModelSourceResolverOptions,
): ModelSourceResolver {
  const { providers, defaultProviderKey } = options;

  function pickProvider(key: unknown): Provider {
    const requestedKey = typeof key === "string" ? key : undefined;
    const byKey = requestedKey ? providers[requestedKey] : undefined;
    const provider = byKey ?? providers[defaultProviderKey];
    if (!provider) {
      throw new Error(`no provider for "${String(key)}" and no "${defaultProviderKey}" default`);
    }
    return provider;
  }

  function buildProviderForModel(model: Pick<ModelRef, "sourceId" | "modelId">): Provider | null {
    return buildSourceProvider(model.sourceId, model.modelId);
  }

  function resolveTurnProvider(input: TurnProviderInput): ResolvedTurnProvider {
    const model = resolveUserTurnModel(input);
    const catalogProvider = input.model ? buildProviderForModel(input.model) : null;
    if (catalogProvider) {
      return { provider: catalogProvider, model, source: "catalog" };
    }
    const hasLegacyProvider = typeof model.sourceId === "string" && providers[model.sourceId];
    const legacyProvider = pickProvider(model.sourceId);
    return {
      provider: legacyProvider,
      model,
      source: hasLegacyProvider ? "legacy" : "default",
    };
  }

  return { pickProvider, resolveTurnProvider, buildProviderForModel };
}

export function pickProviderFromRegistry(
  providers: ProviderRegistry,
  key: unknown,
  defaultProviderKey: string,
): Provider {
  return createModelSourceResolver({ providers, defaultProviderKey }).pickProvider(key);
}

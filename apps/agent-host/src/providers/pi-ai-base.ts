import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { msg } from "@host/transport/messages";
import { Effect, Stream } from "effect";
import { ProviderAuthError } from "./errors";
import { resolveContextWindow } from "./model-metadata-overrides";
import { streamPiAiModel } from "./pi-ai";
import { deriveModelShape } from "./pi-model";
import type { CredentialResolver } from "./provider-auth";
import { defaultReasoningLevel } from "./reasoning-policy";
import {
  type ChatMessage,
  DescribableProvider,
  type ModelCapabilities,
  type ProviderError,
  type ProviderEvent,
  type Readiness,
  type ToolDef,
} from "./types";

/**
 * The shared body of the two pi-ai-backed CLOUD providers (Codex over OAuth; DeepSeek/GLM/
 * MiniMax over a static key). It owns the `stream` / `readiness` / `capabilities` / `warm`
 * template and the constructor's thinking-option + image-support derivation - the control
 * flow both providers used to duplicate. Only two things vary, and both are injected:
 *   - `credentials` - the CredentialResolver (OAuth refresh vs static key), and
 *   - `resolveModel` - how the pi-ai Model is looked up (registry lookup vs sibling synthesis).
 * Everything is passed as params (no abstract methods read by the constructor), so a subclass's
 * own config closures resolve before this base runs. Cloud providers are always warm; readiness
 * is just "can we resolve a credential". This base owns the pi-ai integration; the concrete
 * classes (codex.ts / pi-key.ts) are reduced to strategy + config.
 *
 * Responsible for: the shared cloud-provider template (stream/readiness/capabilities/warm) over
 * pi-ai, parameterized by credential strategy and model resolution.
 * Not for: stream event mapping (pi-ai.ts) or credential storage/reads (provider-auth.ts).
 */
export interface PiAiProviderParams {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  /** How the bearer key is obtained (OAuth refresh vs static key). */
  readonly credentials: CredentialResolver;
  /** Resolves the pi-ai Model (registry lookup or sibling synthesis); may throw if unresolvable. */
  readonly resolveModel: () => Model<Api>;
  /** Thinking shape to assume when the model isn't (yet) in pi-ai's registry, so the host still
   *  starts: the levels to advertise and whether to claim image support. */
  readonly fallback: { readonly levels: readonly string[]; readonly images: boolean };
  /** Picks the default reasoning level from the resolved (or fallback) levels. Optional: defaults to
   *  the shared `defaultReasoningLevel` (medium > high > off > lowest); set it only for a genuinely
   *  different preference. */
  readonly pickDefaultReasoning?: (levels: readonly string[]) => string;
}

export class PiAiProviderBase extends DescribableProvider {
  readonly kind = "cloud" as const;
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
  private readonly images: boolean;
  private readonly credentials: CredentialResolver;
  private readonly resolveModel: () => Model<Api>;

  constructor(params: PiAiProviderParams) {
    super();
    this.id = params.id;
    this.label = params.label;
    this.model = params.model;
    this.credentials = params.credentials;
    this.resolveModel = params.resolveModel;
    // Derive thinking options + image support from the pi-ai model once via the shared derivation
    // (pi-model.ts); a registry miss falls back to the declared shape, so the host still starts.
    const shape = deriveModelShape(params.resolveModel, params.fallback);

    this.reasoningLevels = shape.levels;
    this.images = shape.images;
    this.defaultReasoning = (params.pickDefaultReasoning ?? defaultReasoningLevel)(shape.levels);
  }

  /** Image support from the registry (or the fallback); tools always supported; context
   *  unknown (0) - cloud models carry ample context, so the turn's context guard skips it. */
  capabilities(): Effect.Effect<ModelCapabilities> {
    return Effect.succeed({ images: this.images, tools: true, contextLength: 0 });
  }

  readiness(): Effect.Effect<Readiness> {
    return Effect.promise(async () => {
      const apiKey = await this.credentials.resolveApiKey().catch(() => null);
      return { ready: apiKey !== null, warm: true };
    });
  }

  warm(): Effect.Effect<void> {
    // Cloud-hosted: nothing to load.
    return Effect.void;
  }

  stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError> {
    // Resolve the key up front so a missing/refused-credential failure rides the stream's typed
    // error channel (ProviderAuthError) instead of throwing out of the model thunk.
    return Stream.unwrap(
      Effect.tryPromise({
        try: () => this.credentials.resolveApiKey(),
        catch: (cause) =>
          cause instanceof ProviderAuthError
            ? cause
            : new ProviderAuthError({ provider: this.id, detail: msg(cause), cause }),
      }).pipe(
        Effect.map((apiKey) => {
          const model = this.resolveModel();
          return streamPiAiModel(Effect.succeed(model), {
            messages,
            tools,
            apiKey,
            // The EFFECTIVE window, through the single resolver (03.2 D-004): a confirmed static
            // override or a learned window corrects a stale bundled value HERE, so the turn - and the
            // compaction trigger reading its `usage.contextWindow` - budgets against the real ceiling,
            // not just the catalog display.
            contextWindow:
              resolveContextWindow(model.id, model.contextWindow) ?? model.contextWindow,
            // pi-ai clamps an out-of-range level to the nearest supported one.
            reasoning: (reasoning ?? this.defaultReasoning) as ThinkingLevel,
            provider: this.id,
          });
        }),
      ),
    );
  }
}

export function piAiProvider(params: PiAiProviderParams): PiAiProviderBase {
  return new PiAiProviderBase(params);
}

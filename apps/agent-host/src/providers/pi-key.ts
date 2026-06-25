import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type Api,
  getModel,
  getModels,
  getSupportedThinkingLevels,
  type Model,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import { Effect, Stream } from "effect";
import { msg } from "../tools/shared";
import { ProviderAuthError } from "./errors";
import { streamPiAiModel } from "./pi-ai";
import {
  type ChatMessage,
  DescribableProvider,
  type ModelCapabilities,
  type ProviderError,
  type ProviderEvent,
  type Readiness,
  type ToolDef,
} from "./types";

const AUTH_PATH = `${homedir()}/.pi/auth.json`;

/** Length of the common leading run of two ids (for picking the closest sibling model). */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

export interface PiKeyConfig {
  /** Host registry id / display key (e.g. "deepseek", "glm", "minimax"). */
  readonly id: string;
  /** pi-ai provider id whose registry the model lives in (e.g. "deepseek", "zai", "minimax"). */
  readonly piProvider: string;
  /** Top-level key in ~/.pi/auth.json holding `{ key }` for this provider. */
  readonly authName: string;
  /** A model id from the pi-ai `piProvider` registry. */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/**
 * A cloud provider reached through pi-ai with a bearer API key from ~/.pi/auth.json
 * (DeepSeek, Z.ai/GLM, MiniMax). It mirrors CodexProvider, but the credential is a static
 * key (`auth.json[authName].key`) rather than an OAuth token to refresh, so the registry
 * lookup + streaming is shared via streamPiAiModel and only key resolution differs.
 * Tools + reasoning ride the pi-ai context; reasoning options and image support come from
 * the pi-ai model. A missing key fails readiness and the stream as ProviderAuthError; a
 * key the API rejects (expired/revoked) surfaces the same way from the stream (pi-ai.ts
 * classifies auth-status errors), so a bad key reads as "auth failed", never a hang.
 */
export class PiKeyProvider extends DescribableProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
  readonly kind = "cloud" as const;
  private readonly piProvider: string;
  private readonly authName: string;
  private readonly images: boolean;

  constructor(config: PiKeyConfig) {
    super();
    this.id = config.id;
    this.label = config.label;
    this.model = config.model;
    this.piProvider = config.piProvider;
    this.authName = config.authName;
    // Derive thinking options + image support from the pi-ai model once; fall back to a
    // minimal off/high shape if the id is not in pi-ai's registry, so the host still starts.
    let levels: readonly string[];
    let images: boolean;
    try {
      const model = this.piModel();
      levels = getSupportedThinkingLevels(model);
      images = model.input?.includes("image") ?? false;
    } catch {
      levels = ["off", "high"];
      images = false;
    }
    this.reasoningLevels = levels;
    this.images = images;
    this.defaultReasoning = levels.includes("medium")
      ? "medium"
      : levels.includes("high")
        ? "high"
        : (levels[Math.floor(levels.length / 2)] ?? "off");
  }

  /** Image support from the registry; tools always supported; context unknown (0). */
  capabilities(): Effect.Effect<ModelCapabilities> {
    return Effect.succeed({ images: this.images, tools: true, contextLength: 0 });
  }

  readiness(): Effect.Effect<Readiness> {
    return Effect.promise(async () => {
      const apiKey = await this.resolveApiKey().catch(() => null);
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
    // Resolve the key up front so a missing-key failure rides the stream's typed error
    // channel (ProviderAuthError) instead of throwing out of the model thunk.
    return Stream.unwrap(
      Effect.tryPromise({
        try: () => this.resolveApiKey(),
        catch: (cause) =>
          cause instanceof ProviderAuthError
            ? cause
            : new ProviderAuthError({ provider: this.id, detail: msg(cause), cause }),
      }).pipe(
        Effect.map((apiKey) => {
          const model = this.piModel();
          return streamPiAiModel(Effect.succeed(model), {
            messages,
            tools,
            apiKey,
            contextWindow: model.contextWindow,
            reasoning: (reasoning ?? this.defaultReasoning) as ThinkingLevel,
            provider: this.id,
          });
        }),
      ),
    );
  }

  /**
   * The pi-ai model for this provider. The provider/model ids are configurable at runtime;
   * pi-ai validates them against its registry, so the literal casts only satisfy getModel's
   * strict typing (mirrors CodexProvider).
   *
   * If the id is NOT in the registry (a model newer than the installed pi-ai - e.g.
   * glm-5.2 against a registry that only knows glm-5.1), we synthesize it: clone the
   * closest sibling from the same provider (same api/baseUrl/reasoning shape) and override
   * the id, so a just-released model still resolves. The request carries the new id; if the
   * backend doesn't actually serve it, that surfaces as a stream error, not a silent stall.
   */
  private piModel(): Model<Api> {
    // getModel returns undefined (not a throw) for an id absent from the registry; some
    // providers throw instead, so handle both before falling through to synthesis.
    try {
      const found = getModel(this.piProvider as "deepseek", this.model as "deepseek-v4-pro");
      if (found) {
        return found as Model<Api>;
      }
    } catch {
      // fall through to synthesis
    }
    const siblings = getModels(this.piProvider as "deepseek") as Model<Api>[];
    const base = siblings.reduce<Model<Api> | undefined>((best, model) => {
      if (!best) {
        return model;
      }
      return sharedPrefix(model.id, this.model) >= sharedPrefix(best.id, this.model) ? model : best;
    }, undefined);
    if (!base) {
      throw new Error(`no models registered for pi-ai provider "${this.piProvider}"`);
    }
    return { ...base, id: this.model };
  }

  private async resolveApiKey(): Promise<string> {
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(await readFile(AUTH_PATH, "utf8")) as Record<string, unknown>;
    } catch (cause) {
      throw new ProviderAuthError({
        provider: this.id,
        detail: `cannot read ${AUTH_PATH} (add a ${this.authName} key with the pi CLI)`,
        cause,
      });
    }
    const entry = auth[this.authName] as { key?: unknown } | undefined;
    if (!entry || typeof entry.key !== "string" || entry.key.length === 0) {
      throw new ProviderAuthError({
        provider: this.id,
        detail: `no ${this.authName}.key in ${AUTH_PATH}`,
      });
    }
    return entry.key;
  }
}

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Model } from "@mariozechner/pi-ai";
import { Effect, Stream } from "effect";
import { debug, log, warn } from "../log";
import { msg } from "../tools/shared";
import { ModelLoadError, ProviderUnavailable } from "./errors";
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

const execAsync = promisify(exec);
/** LM Studio's own CLI, used to (re)load a model at a chosen context length. */
const LMS_BIN = process.env.LMS_BIN ?? "lms";

export interface LmStudioConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  readonly url: string;
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
  /**
   * Per-model context-window cap (tokens). Pins this model's load below its
   * native ceiling - e.g. to make overflow reachable in smoke runs. Takes
   * precedence over the global LMSTUDIO_MAX_CONTEXT; unset = model max.
   */
  readonly maxContext?: number;
}

/** Context window assumed before the running model reports its own (tokens). */
const DEFAULT_CONTEXT_WINDOW = 8192;

/** One LM Studio model's load state, as the native /api/v0 endpoint reports it. */
interface ModelInfo {
  /** "vlm" for a vision-language model, "llm" for text-only, "embeddings", etc. */
  type?: string;
  /** Feature flags LM Studio reports, e.g. ["tool_use"]. */
  capabilities?: readonly string[];
  state?: string;
  loaded_context_length?: number;
  max_context_length?: number;
}

/**
 * Local LM Studio provider. Streaming and tool calling go through pi-ai's
 * openai-completions adapter (LM Studio speaks the OpenAI chat API). Load state
 * (readiness/warm) and the real context window come from LM Studio's native
 * /api/v0 endpoint, which pi-ai does not model.
 */
export class LmStudioProvider extends DescribableProvider {
  readonly id = "lmstudio";
  readonly kind = "local" as const;
  readonly label: string;
  readonly model: string;
  /** Local qwen thinking is binary (enable_thinking on/off); "off" = no reasoning. */
  readonly reasoningLevels = ["off", "on"] as const;
  readonly defaultReasoning = "off";
  /** Vision (`type: "vlm"`) and tools (`tool_use`) learned from the loaded model's record. */
  private vision = false;
  private tools = true;
  private learned = false;
  /** LMSTUDIO_VISION forces image support on/off; unset = auto-detect from the model type. */
  private readonly visionOverride: boolean | null;
  private readonly url: string;
  private readonly native: string;
  /** Effective context window currently served (tokens); learned from model info. */
  private contextWindow = 0;
  /** The model's native max context length (tokens; its ceiling regardless of load).
   *  The 16k minimum-to-run guard checks this, not the served window. */
  private nativeContext = 0;
  /** Upper bound on the context we load at (config.maxContext or LMSTUDIO_MAX_CONTEXT); default = model max. */
  private readonly contextCap: number;
  /** In-flight ensureMaxContext, so concurrent turns share one (re)load. */
  private ensuring: Promise<number> | null = null;
  /** Wall-time of the last successful (re)load, ms; surfaced via debugInfo. */
  private lastReloadMs: number | null = null;
  /** Why the model isn't at max context (unreachable / lms load failed), or null if it is. */
  private lastError: ProviderUnavailable | ModelLoadError | null = null;

  constructor(config: LmStudioConfig) {
    super();
    this.url = config.url;
    this.model = config.model;
    this.label = config.label;
    this.native = new URL("/api/v0", config.url).toString();
    this.contextCap =
      config.maxContext ?? (Number(process.env.LMSTUDIO_MAX_CONTEXT) || Number.POSITIVE_INFINITY);
    const v = process.env.LMSTUDIO_VISION;
    this.visionOverride =
      v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : null;
  }

  /** This model's load state from LM Studio's native endpoint, or null if unreachable. */
  private async fetchModelInfo(): Promise<ModelInfo | null> {
    try {
      const response = await fetch(`${this.native}/models/${encodeURIComponent(this.model)}`);
      if (!response.ok) {
        // Reachable but no usable answer (model id unknown / server error) - distinct from
        // the network failure below, and worth seeing under TREVOR_DEBUG=lmstudio.
        debug("lmstudio", "model info not ok", { model: this.model, status: response.status });
        return null;
      }
      const info = (await response.json()) as ModelInfo;
      this.vision = info.type === "vlm";
      this.tools = info.capabilities?.includes("tool_use") ?? this.tools;
      this.nativeContext = info.max_context_length ?? this.nativeContext;
      this.learned = true;
      return info;
    } catch (cause) {
      debug("lmstudio", "model info unreachable", { model: this.model, error: msg(cause) });
      return null;
    }
  }

  readiness(): Effect.Effect<Readiness> {
    return Effect.promise(async () => {
      const info = await this.fetchModelInfo();
      if (!info) {
        return { ready: false, warm: false };
      }
      // Track the context LM Studio actually serves so the usage display and overflow
      // detection match reality (ensureMaxContext loads it at the model's ceiling).
      this.contextWindow =
        info.loaded_context_length ?? info.max_context_length ?? this.contextWindow;
      return { ready: true, warm: info.state === "loaded" };
    });
  }

  /** Whether images are sent to the model: the env override, else the detected VLM flag. */
  private get visionEnabled(): boolean {
    return this.visionOverride ?? this.vision;
  }

  /** Vision + tool support. readiness()/ensureMaxContext() refresh the record each turn, so
   *  this only fetches when nothing has yet (e.g. a standalone probe). */
  capabilities(): Effect.Effect<ModelCapabilities> {
    return Effect.promise(async () => {
      if (!this.learned) {
        await this.fetchModelInfo();
      }
      return { images: this.visionEnabled, tools: this.tools, contextLength: this.nativeContext };
    });
  }

  /**
   * Ensures the model is loaded at its maximum context. LM Studio defaults a JIT load
   * to a small window (often 8k), so we (re)load it at max_context_length via the lms
   * CLI - unload first, since `lms load` otherwise spawns a second instance - then use
   * the context LM Studio actually serves. De-duped against concurrent turns, and
   * best-effort: if lms is unavailable it leaves the current load and reports that.
   */
  private async ensureMaxContext(): Promise<number> {
    if (this.ensuring) {
      return this.ensuring;
    }
    this.ensuring = (async () => {
      const info = await this.fetchModelInfo();
      const max = info?.max_context_length;
      if (!max) {
        // Unreachable, or the model reports no ceiling: leave the load alone and serve
        // whatever we last knew. Record why so /doctor and the next turn can see it.
        const served = this.contextWindow || DEFAULT_CONTEXT_WINDOW;
        this.lastError = new ProviderUnavailable({
          provider: this.id,
          detail: info ? "model reported no max_context_length" : "LM Studio not reachable",
        });
        warn("lmstudio", "cannot size context, serving fallback", {
          model: this.model,
          served,
          reason: this.lastError.message,
        });
        return served;
      }
      const target = Math.min(max, this.contextCap);
      if (info.state === "loaded" && info.loaded_context_length === target) {
        this.lastError = null;
        this.contextWindow = target;
        return target;
      }
      const startedAt = Date.now();
      log("lmstudio", "loading model at max context", {
        model: this.model,
        target,
        from: info.loaded_context_length ?? "unloaded",
        reload: info.state === "loaded",
      });
      try {
        const key = JSON.stringify(this.model);
        if (info.state === "loaded") {
          await execAsync(`${LMS_BIN} unload ${key}`);
        }
        await execAsync(`${LMS_BIN} load ${key} -c ${target} -y`, { timeout: 300_000 });
        this.contextWindow = target;
        this.lastError = null;
        this.lastReloadMs = Date.now() - startedAt;
        log("lmstudio", "model loaded", {
          model: this.model,
          context: target,
          ms: this.lastReloadMs,
        });
      } catch (cause) {
        // Best-effort: lms is missing or the load failed. Keep serving the current load
        // (often the 8k JIT default) and record the typed reason rather than swallowing it -
        // this is exactly the silent fallback that surfaces later as a thinking overflow.
        this.lastError = new ModelLoadError({ provider: this.id, detail: msg(cause), cause });
        this.contextWindow = info.loaded_context_length ?? this.contextWindow;
        warn("lmstudio", "load failed, keeping current context", {
          model: this.model,
          served: this.contextWindow || DEFAULT_CONTEXT_WINDOW,
          target,
          error: msg(cause),
        });
      }
      return this.contextWindow || DEFAULT_CONTEXT_WINDOW;
    })();
    try {
      return await this.ensuring;
    } finally {
      this.ensuring = null;
    }
  }

  /** Pre-load the model at its max context so the first turn doesn't pay for it. */
  warm(): Effect.Effect<void> {
    return Effect.promise(() => this.ensureMaxContext()).pipe(Effect.asVoid);
  }

  /** Load/context state for /doctor: what we serve, the cap, and why if not at max. */
  debugInfo(): Record<string, unknown> {
    return {
      served: this.contextWindow || null,
      cap: Number.isFinite(this.contextCap) ? this.contextCap : "model-max",
      reloading: this.ensuring !== null,
      lastReloadMs: this.lastReloadMs,
      lastError: this.lastError ? this.lastError.message : null,
    };
  }

  stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError> {
    // ensureMaxContext is async (and best-effort, never fails), so unwrap it into the
    // stream; the model is then built against the context LM Studio actually serves, and
    // the same served window feeds the stream options.
    return Stream.unwrap(
      Effect.promise(() => this.ensureMaxContext()).pipe(
        Effect.map((contextWindow) => {
          // qwen is binary. The qwen thinking format sends `enable_thinking` derived from
          // the reasoning level, so we always declare reasoning + that format and let the
          // level decide: "off" -> enable_thinking:false (qwen thinks by default otherwise),
          // anything else -> enable_thinking:true. thinkingFormat must be explicit since a
          // localhost baseUrl gives pi-ai nothing to auto-detect from.
          const thinking = reasoning !== undefined && reasoning !== "off";
          const model: Model<"openai-completions"> = {
            id: this.model,
            name: this.model,
            api: "openai-completions",
            provider: "lmstudio",
            baseUrl: this.url,
            reasoning: true,
            input: this.visionEnabled ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens: contextWindow,
            compat: { thinkingFormat: "qwen" },
          };
          // LM Studio ignores the key, but pi-ai requires a non-empty one. With the qwen
          // format + model.reasoning, omitting the level (undefined) sends enable_thinking:
          // false; "high" sends true. "off" isn't a pi-ai ThinkingLevel, so undefined is it.
          return streamPiAiModel(Effect.succeed(model), {
            messages,
            tools,
            apiKey: "lm-studio",
            contextWindow,
            reasoning: thinking ? "high" : undefined,
            provider: this.id,
          });
        }),
      ),
    );
  }
}

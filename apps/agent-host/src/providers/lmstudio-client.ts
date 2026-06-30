import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Model } from "@earendil-works/pi-ai/compat";
import { debug, log, warn } from "../log";
import { msg } from "../messages";
import { ModelLoadError, ProviderUnavailable } from "./errors";
import { classifyProviderFailure, redactSecrets } from "./failure-taxonomy";
import {
  type LmStudioModelRecord,
  lmStudioIsVision,
  lmStudioSupportsTools,
  parseLmStudioModel,
} from "./lmstudio-native";
import type { ModelCapabilities, Readiness } from "./types";

const execAsync = promisify(exec);

/** Context window assumed before the running model reports its own (tokens). */
const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * The LM Studio load lifecycle, split out of LmStudioProvider so the provider is a thin Provider
 * shim and this owns everything LM-Studio-specific: probing the native /api/v0 endpoint, learning
 * the model's vision/tools/context capabilities, and (re)loading the model at its max context via
 * the `lms` CLI - de-duped against concurrent turns, best-effort, with the last reload time and the
 * typed last-error retained for /doctor. It takes EXPLICIT config (no env reads); the caller's
 * factory resolves LMSTUDIO_* into it. The provider talks the Effect/Provider interface; this talks
 * promises + HTTP/CLI.
 */
export interface LmStudioClientConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  readonly url: string;
  readonly model: string;
  /** Upper bound on the context to load at (tokens); Infinity = the model's own max. */
  readonly contextCap: number;
  /** Image support: true/false forces it, null = auto-detect from the model type. */
  readonly visionOverride: boolean | null;
  /** LM Studio's CLI binary, used to (re)load a model at a chosen context length. */
  readonly lmsBin: string;
  /** Provider id for the typed errors this raises (matches the owning provider). */
  readonly providerId: string;
}

export class LmStudioClient {
  private readonly native: string;
  /** Vision (`type: "vlm"`) and tools (`tool_use`) learned from the loaded model's record. */
  private vision = false;
  private supportsTools = true;
  private learned = false;
  /** Effective context window currently served (tokens); learned from model info. */
  private contextWindow = 0;
  /** The model's native max context length (tokens; its ceiling regardless of load).
   *  The 16k minimum-to-run guard checks this, not the served window. */
  private nativeContext = 0;
  /** In-flight ensureMaxContext, so concurrent turns share one (re)load. */
  private ensuring: Promise<number> | null = null;
  /** Wall-time of the last successful (re)load, ms; surfaced via debugInfo. */
  private lastReloadMs: number | null = null;
  /** Why the model isn't at max context (unreachable / lms load failed), or null if it is. */
  private lastError: ProviderUnavailable | ModelLoadError | null = null;

  constructor(private readonly config: LmStudioClientConfig) {
    this.native = new URL("/api/v0", config.url).toString();
  }

  /** Whether images are sent to the model: the env override, else the detected VLM flag. */
  get visionEnabled(): boolean {
    return this.config.visionOverride ?? this.vision;
  }

  /** This model's load state from LM Studio's native endpoint, or null if unreachable. Parses the
   *  native record through the shared {@link parseLmStudioModel}, so the catalog list fetch and this
   *  per-model lookup decode `/api/v0` identically. */
  private async fetchModelInfo(): Promise<LmStudioModelRecord | null> {
    try {
      const response = await fetch(
        `${this.native}/models/${encodeURIComponent(this.config.model)}`,
      );
      if (!response.ok) {
        // Reachable but no usable answer (model id unknown / server error) - distinct from
        // the network failure below, and worth seeing under TREVOR_DEBUG=lmstudio.
        debug("lmstudio", "model info not ok", {
          model: this.config.model,
          status: response.status,
        });
        return null;
      }
      const info = parseLmStudioModel(await response.json());
      if (!info) {
        return null;
      }
      this.vision = lmStudioIsVision(info);
      // Keep the assumed-tools default when LM Studio reports no capability list; only a present list
      // overrides it (an empty list genuinely means no tool use).
      this.supportsTools = info.capabilities ? lmStudioSupportsTools(info) : this.supportsTools;
      this.nativeContext = info.maxContextLength ?? this.nativeContext;
      this.learned = true;
      return info;
    } catch (cause) {
      debug("lmstudio", "model info unreachable", { model: this.config.model, error: msg(cause) });
      return null;
    }
  }

  /** Reachability + warm state for the provider's readiness(). Tracks the served context so the
   *  usage display and overflow detection match what LM Studio actually serves. */
  async probe(): Promise<Readiness> {
    const info = await this.fetchModelInfo();
    if (!info) {
      return { ready: false, warm: false };
    }
    this.contextWindow = info.loadedContextLength ?? info.maxContextLength ?? this.contextWindow;
    return { ready: true, warm: info.state === "loaded" };
  }

  /** Vision + tool support + native ceiling for the provider's capabilities(). readiness()/
   *  ensureMaxContext() refresh the record each turn, so this only fetches when nothing has yet. */
  async capabilities(): Promise<ModelCapabilities> {
    if (!this.learned) {
      await this.fetchModelInfo();
    }
    return {
      images: this.visionEnabled,
      tools: this.supportsTools,
      contextLength: this.nativeContext,
    };
  }

  /**
   * Ensures the model is loaded at its maximum context. LM Studio defaults a JIT load to a small
   * window (often 8k), so we (re)load it at max_context_length via the lms CLI - unload first, since
   * `lms load` otherwise spawns a second instance - then use the context LM Studio actually serves.
   * De-duped against concurrent turns, and best-effort: if lms is unavailable it leaves the current
   * load and reports that. Returns the served context window.
   */
  async ensureMaxContext(): Promise<number> {
    if (this.ensuring) {
      return this.ensuring;
    }
    this.ensuring = (async () => {
      const info = await this.fetchModelInfo();
      const max = info?.maxContextLength;
      if (!max) {
        // Unreachable, or the model reports no ceiling: leave the load alone and serve whatever we
        // last knew. Record why so /doctor and the next turn can see it.
        const served = this.contextWindow || DEFAULT_CONTEXT_WINDOW;
        this.lastError = new ProviderUnavailable({
          provider: this.config.providerId,
          detail: info ? "model reported no max_context_length" : "LM Studio not reachable",
        });
        warn("lmstudio", "cannot size context, serving fallback", {
          model: this.config.model,
          served,
          reason: this.lastError.message,
        });
        return served;
      }
      const target = Math.min(max, this.config.contextCap);
      if (info.state === "loaded" && info.loadedContextLength === target) {
        this.lastError = null;
        this.contextWindow = target;
        return target;
      }
      const startedAt = Date.now();
      log("lmstudio", "loading model at max context", {
        model: this.config.model,
        target,
        from: info.loadedContextLength ?? "unloaded",
        reload: info.state === "loaded",
      });
      try {
        const key = JSON.stringify(this.config.model);
        if (info.state === "loaded") {
          await execAsync(`${this.config.lmsBin} unload ${key}`);
        }
        await execAsync(`${this.config.lmsBin} load ${key} -c ${target} -y`, { timeout: 300_000 });
        this.contextWindow = target;
        this.lastError = null;
        this.lastReloadMs = Date.now() - startedAt;
        log("lmstudio", "model loaded", {
          model: this.config.model,
          context: target,
          ms: this.lastReloadMs,
        });
      } catch (cause) {
        // Best-effort: lms is missing or the load failed. Keep serving the current load (often the
        // 8k JIT default) and record the typed reason rather than swallowing it - this is exactly
        // the silent fallback that surfaces later as a thinking overflow.
        this.lastError = new ModelLoadError({
          provider: this.config.providerId,
          detail: msg(cause),
          cause,
        });
        this.contextWindow = info.loadedContextLength ?? this.contextWindow;
        warn("lmstudio", "load failed, keeping current context", {
          model: this.config.model,
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

  /** The pi-ai model for the current load: LM Studio over the OpenAI-completions API, qwen thinking
   *  format, vision input when enabled, sized to the served `contextWindow`. */
  buildModel(contextWindow: number): Model<"openai-completions"> {
    return {
      id: this.config.model,
      name: this.config.model,
      api: "openai-completions",
      provider: "lmstudio",
      baseUrl: this.config.url,
      reasoning: true,
      input: this.visionEnabled ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: contextWindow,
      compat: { thinkingFormat: "qwen" },
    };
  }

  /** Load/context state for /doctor: what we serve, the cap, and why if not at max. The last error
   *  is surfaced WITH its normalized taxonomy class (D-076 M6) and redacted of any secret first. */
  debugInfo(): Record<string, unknown> {
    const failure = this.lastError
      ? classifyProviderFailure({ detail: this.lastError.message, local: true })
      : null;
    return {
      served: this.contextWindow || null,
      cap: Number.isFinite(this.config.contextCap) ? this.config.contextCap : "model-max",
      reloading: this.ensuring !== null,
      lastReloadMs: this.lastReloadMs,
      lastError: this.lastError ? redactSecrets(this.lastError.message) : null,
      lastErrorClass: failure?.class ?? null,
    };
  }
}

import type { Model } from "@mariozechner/pi-ai";
import { streamPiAi } from "./pi-ai";
import type { ChatMessage, Provider, ProviderEvent, Readiness, ToolDef } from "./types";

export interface LmStudioConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  readonly url: string;
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/** Context window assumed before the running model reports its own (tokens). */
const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Local LM Studio provider. Streaming and tool calling go through pi-ai's
 * openai-completions adapter (LM Studio speaks the OpenAI chat API). Load state
 * (readiness/warm) and the real context window come from LM Studio's native
 * /api/v0 endpoint, which pi-ai does not model.
 */
export class LmStudioProvider implements Provider {
  readonly id = "lmstudio";
  readonly label: string;
  readonly model: string;
  /** Local qwen thinking is binary (enable_thinking on/off); "off" = no reasoning. */
  readonly reasoningLevels = ["off", "on"] as const;
  readonly defaultReasoning = "off";
  private readonly url: string;
  private readonly native: string;
  /** Effective context window of the loaded model (tokens); learned from model info. */
  private contextWindow = 0;

  constructor(config: LmStudioConfig) {
    this.url = config.url;
    this.model = config.model;
    this.label = config.label;
    this.native = new URL("/api/v0", config.url).toString();
  }

  async readiness(): Promise<Readiness> {
    try {
      const response = await fetch(`${this.native}/models/${encodeURIComponent(this.model)}`);
      if (!response.ok) {
        return { ready: false, warm: false };
      }
      const body = (await response.json()) as {
        state?: string;
        loaded_context_length?: number;
        max_context_length?: number;
      };
      // Report the *loaded* context - the window LM Studio actually serves - so the
      // usage display and overflow detection match reality. To use the model's full
      // ceiling, load qwen at that context in LM Studio (lms load -c <tokens>); this
      // value, and max_completion_tokens with it, then follow automatically.
      this.contextWindow =
        body.loaded_context_length ?? body.max_context_length ?? this.contextWindow;
      return { ready: true, warm: body.state === "loaded" };
    } catch {
      return { ready: false, warm: false };
    }
  }

  /** The loaded context window, fetching model info once if not yet known. */
  private async ensureContextWindow(): Promise<number> {
    if (this.contextWindow === 0) {
      await this.readiness();
    }
    return this.contextWindow;
  }

  async warm(): Promise<void> {
    await fetch(`${this.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
  }

  async *stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): AsyncIterable<ProviderEvent> {
    const contextWindow = (await this.ensureContextWindow()) || DEFAULT_CONTEXT_WINDOW;
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
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: contextWindow,
      compat: { thinkingFormat: "qwen" },
    };
    // LM Studio ignores the key, but pi-ai requires a non-empty one. With the qwen
    // format + model.reasoning, omitting the level (undefined) sends enable_thinking:
    // false; "high" sends true. "off" isn't a pi-ai ThinkingLevel, so undefined is it.
    yield* streamPiAi(model, messages, tools, {
      apiKey: "lm-studio",
      contextWindow,
      reasoning: thinking ? "high" : undefined,
    });
  }
}

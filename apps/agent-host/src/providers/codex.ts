import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getModel, getSupportedThinkingLevels, type ThinkingLevel } from "@mariozechner/pi-ai";
import { Effect, Stream } from "effect";
import { msg } from "../tools/shared";
import { ProviderAuthError } from "./errors";
import { streamPiAi } from "./pi-ai";
import type {
  ChatMessage,
  Provider,
  ProviderError,
  ProviderEvent,
  Readiness,
  ToolDef,
} from "./types";

const AUTH_PATH = `${homedir()}/.pi/auth.json`;
const CODEX = "openai-codex";

export interface CodexConfig {
  /** A model id from pi-ai's openai-codex registry, e.g. gpt-5.5 */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/**
 * GPT-5.x via the OpenAI Codex OAuth in ~/.pi/auth.json, through pi-ai. Cloud, so
 * always warm. Supports tool calling: tools ride in the pi-ai context, and tool
 * calls surface as tool_call events for the agent loop to execute.
 */
export class CodexProvider implements Provider {
  readonly id = "codex";
  readonly label: string;
  readonly model: string;
  /** GPT-5.x reasoning is graduated (minimal..xhigh) and read from the pi-ai model. */
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;

  constructor(config: CodexConfig) {
    this.model = config.model;
    this.label = config.label;
    // Derive the model's thinking options once; fall back to the GPT-5.x range if the
    // configured id is not (yet) in pi-ai's registry, so the host still starts.
    let levels: readonly string[];
    try {
      levels = getSupportedThinkingLevels(getModel(CODEX, this.model as "gpt-5.5"));
    } catch {
      levels = ["minimal", "low", "medium", "high", "xhigh"];
    }
    this.reasoningLevels = levels;
    this.defaultReasoning = levels.includes("medium")
      ? "medium"
      : (levels[Math.floor(levels.length / 2)] ?? "medium");
  }

  async readiness(): Promise<Readiness> {
    const apiKey = await this.resolveApiKey().catch(() => null);
    return { ready: apiKey !== null, warm: true };
  }

  async warm(): Promise<void> {
    // Cloud-hosted: nothing to load.
  }

  stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError> {
    // resolveApiKey can fail with ProviderAuthError; unwrap it so that rides the stream's
    // typed error channel rather than throwing out of an async generator.
    return Stream.unwrap(
      Effect.tryPromise({
        try: () => this.resolveApiKey(),
        catch: (cause) =>
          cause instanceof ProviderAuthError
            ? cause
            : new ProviderAuthError({ provider: this.id, detail: msg(cause), cause }),
      }).pipe(
        Effect.map((apiKey) => {
          // The model id is configurable at runtime; pi-ai validates it against its
          // registry, so the literal cast only satisfies its strict getModel typing.
          const model = getModel(CODEX, this.model as "gpt-5.5");
          // pi-ai clamps an out-of-range level to the nearest supported one.
          return streamPiAi(model, messages, tools, {
            apiKey,
            contextWindow: model.contextWindow,
            reasoning: (reasoning ?? this.defaultReasoning) as ThinkingLevel,
            provider: this.id,
          });
        }),
      ),
    );
  }

  private async resolveApiKey(): Promise<string> {
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(await readFile(AUTH_PATH, "utf8")) as Record<string, unknown>;
    } catch (cause) {
      throw new ProviderAuthError({
        provider: this.id,
        detail: `cannot read ${AUTH_PATH} (log in with the pi CLI)`,
        cause,
      });
    }
    const credentials = auth[CODEX];
    if (!credentials) {
      throw new ProviderAuthError({
        provider: this.id,
        detail: `no ${CODEX} entry in ${AUTH_PATH}`,
      });
    }
    const { getOAuthApiKey } = await import("@mariozechner/pi-ai/oauth");
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai OAuth credential shape is internal.
    const resolved = await getOAuthApiKey(CODEX as any, { [CODEX]: credentials } as any);
    if (!resolved) {
      throw new ProviderAuthError({
        provider: this.id,
        detail: "OAuth refresh failed (re-login with the pi CLI)",
      });
    }
    return resolved.apiKey;
  }
}

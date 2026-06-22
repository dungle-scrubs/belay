import type { ChatMessage, Provider, ProviderEvent, Readiness, ToolDef } from "./types";

export interface LmStudioConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  readonly url: string;
  readonly model: string;
}

/** Converts a host ChatMessage to the OpenAI chat-completions message shape. */
function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

interface OpenAiStreamChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Local LM Studio provider with OpenAI-compatible streaming + tool calling. */
export class LmStudioProvider implements Provider {
  readonly id = "lmstudio";
  readonly model: string;
  private readonly url: string;
  private readonly native: string;
  /** Effective context window of the loaded model (tokens); learned from model info. */
  private contextWindow = 0;

  constructor(config: LmStudioConfig) {
    this.url = config.url;
    this.model = config.model;
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
  ): AsyncIterable<ProviderEvent> {
    const response = await fetch(`${this.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: messages.map(toOpenAiMessage),
        ...(tools.length > 0
          ? { tools: tools.map((tool) => ({ type: "function", function: tool })) }
          : {}),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`LM Studio HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        try {
          const chunk = JSON.parse(data) as OpenAiStreamChunk;
          if (chunk.usage) {
            usage = chunk.usage;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: "text", text: delta.content };
          }
          for (const toolCall of delta?.tool_calls ?? []) {
            const entry = calls.get(toolCall.index) ?? { id: "", name: "", args: "" };
            if (toolCall.id) {
              entry.id = toolCall.id;
            }
            if (toolCall.function?.name) {
              entry.name = toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              entry.args += toolCall.function.arguments;
            }
            calls.set(toolCall.index, entry);
          }
        } catch {
          // ignore partial or non-JSON SSE lines
        }
      }
    }
    for (const entry of calls.values()) {
      yield {
        type: "tool_call",
        call: { id: entry.id || crypto.randomUUID(), name: entry.name, arguments: entry.args },
      };
    }
    if (usage) {
      yield {
        type: "usage",
        usage: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          contextWindow: await this.ensureContextWindow(),
        },
      };
    }
  }
}

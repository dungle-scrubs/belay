import type { ChatMessage, Provider, Readiness } from "./types";

export interface LmStudioConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  readonly url: string;
  readonly model: string;
}

/** Local LM Studio provider. readiness() reads the native /api/v0 load state. */
export class LmStudioProvider implements Provider {
  readonly id = "lmstudio";
  readonly model: string;
  private readonly url: string;
  private readonly native: string;

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
      const body = (await response.json()) as { state?: string };
      return { ready: true, warm: body.state === "loaded" };
    } catch {
      return { ready: false, warm: false };
    }
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

  async *stream(messages: readonly ChatMessage[]): AsyncIterable<string> {
    const response = await fetch(`${this.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, stream: true, messages }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`LM Studio HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
          const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
          const content = chunk.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            yield content;
          }
        } catch {
          // ignore partial or non-JSON SSE lines
        }
      }
    }
  }
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { type Context, getModel, streamSimple } from "@mariozechner/pi-ai";
import type { ChatMessage, Provider, Readiness } from "./types";

const AUTH_PATH = `${homedir()}/.pi/auth.json`;
const CODEX = "openai-codex";

export interface CodexConfig {
  /** A model id from pi-ai's openai-codex registry, e.g. gpt-5.5 */
  readonly model: string;
}

/** Converts the host's history to pi-ai messages (assistant input is a text block). */
function toPiAiMessages(messages: readonly ChatMessage[]): Context["messages"] {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content, timestamp: Date.now() }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          timestamp: Date.now(),
        },
  ) as Context["messages"];
}

/**
 * GPT-5.x via the OpenAI Codex OAuth in ~/.pi/auth.json, through pi-ai. Cloud, so
 * always warm; pi-ai's getOAuthApiKey refreshes the token as needed.
 */
export class CodexProvider implements Provider {
  readonly id = "codex";
  readonly model: string;

  constructor(config: CodexConfig) {
    this.model = config.model;
  }

  async readiness(): Promise<Readiness> {
    const apiKey = await this.resolveApiKey().catch(() => null);
    return { ready: apiKey !== null, warm: true };
  }

  async warm(): Promise<void> {
    // Cloud-hosted: nothing to load.
  }

  async *stream(messages: readonly ChatMessage[]): AsyncIterable<string> {
    const apiKey = await this.resolveApiKey();
    // The model id is configurable at runtime; pi-ai validates it against its
    // registry, so the literal cast only satisfies its strict getModel typing.
    const model = getModel(CODEX, this.model as "gpt-5.5");
    const context: Context = { messages: toPiAiMessages(messages) };
    for await (const event of streamSimple(model, context, { apiKey })) {
      if (event.type === "text_delta") {
        yield event.delta;
      }
    }
  }

  private async resolveApiKey(): Promise<string> {
    const auth = JSON.parse(await readFile(AUTH_PATH, "utf8")) as Record<string, unknown>;
    const credentials = auth[CODEX];
    if (!credentials) {
      throw new Error(`no ${CODEX} entry in ${AUTH_PATH}`);
    }
    const { getOAuthApiKey } = await import("@mariozechner/pi-ai/oauth");
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai OAuth credential shape is internal.
    const resolved = await getOAuthApiKey(CODEX as any, { [CODEX]: credentials } as any);
    if (!resolved) {
      throw new Error(`${CODEX} OAuth failed (re-login with the pi CLI)`);
    }
    return resolved.apiKey;
  }
}

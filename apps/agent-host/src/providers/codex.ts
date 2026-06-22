import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
import type { Provider, Readiness } from "./types";

const AUTH_PATH = `${homedir()}/.pi/auth.json`;
const CODEX = "openai-codex";

export interface CodexConfig {
  /** A model id from pi-ai's openai-codex registry, e.g. gpt-5.5 */
  readonly model: string;
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

  async *stream(prompt: string): AsyncIterable<string> {
    const apiKey = await this.resolveApiKey();
    // The model id is configurable at runtime; pi-ai validates it against its
    // registry, so the literal cast only satisfies its strict getModel typing.
    const model = getModel(CODEX, this.model as "gpt-5.5");
    const context = {
      messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
    };
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
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai OAuth credential shape is internal.
    const resolved = await getOAuthApiKey(CODEX as any, { [CODEX]: credentials } as any);
    if (!resolved) {
      throw new Error(`${CODEX} OAuth failed (re-login with the pi CLI)`);
    }
    return resolved.apiKey;
  }
}

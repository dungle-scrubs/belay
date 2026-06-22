import { CodexProvider } from "./codex";
import { LmStudioProvider } from "./lmstudio";
import type { Provider } from "./types";

export type { ChatMessage, Provider, Readiness } from "./types";

/** Provider keys the browser switches between (user.message.payload.provider). */
export interface Providers {
  readonly qwen: Provider;
  readonly gpt: Provider;
}

export const DEFAULT_PROVIDER = "qwen";

/** Builds the provider registry the host switches between per message. */
export function buildProviders(): Providers {
  return {
    qwen: new LmStudioProvider({
      url: process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1",
      model: process.env.LMSTUDIO_MODEL ?? "qwen3.6-27b-mlx",
    }),
    gpt: new CodexProvider({ model: process.env.PIAI_MODEL ?? "gpt-5.5" }),
  };
}

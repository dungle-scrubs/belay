import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { type Context, getModel, streamSimple, type TSchema } from "@mariozechner/pi-ai";
import type { ChatMessage, Provider, ProviderEvent, Readiness, ToolDef } from "./types";

const AUTH_PATH = `${homedir()}/.pi/auth.json`;
const CODEX = "openai-codex";

export interface CodexConfig {
  /** A model id from pi-ai's openai-codex registry, e.g. gpt-5.5 */
  readonly model: string;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Converts the host history to pi-ai messages, preserving tool calls and results:
 * an assistant turn that called tools becomes content blocks (text + toolCall), and
 * a tool turn becomes a toolResult message - so multi-step tool loops round-trip.
 */
function toPiAiMessages(messages: readonly ChatMessage[]): Context["messages"] {
  return messages.map((message): unknown => {
    if (message.role === "user") {
      return { role: "user", content: message.content, timestamp: Date.now() };
    }
    if (message.role === "tool") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name ?? "",
        content: [{ type: "text", text: message.content }],
        isError: false,
        timestamp: Date.now(),
      };
    }
    const content: unknown[] = [];
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: parseArgs(call.arguments),
      });
    }
    return {
      role: "assistant",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      timestamp: Date.now(),
    };
  }) as Context["messages"];
}

/** Converts host tool defs to pi-ai tools (JSON Schema cast to typebox TSchema). */
function toPiAiTools(tools: readonly ToolDef[]): Context["tools"] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as TSchema,
  }));
}

/**
 * GPT-5.x via the OpenAI Codex OAuth in ~/.pi/auth.json, through pi-ai. Cloud, so
 * always warm. Supports tool calling: tools ride in the pi-ai context, and tool
 * calls surface as tool_call events for the agent loop to execute.
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

  async *stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
  ): AsyncIterable<ProviderEvent> {
    const apiKey = await this.resolveApiKey();
    // The model id is configurable at runtime; pi-ai validates it against its
    // registry, so the literal cast only satisfies its strict getModel typing.
    const model = getModel(CODEX, this.model as "gpt-5.5");
    const context: Context = {
      messages: toPiAiMessages(messages),
      ...(tools.length > 0 ? { tools: toPiAiTools(tools) } : {}),
    };
    for await (const event of streamSimple(model, context, { apiKey })) {
      if (event.type === "text_delta") {
        yield { type: "text", text: event.delta };
      } else if (event.type === "toolcall_end") {
        yield {
          type: "tool_call",
          call: {
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments ?? {}),
          },
        };
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

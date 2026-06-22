/** Model load state for a provider: reachable, and warm (loaded) vs cold. */
export interface Readiness {
  readonly ready: boolean;
  readonly warm: boolean;
}

/** A tool exposed to the model (OpenAI-style JSON-schema parameters). */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** A tool call the model requested (arguments are a raw JSON string). */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Token usage for one model step: prompt (context used) + generated, vs the window. */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly contextWindow: number;
  /** Generation wall-time for this step (first token -> end), ms; for tokens/sec. */
  readonly genMs: number;
}

/** One streamed event from a provider: assistant text, a tool call, or token usage. */
export type ProviderEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: Usage };

/** One message in the conversation (user, assistant, or a tool result). */
export interface ChatMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[]; // assistant turn that requested tools
  readonly toolCallId?: string; // tool result: the call it answers
  readonly name?: string; // tool result: the tool name
}

/**
 * A model provider the host streams completions from. Readiness is per-adapter
 * (local providers report real load state; cloud is always warm). stream() runs
 * one model step over the conversation, emitting text and any tool calls.
 */
export interface Provider {
  readonly id: string;
  readonly model: string;
  readiness(): Promise<Readiness>;
  warm(): Promise<void>;
  stream(messages: readonly ChatMessage[], tools: readonly ToolDef[]): AsyncIterable<ProviderEvent>;
}

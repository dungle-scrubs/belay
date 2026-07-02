import { MAX_OUTPUT, TRUNCATION_NOTICE } from "@host/tools/shared";
import { asRecord } from "./decode";

/**
 * Tolerant decoding of MCP result payloads into model-safe text (plan 23 M5). Every decoder
 * follows the ./config tradition: a malformed entry degrades to a described placeholder or is
 * dropped, never thrown. Binary payloads (image/audio data, blobs) are DESCRIBED - type, mime,
 * size - never dumped, and everything that reaches the model is bounded by the host's normal
 * output norms (tools/shared.ts MAX_OUTPUT + truncation marker).
 *
 * Responsible for: decoding tools/call content blocks, resources/read contents, and
 * prompts/get messages to text, and the shared boundText / boundPromptMessages bounding.
 * Not for: execution, identity, or provenance - ./runtime owns those.
 */

export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

/** Bounds text at `maxChars` with the host's standard truncation marker, flagging the cut. */
export function boundText(text: string, maxChars: number = MAX_OUTPUT): BoundedText {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}${TRUNCATION_NOTICE}`, truncated: true };
}

export interface McpToolResultOutcome {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Decodes a `tools/call` result: the content blocks joined to one text (non-text blocks
 * described in place), plus the spec's `isError` flag - a tool-level failure that arrives as a
 * RESULT, not a JSON-RPC error. Unbounded; the caller caps.
 */
export function decodeToolCallResult(raw: unknown): McpToolResultOutcome {
  const record = asRecord(raw);
  const blocks = Array.isArray(record?.content) ? record.content : [];
  const parts = blocks.map(contentBlockText).filter((part) => part.length > 0);
  return { text: parts.join("\n"), isError: record?.isError === true };
}

export interface McpResourceContentsOutcome {
  readonly text: string;
  readonly mimeType?: string;
}

/**
 * Decodes a `resources/read` result (`{ contents: [...] }`): text parts joined, blob parts
 * described by mime + size, and the first declared mime type kept. Unbounded; the caller caps.
 */
export function decodeResourceContents(raw: unknown): McpResourceContentsOutcome {
  const record = asRecord(raw);
  const entries = Array.isArray(record?.contents) ? record.contents : [];
  const parts: string[] = [];
  let mimeType: string | undefined;

  for (const entry of entries) {
    const item = asRecord(entry);
    if (!item) {
      continue;
    }
    if (mimeType === undefined && typeof item.mimeType === "string") {
      mimeType = item.mimeType;
    }
    if (typeof item.text === "string") {
      parts.push(item.text);
    } else if (typeof item.blob === "string") {
      const mime = typeof item.mimeType === "string" ? item.mimeType : "unknown type";
      parts.push(`[binary ${mime}, ${item.blob.length} base64 chars]`);
    }
  }

  return { text: parts.join("\n"), ...(mimeType !== undefined ? { mimeType } : {}) };
}

export interface McpPromptMessage {
  readonly role: string;
  readonly text: string;
}

export interface McpPromptMessagesOutcome {
  readonly description?: string;
  readonly messages: readonly McpPromptMessage[];
}

/**
 * Decodes a `prompts/get` result: the description plus each message's role and content text
 * (non-text content described, per contentBlockText). A malformed message is dropped; a
 * missing role defaults to "user". Unbounded; the caller bounds the expansion.
 */
export function decodePromptMessages(raw: unknown): McpPromptMessagesOutcome {
  const record = asRecord(raw);
  const entries = Array.isArray(record?.messages) ? record.messages : [];
  const messages = entries.flatMap((entry): McpPromptMessage[] => {
    const message = asRecord(entry);
    if (!message) {
      return [];
    }
    // The spec sends one content block per message; an array is tolerated and joined.
    const text = Array.isArray(message.content)
      ? message.content
          .map(contentBlockText)
          .filter((part) => part.length > 0)
          .join("\n")
      : contentBlockText(message.content);
    return [{ role: typeof message.role === "string" ? message.role : "user", text }];
  });
  return {
    ...(typeof record?.description === "string" ? { description: record.description } : {}),
    messages,
  };
}

export interface BoundedPromptMessages {
  readonly messages: readonly McpPromptMessage[];
  readonly truncated: boolean;
}

/**
 * Bounds a prompt expansion by TOTAL text across messages: the message that crosses the
 * budget is cut with the truncation marker and everything after it is dropped, so an
 * imported prompt can never exceed the host's output norms however many messages it carries.
 */
export function boundPromptMessages(
  messages: readonly McpPromptMessage[],
  maxChars: number = MAX_OUTPUT,
): BoundedPromptMessages {
  const bounded: McpPromptMessage[] = [];
  let used = 0;

  for (const [index, message] of messages.entries()) {
    const remaining = maxChars - used;
    const cut = boundText(message.text, remaining);
    bounded.push({ role: message.role, text: cut.text });
    if (cut.truncated || (used + message.text.length >= maxChars && index < messages.length - 1)) {
      return { messages: bounded, truncated: true };
    }
    used += message.text.length;
  }

  return { messages: bounded, truncated: false };
}

/** One content block to its text: real text passes through, everything else is described. */
function contentBlockText(block: unknown): string {
  const record = asRecord(block);
  if (!record) {
    return "";
  }
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "text") {
    return typeof record.text === "string" ? record.text : "";
  }
  if (type === "image" || type === "audio") {
    const mime = typeof record.mimeType === "string" ? record.mimeType : "unknown media type";
    return `[${type} ${mime}]`;
  }
  if (type === "resource") {
    const resource = asRecord(record.resource);
    if (typeof resource?.text === "string") {
      return resource.text;
    }
    return `[resource ${typeof resource?.uri === "string" ? resource.uri : "unknown"}]`;
  }
  if (type === "resource_link") {
    return `[resource ${typeof record.uri === "string" ? record.uri : "unknown"}]`;
  }
  return type.length > 0 ? `[${type} content]` : "";
}

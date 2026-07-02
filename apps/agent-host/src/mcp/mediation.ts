import { asRecord } from "./decode";
import type { McpServerRequestHandler, McpServerRequestOutcome } from "./transport";

/**
 * Host-owned mediation of server-originated MCP requests (plan 23 M6): elicitation
 * (`elicitation/create`) and sampling (`sampling/createMessage`) arriving MID-call over either
 * transport. The mediator is the ONE decision point between an external server and the user /
 * the host's models (D-002, D-007):
 *
 *   - Elicitation is answered through an injected handler seam - the UI rides the host's
 *     existing pending-question surface (agent/provider-questions.ts) when wired. No handler
 *     (headless host, no UI) DECLINES; a handler that never answers is CANCELLED at the
 *     deadline, which is clamped to the server's own requestTimeoutMs so a mid-call question
 *     can never outlive the enclosing request; a handler crash is a structured internal
 *     error. The server only ever sees accept/decline/cancel - never why.
 *   - Sampling is OFF by default: unless the server's config says `"sampling": true`, the
 *     request is denied with a method-level JSON-RPC error and the handler is never invoked.
 *     When enabled, the request is SANITIZED into a narrow projection (role/text messages,
 *     systemPrompt, maxTokens), gated by a runtime-wide budget counter, and the response is
 *     rebuilt from ONLY the handler's narrow output (text, model, numeric token usage) - raw
 *     provider payloads cannot pass in either direction.
 *
 * Everything a server receives is a structured JSON-RPC outcome; the mediator never throws.
 *
 * Responsible for: the per-server mediator answering elicitation/sampling requests, the
 * injected handler seams, and the sampling budget counter.
 * Not for: delivering the answers on the wire (the transports' onServerRequest option) or
 * wiring config/handlers together (./runtime).
 */

/** One server-originated user question, projected for the host's question surface. */
export interface McpElicitationRequest {
  readonly server: string;
  readonly message: string;
  readonly requestedSchema?: unknown;
}

/** What the user (or the unavailable-UI policy) answered. */
export type McpElicitationAnswer =
  | { readonly action: "accept"; readonly content: Record<string, unknown> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

/** The host-owned question seam; the UI wires this onto its pending-question surface. */
export type McpElicitationHandler = (
  request: McpElicitationRequest,
) => Promise<McpElicitationAnswer>;

/** A sampling request sanitized to what a handler may see: no raw server payload passes. */
export interface McpSamplingRequest {
  readonly server: string;
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
}

/** What a sampling handler may return: the completion text plus sanitized-usage numbers.
 *  Deliberately narrow so raw provider payloads cannot ride back to the server. */
export interface McpSamplingCompletion {
  readonly text: string;
  readonly model?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/** The host-owned sampling seam (a real model turn when wired; a fake in tests). */
export type McpSamplingHandler = (request: McpSamplingRequest) => Promise<McpSamplingCompletion>;

/** How many sampling calls one runtime (one host session) grants across all servers. */
export const DEFAULT_MCP_SAMPLING_BUDGET = 8;

/** How long an elicitation waits for the user before answering `cancel` (further clamped to
 *  the server's requestTimeoutMs, the enclosing request's own deadline). */
export const DEFAULT_MCP_ELICITATION_TIMEOUT_MS = 300_000;

export interface SamplingBudget {
  /** Takes one call from the budget; `false` once exhausted. */
  readonly consume: () => boolean;
  /** Calls remaining (inspectable state for diagnostics/tests). */
  readonly remaining: () => number;
}

/** The simple runtime-wide sampling counter (shared across servers, never replenished). */
export function createSamplingBudget(limit: number = DEFAULT_MCP_SAMPLING_BUDGET): SamplingBudget {
  let remaining = Math.max(0, Math.floor(limit));
  return {
    consume: () => {
      if (remaining <= 0) {
        return false;
      }
      remaining -= 1;
      return true;
    },
    remaining: () => remaining,
  };
}

export interface McpMediatorOptions {
  readonly server: string;
  /** The server's per-request deadline: mid-call mediation (an elicitation waiting on the
   *  user) may never outlive the enclosing request, so its timeout clamps to this. */
  readonly requestTimeoutMs: number;
  readonly elicitation?: {
    readonly handler?: McpElicitationHandler;
    readonly timeoutMs?: number;
  };
  readonly sampling: {
    /** The per-server config opt-in (`sampling: true`); denied while false. */
    readonly enabled: boolean;
    readonly handler?: McpSamplingHandler;
    /** The shared budget's consume; injected so the counter spans every server. */
    readonly consumeBudget: () => boolean;
  };
}

/** Builds the onServerRequest handler for one server's transport. */
export function createMcpServerMediator(options: McpMediatorOptions): McpServerRequestHandler {
  return async (method, params) => {
    if (method === "elicitation/create") {
      return mediateElicitation(options, params);
    }
    if (method === "sampling/createMessage") {
      return mediateSampling(options, params);
    }
    return { error: { code: -32601, message: `method not supported: ${method}` } };
  };
}

async function mediateElicitation(
  options: McpMediatorOptions,
  params: unknown,
): Promise<McpServerRequestOutcome> {
  const handler = options.elicitation?.handler;
  if (!handler) {
    // No question surface is available (headless host / no UI): decline, per the spec's
    // "the user is not available" semantics - never leave the server hanging.
    return { result: { action: "decline" } };
  }
  const record = asRecord(params);
  const request: McpElicitationRequest = {
    server: options.server,
    message: typeof record?.message === "string" ? record.message : "",
    ...(record?.requestedSchema !== undefined ? { requestedSchema: record.requestedSchema } : {}),
  };
  try {
    // Clamp to the enclosing request deadline: an elicitation that outlived it would answer
    // a request the server already timed out.
    const timeoutMs = Math.min(
      options.elicitation?.timeoutMs ?? DEFAULT_MCP_ELICITATION_TIMEOUT_MS,
      options.requestTimeoutMs,
    );
    const answer = await withTimeout(handler(request), timeoutMs);
    if (answer === TIMED_OUT) {
      // The user never answered inside the deadline: a cancel, not a decline - they did not
      // choose anything. The late answer (if any) resolves into the void.
      return { result: { action: "cancel" } };
    }
    if (answer.action === "accept") {
      return { result: { action: "accept", content: answer.content } };
    }
    return { result: { action: answer.action } };
  } catch {
    return { error: { code: -32603, message: "elicitation mediation failed on the host" } };
  }
}

async function mediateSampling(
  options: McpMediatorOptions,
  params: unknown,
): Promise<McpServerRequestOutcome> {
  const handler = options.sampling.handler;
  if (!handler) {
    // Checked FIRST: without a host-side handler no config flag can help, so the denial must
    // not point the server (or the user reading its logs) at mcp-servers.json.
    return {
      error: {
        code: -32601,
        message: `sampling is unavailable: this host has sampling disabled (no sampling handler is wired)`,
      },
    };
  }
  if (!options.sampling.enabled) {
    return {
      error: {
        code: -32601,
        message: `sampling is disabled for MCP server "${options.server}" (enable it with "sampling": true in mcp-servers.json)`,
      },
    };
  }
  if (!options.sampling.consumeBudget()) {
    return {
      error: {
        code: -32000,
        message: `sampling budget exhausted for this session; MCP server "${options.server}" gets no further model calls`,
      },
    };
  }
  try {
    const completion = await handler(sanitizeSamplingRequest(options.server, params));
    return { result: sanitizeSamplingResult(completion) };
  } catch {
    // Deliberately detail-free: a handler failure may carry provider internals.
    return { error: { code: -32603, message: "sampling mediation failed on the host" } };
  }
}

/** Projects raw createMessage params into the narrow request a handler may see. */
function sanitizeSamplingRequest(server: string, params: unknown): McpSamplingRequest {
  const record = asRecord(params);
  const rawMessages = Array.isArray(record?.messages) ? record.messages : [];
  const messages = rawMessages.flatMap((entry) => {
    const message = asRecord(entry);
    if (!message) {
      return [];
    }
    const content = asRecord(message.content);
    const text = typeof content?.text === "string" ? content.text : "";
    return [{ role: typeof message.role === "string" ? message.role : "user", text }];
  });
  return {
    server,
    messages,
    ...(typeof record?.systemPrompt === "string" ? { systemPrompt: record.systemPrompt } : {}),
    ...(typeof record?.maxTokens === "number" ? { maxTokens: record.maxTokens } : {}),
  };
}

/** Rebuilds the createMessage result from ONLY the handler's narrow fields (defensively:
 *  a loosely-typed caller could smuggle extra keys; none survive this projection). */
function sanitizeSamplingResult(completion: McpSamplingCompletion): Record<string, unknown> {
  const usage = completion.usage;
  const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;
  const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined;
  const sanitizedUsage =
    inputTokens !== undefined || outputTokens !== undefined
      ? {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        }
      : undefined;
  return {
    role: "assistant",
    content: { type: "text", text: typeof completion.text === "string" ? completion.text : "" },
    model: typeof completion.model === "string" ? completion.model : "unknown",
    stopReason: "endTurn",
    ...(sanitizedUsage !== undefined ? { usage: sanitizedUsage } : {}),
  };
}

const TIMED_OUT = Symbol("mcp-elicitation-timeout");

/** Races a promise against a deadline; the timer never keeps the process alive. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

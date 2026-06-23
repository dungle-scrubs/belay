import type { SessionEvent } from "./wire";

/**
 * The trevor session protocol: the `user.message`, `assistant.*`, `tool.*`, and
 * `host.*` events that ride on Richter's generic event log. Richter (wire.ts)
 * owns only the envelope - `type` is a free string and `payload` an arbitrary
 * object - so the trevor-specific event names and payload shapes live HERE, once,
 * shared by both emitters (host + web) and consumers.
 *
 * Two sides:
 *   - `events.*` constructors build `{ type, payload }` for publishing, so the
 *     emit side never spells an event name or payload key by hand.
 *   - `decodeTrevorEvent` folds a raw SessionEvent into a typed, discriminated
 *     `DecodedEvent`, coercing payload fields permissively (a malformed or
 *     forward-compat event yields defaults or `null`, never a throw). Consumers
 *     switch on `.type` instead of hand-guarding `typeof payload.x === "string"`.
 */

/** Token usage carried on assistant.completed: prompt (context used) + generated. */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly contextWindow: number;
  readonly genMs: number;
}

/** A selectable provider's display label, model id, and thinking options. */
export interface ProviderModel {
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
}

/** A publishable event before a producerId is attached: `{ type, payload }`. */
export interface TrevorEventInput {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

// --- emit side: typed constructors (single source of names + payload shapes) ---

/**
 * Constructors for every trevor event. Each returns `{ type, payload }`; the
 * caller attaches its own producerId at publish time (host vs web). Optional
 * fields (usage/error/reasoning) are omitted when absent so the wire matches the
 * hand-built payloads these replaced.
 */
export const events = {
  userMessage: (p: { text: string; provider: string; reasoning?: string }): TrevorEventInput => ({
    type: "user.message",
    payload: {
      text: p.text,
      provider: p.provider,
      ...(p.reasoning ? { reasoning: p.reasoning } : {}),
    },
  }),
  assistantStarted: (p: {
    runId: string;
    warm: boolean;
    model: string;
    provider: string;
  }): TrevorEventInput => ({
    type: "assistant.started",
    payload: { runId: p.runId, warm: p.warm, model: p.model, provider: p.provider },
  }),
  assistantDelta: (p: { runId: string; text: string }): TrevorEventInput => ({
    type: "assistant.delta",
    payload: { runId: p.runId, text: p.text },
  }),
  assistantThinking: (p: { runId: string; text: string }): TrevorEventInput => ({
    type: "assistant.thinking",
    payload: { runId: p.runId, text: p.text },
  }),
  assistantOverflow: (p: { runId: string; reason: string }): TrevorEventInput => ({
    type: "assistant.overflow",
    payload: { runId: p.runId, reason: p.reason },
  }),
  assistantCompleted: (p: {
    runId: string;
    text: string;
    usage?: Usage;
    error?: string;
    cancelled?: boolean;
  }): TrevorEventInput => ({
    type: "assistant.completed",
    payload: {
      runId: p.runId,
      text: p.text,
      ...(p.usage ? { usage: p.usage } : {}),
      ...(p.error ? { error: p.error } : {}),
      ...(p.cancelled ? { cancelled: true } : {}),
    },
  }),
  /** User asked to cancel the active run (hard steering / ESC). */
  userCancel: (p: { runId: string }): TrevorEventInput => ({
    type: "user.cancel",
    payload: { runId: p.runId },
  }),
  toolStarted: (p: {
    runId: string;
    callId: string;
    name: string;
    arguments: string;
  }): TrevorEventInput => ({
    type: "tool.started",
    payload: { runId: p.runId, callId: p.callId, name: p.name, arguments: p.arguments },
  }),
  toolCompleted: (p: {
    runId: string;
    callId: string;
    name: string;
    result: string;
  }): TrevorEventInput => ({
    type: "tool.completed",
    payload: { runId: p.runId, callId: p.callId, name: p.name, result: p.result },
  }),
  hostBeat: (p: { instanceId: string }): TrevorEventInput => ({
    type: "host.beat",
    payload: { instanceId: p.instanceId },
  }),
  hostHello: (p: { instanceId: string }): TrevorEventInput => ({
    type: "host.hello",
    payload: { instanceId: p.instanceId },
  }),
  hostRole: (p: { instanceId: string; role: string }): TrevorEventInput => ({
    type: "host.role",
    payload: { instanceId: p.instanceId, role: p.role },
  }),
  hostOnline: (p: {
    providers: readonly string[];
    default: string;
    models: Record<string, ProviderModel>;
    instanceId: string;
    cwd: string;
    workspace: string;
  }): TrevorEventInput => ({
    type: "host.online",
    payload: {
      providers: p.providers,
      default: p.default,
      models: p.models,
      instanceId: p.instanceId,
      cwd: p.cwd,
      workspace: p.workspace,
    },
  }),
} as const;

// --- consume side: permissive coercion + discriminated decode ---

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const optStr = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const num = (value: unknown): number => (typeof value === "number" ? value : 0);

function coerceUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const u = value as Record<string, unknown>;
  return {
    input: num(u.input),
    output: num(u.output),
    contextWindow: num(u.contextWindow),
    genMs: num(u.genMs),
  };
}

function coerceProviderModels(value: unknown): Record<string, ProviderModel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, ProviderModel> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const m = raw as Record<string, unknown>;
    const levels = Array.isArray(m.reasoningLevels)
      ? m.reasoningLevels.filter((level): level is string => typeof level === "string")
      : [];
    out[key] = {
      label: str(m.label, key),
      model: str(m.model, key),
      reasoningLevels: levels,
      defaultReasoning: optStr(m.defaultReasoning) ?? levels[0] ?? "",
    };
  }
  return out;
}

/** A decoded trevor event: discriminated on `type` with coerced payload fields. */
export type DecodedEvent =
  | {
      readonly type: "user.message";
      readonly text: string;
      readonly provider?: string;
      readonly reasoning?: string;
    }
  | {
      readonly type: "assistant.started";
      readonly runId: string;
      readonly warm: boolean;
      readonly model: string;
      readonly provider?: string;
    }
  | { readonly type: "assistant.delta"; readonly runId: string; readonly text: string }
  | { readonly type: "assistant.thinking"; readonly runId: string; readonly text: string }
  | { readonly type: "assistant.overflow"; readonly runId: string; readonly reason: string }
  | {
      readonly type: "assistant.completed";
      readonly runId: string;
      readonly text: string;
      readonly usage?: Usage;
      readonly error?: string;
      readonly cancelled: boolean;
    }
  | { readonly type: "user.cancel"; readonly runId: string }
  | {
      readonly type: "tool.started";
      readonly runId: string;
      readonly callId: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "tool.completed";
      readonly runId: string;
      readonly callId: string;
      readonly name: string;
      readonly result: string;
    }
  | {
      readonly type: "host.online";
      readonly instanceId?: string;
      readonly workspace?: string;
      readonly cwd?: string;
      readonly models: Record<string, ProviderModel>;
    }
  | { readonly type: "host.hello"; readonly instanceId?: string }
  | { readonly type: "host.beat"; readonly instanceId?: string }
  | { readonly type: "host.role"; readonly instanceId?: string; readonly role?: string };

/**
 * Decodes one raw SessionEvent into a typed trevor event, or `null` for an
 * unrecognized type. runId/callId fall back to the event's own id so a missing
 * correlation id never collapses distinct turns together.
 */
export function decodeTrevorEvent(event: SessionEvent): DecodedEvent | null {
  const p = event.payload;
  const runId = str(p.runId, event.eventId);
  switch (event.type) {
    case "user.message":
      return {
        type: "user.message",
        text: str(p.text),
        provider: optStr(p.provider),
        reasoning: optStr(p.reasoning),
      };
    case "assistant.started":
      return {
        type: "assistant.started",
        runId,
        warm: p.warm === true,
        model: str(p.model, "model"),
        provider: optStr(p.provider),
      };
    case "assistant.delta":
      return { type: "assistant.delta", runId, text: str(p.text) };
    case "assistant.thinking":
      return { type: "assistant.thinking", runId, text: str(p.text) };
    case "assistant.overflow":
      return { type: "assistant.overflow", runId, reason: str(p.reason, "context overflow") };
    case "assistant.completed":
      return {
        type: "assistant.completed",
        runId,
        text: str(p.text),
        usage: coerceUsage(p.usage),
        error: optStr(p.error),
        cancelled: p.cancelled === true,
      };
    case "user.cancel":
      return { type: "user.cancel", runId };
    case "tool.started":
      return {
        type: "tool.started",
        runId,
        callId: str(p.callId, event.eventId),
        name: str(p.name, "tool"),
        arguments: str(p.arguments),
      };
    case "tool.completed":
      return {
        type: "tool.completed",
        runId,
        callId: str(p.callId, event.eventId),
        name: str(p.name, "tool"),
        result: str(p.result),
      };
    case "host.online":
      return {
        type: "host.online",
        instanceId: optStr(p.instanceId),
        workspace: optStr(p.workspace),
        cwd: optStr(p.cwd),
        models: coerceProviderModels(p.models),
      };
    case "host.hello":
      return { type: "host.hello", instanceId: optStr(p.instanceId) };
    case "host.beat":
      return { type: "host.beat", instanceId: optStr(p.instanceId) };
    case "host.role":
      return { type: "host.role", instanceId: optStr(p.instanceId), role: optStr(p.role) };
    default:
      return null;
  }
}

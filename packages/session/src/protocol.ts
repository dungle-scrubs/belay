import { HEX64 } from "./blob";
import { BREAKDOWN_CATEGORIES, type UsageBreakdown } from "./breakdown";
import type { SessionEvent } from "./event";

export type { UsageBreakdown };

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

/**
 * Token usage for one model step / turn: prompt (context used) + generated, vs the
 * window. Carried on assistant.completed; the host also uses it per model step (D-005).
 */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly contextWindow: number;
  /** Generation wall-time (first token -> end), ms; for tokens/sec. */
  readonly genMs: number;
}

// The wire `UsageBreakdown` type and its category schema live in ./breakdown (the
// single source host accumulation, this decoder, and the web treemap all derive from);
// re-exported above so existing `@trevor/session` importers are unaffected.

/** A selectable provider's display label, model id, and thinking options. */
export interface ProviderModel {
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
  /** Where the model runs: "local" (on this machine, e.g. LM Studio) or "cloud". */
  readonly kind: "local" | "cloud";
}

/**
 * An immediate host command (slash command), announced in host.online so the
 * browser knows which `/x` strings route to the host's command lane (executed
 * directly, bypassing the model) and can drive a slash menu. `usage` shows the
 * argument form when there is one (e.g. "/shell <command>").
 */
export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
}

/**
 * A content-addressed artifact (image / document / other file) attached to a
 * message. The bytes do NOT ride the event - they live in the blob store beside
 * Richter (D-028); the event carries only this reference. `hash` is the sha256 the
 * bytes are stored under, so the same artifact is shared across every session and
 * fork that references it. See `blob.ts` for the store client.
 */
export interface ArtifactRef {
  readonly kind: "image" | "document" | "file";
  readonly mimeType: string;
  readonly size: number;
  readonly hash: string;
  readonly name?: string;
}

/** A task's lifecycle state (the V1 set). "deleted" is an update verb, not a state. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/** One task as it rides the wire / renders in the UI (a row of the live checklist). */
export interface TaskSnapshot {
  readonly id: string;
  readonly subject: string;
  readonly activeForm: string;
  readonly status: TaskStatus;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
}

/**
 * The per-fold DELTA manifest carried on a `context.compacted` event: what THIS fold
 * folded away, not a cumulative picture. `turnRange` is the seq span it covers; `files`,
 * `tools`, and `topics` name the recallable references it collapsed (session recall, D-044,
 * advertises these so the model knows what detail it can ask back). Reconstruct the full
 * folded picture by walking the rolling chain - each fold `supersedes` the prior.
 */
export interface CompactionManifest {
  readonly turnRange: { readonly fromSeq: number; readonly toSeq: number };
  readonly files: readonly string[];
  readonly tools: readonly string[];
  readonly topics: readonly string[];
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
  userMessage: (p: {
    text: string;
    provider: string;
    reasoning?: string;
    artifacts?: readonly ArtifactRef[];
  }): TrevorEventInput => ({
    type: "user.message",
    payload: {
      text: p.text,
      provider: p.provider,
      ...(p.reasoning ? { reasoning: p.reasoning } : {}),
      ...(p.artifacts?.length ? { artifacts: p.artifacts } : {}),
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
  /** A graceful-overflow-recovery adjustment: the loop trimmed/reduced and is retrying.
   *  The within-turn airbag - distinct from `context.compacted`, the durable cross-turn fold. */
  assistantRecovered: (p: {
    runId: string;
    action: "trim" | "reduce-thinking";
    detail: string;
    reclaimed: number;
  }): TrevorEventInput => ({
    type: "assistant.recovered",
    payload: { runId: p.runId, action: p.action, detail: p.detail, reclaimed: p.reclaimed },
  }),
  /**
   * A durable cross-turn compaction fold (D-040…D-043): the rolling summary that keeps the
   * prompt projection under the window. Appended, never mutating the log; each fold supersedes
   * the prior (the rolling chain), so the prompt-builder takes the latest. The manifest is this
   * fold's delta. Distinct from `assistant.recovered`, the within-turn airbag.
   */
  contextCompacted: (p: {
    foldId: string;
    throughSeq: number;
    supersedes?: string;
    summary: string;
    manifest: CompactionManifest;
    tokensBefore: number;
    tokensAfter: number;
    model: string;
  }): TrevorEventInput => ({
    type: "context.compacted",
    payload: {
      foldId: p.foldId,
      throughSeq: p.throughSeq,
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      summary: p.summary,
      manifest: p.manifest,
      tokensBefore: p.tokensBefore,
      tokensAfter: p.tokensAfter,
      model: p.model,
    },
  }),
  /**
   * A live, advisory progress tick while a fold's summary is being generated (D-040): the rolling
   * summary streams, so the UI fills a transient progress bar from `tokens` against `budget`. The
   * matching `context.compacted` ends the fold and the bar vanishes. Like `assistant.progress`,
   * this is advisory (need not be replay-perfect) - honest per tick (real tokens streamed so far),
   * never a predicted percentage.
   */
  contextCompacting: (p: { foldId: string; tokens: number; budget: number }): TrevorEventInput => ({
    type: "context.compacting",
    payload: { foldId: p.foldId, tokens: p.tokens, budget: p.budget },
  }),
  /**
   * A live, mid-turn usage snapshot. Each model step reports its prompt size, so
   * the UI's context meter can grow as the turn runs instead of jumping only at
   * completion. The terminal assistant.completed still carries the authoritative
   * final usage + breakdown; these are advisory and need not be persisted-perfect.
   */
  assistantProgress: (p: {
    runId: string;
    usage: Usage;
    breakdown?: UsageBreakdown;
  }): TrevorEventInput => ({
    type: "assistant.progress",
    payload: {
      runId: p.runId,
      usage: p.usage,
      ...(p.breakdown ? { breakdown: p.breakdown } : {}),
    },
  }),
  assistantCompleted: (p: {
    runId: string;
    text: string;
    usage?: Usage;
    breakdown?: UsageBreakdown;
    error?: string;
    cancelled?: boolean;
    interrupted?: boolean;
    noReply?: boolean;
    stepLimit?: number;
  }): TrevorEventInput => ({
    type: "assistant.completed",
    payload: {
      runId: p.runId,
      text: p.text,
      ...(p.usage ? { usage: p.usage } : {}),
      ...(p.breakdown ? { breakdown: p.breakdown } : {}),
      ...(p.error ? { error: p.error } : {}),
      ...(p.cancelled ? { cancelled: true } : {}),
      // Closed by the host (restart/crash mid-turn reap), not by the user - rendered distinctly
      // from `cancelled` so a host hot-reload never looks like the user pressed ESC.
      ...(p.interrupted ? { interrupted: true } : {}),
      ...(p.noReply ? { noReply: true } : {}),
      // Step count when the turn was budget-terminated (step backstop or context gate);
      // omitted on a normal turn. A forced final answer still streams; this flags WHY.
      ...(p.stepLimit ? { stepLimit: p.stepLimit } : {}),
    },
  }),
  /** User asked to cancel the active run (hard steering / ESC). */
  userCancel: (p: { runId: string }): TrevorEventInput => ({
    type: "user.cancel",
    payload: { runId: p.runId },
  }),
  /** Browser invokes an immediate host command, bypassing the model/turn queue. */
  userCommand: (p: { command: string; args: string }): TrevorEventInput => ({
    type: "user.command",
    payload: { command: p.command, args: p.args },
  }),
  /** Host's immediate result for a user.command (rendered, never fed to the model). */
  commandResult: (p: { command: string; text: string; ok: boolean }): TrevorEventInput => ({
    type: "command.result",
    payload: { command: p.command, text: p.text, ok: p.ok },
  }),
  /**
   * Browser asks the host to open a file in the local editor. A side-channel
   * action - not part of the conversation, so it never renders in the transcript
   * nor reaches the model. The host runs its configured editor CLI.
   */
  editorOpen: (p: { path: string; line?: number; column?: number }): TrevorEventInput => ({
    type: "editor.open",
    payload: {
      path: p.path,
      ...(p.line != null ? { line: p.line } : {}),
      ...(p.column != null ? { column: p.column } : {}),
    },
  }),
  /** The whole task checklist after a change - a snapshot the UI renders and the host restores from. */
  tasksCurrent: (p: { tasks: readonly TaskSnapshot[] }): TrevorEventInput => ({
    type: "tasks.current",
    payload: { tasks: p.tasks },
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
    commands: readonly CommandSpec[];
  }): TrevorEventInput => ({
    type: "host.online",
    payload: {
      providers: p.providers,
      default: p.default,
      models: p.models,
      instanceId: p.instanceId,
      cwd: p.cwd,
      workspace: p.workspace,
      commands: p.commands,
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

function coerceBreakdown(value: unknown): UsageBreakdown | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const b = value as Record<string, unknown>;
  const inp = (b.input ?? {}) as Record<string, unknown>;
  const out = (b.output ?? {}) as Record<string, unknown>;
  const byToolRaw = (inp.byTool ?? {}) as Record<string, unknown>;
  const byTool: Record<string, number> = {};
  for (const [name, chars] of Object.entries(byToolRaw)) {
    byTool[name] = num(chars);
  }
  // Text categories are decoded from the shared descriptor (each pool's keys); images
  // and byTool are the explicit non-category fields.
  const input: Record<string, unknown> = {
    imagesBase64: num(inp.imagesBase64),
    imageCount: num(inp.imageCount),
    byTool,
  };
  const output: Record<string, unknown> = {};
  for (const c of BREAKDOWN_CATEGORIES) {
    if (c.pool === "input") {
      input[c.key] = num(inp[c.key]);
    } else {
      output[c.key] = num(out[c.key]);
    }
  }
  return { input, output } as UsageBreakdown;
}

/** Coerces a payload array of objects via `map`, skipping non-objects and nulls. */
function coerceArray<T>(value: unknown, map: (raw: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: T[] = [];
  for (const raw of value) {
    if (raw && typeof raw === "object") {
      const item = map(raw as Record<string, unknown>);
      if (item) {
        out.push(item);
      }
    }
  }
  return out;
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
];

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function coerceCommands(value: unknown): CommandSpec[] {
  return coerceArray(value, (c) => {
    const name = str(c.name);
    return name ? { name, summary: str(c.summary), usage: optStr(c.usage) } : null;
  });
}

function coerceTasks(value: unknown): TaskSnapshot[] {
  return coerceArray(value, (t) => {
    const id = str(t.id);
    if (!id) {
      return null;
    }
    const subject = str(t.subject);
    const status = TASK_STATUSES.includes(t.status as TaskStatus)
      ? (t.status as TaskStatus)
      : "pending";
    return {
      id,
      subject,
      activeForm: str(t.activeForm) || subject,
      status,
      blockedBy: strList(t.blockedBy),
      blocks: strList(t.blocks),
    };
  });
}

function coerceManifest(value: unknown): CompactionManifest {
  const m = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const range = (m.turnRange && typeof m.turnRange === "object" ? m.turnRange : {}) as Record<
    string,
    unknown
  >;
  return {
    turnRange: { fromSeq: num(range.fromSeq), toSeq: num(range.toSeq) },
    files: strList(m.files),
    tools: strList(m.tools),
    topics: strList(m.topics),
  };
}

const ARTIFACT_KINDS: readonly ArtifactRef["kind"][] = ["image", "document", "file"];

function coerceArtifacts(value: unknown): ArtifactRef[] {
  return coerceArray(value, (a) => {
    const hash = str(a.hash);
    if (!HEX64.test(hash)) {
      return null;
    }
    const kind = ARTIFACT_KINDS.includes(a.kind as ArtifactRef["kind"])
      ? (a.kind as ArtifactRef["kind"])
      : "file";
    const name = optStr(a.name);
    return {
      kind,
      mimeType: str(a.mimeType, "application/octet-stream"),
      size: num(a.size),
      hash,
      ...(name ? { name } : {}),
    };
  });
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
      // Default to "cloud": only an explicit "local" marks an on-machine model, so an
      // older host that doesn't announce kind reads as cloud (never mislabeled local).
      kind: m.kind === "local" ? "local" : "cloud",
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
      readonly artifacts: readonly ArtifactRef[];
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
      readonly type: "assistant.recovered";
      readonly runId: string;
      readonly action: string;
      readonly detail: string;
      readonly reclaimed: number;
    }
  | {
      readonly type: "assistant.progress";
      readonly runId: string;
      readonly usage?: Usage;
      readonly breakdown?: UsageBreakdown;
    }
  | {
      readonly type: "assistant.completed";
      readonly runId: string;
      readonly text: string;
      readonly usage?: Usage;
      readonly breakdown?: UsageBreakdown;
      readonly error?: string;
      readonly cancelled: boolean;
      /** Closed by a host reap (restart/crash mid-turn), not a user cancel - rendered distinctly. */
      readonly interrupted: boolean;
      readonly noReply: boolean;
      /** Steps run when the turn hit its budget (0 = not budget-terminated). */
      readonly stepLimit: number;
    }
  | {
      readonly type: "context.compacted";
      readonly foldId: string;
      readonly throughSeq: number;
      readonly supersedes?: string;
      readonly summary: string;
      readonly manifest: CompactionManifest;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly model: string;
    }
  | {
      readonly type: "context.compacting";
      readonly foldId: string;
      readonly tokens: number;
      readonly budget: number;
    }
  | { readonly type: "user.cancel"; readonly runId: string }
  | { readonly type: "user.command"; readonly command: string; readonly args: string }
  | {
      readonly type: "command.result";
      readonly command: string;
      readonly text: string;
      readonly ok: boolean;
    }
  | {
      readonly type: "editor.open";
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  | { readonly type: "tasks.current"; readonly tasks: readonly TaskSnapshot[] }
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
      /** The provider key the host announces as its default (host-owned; the UI's
       *  initial selection derives from this, never a hardcoded key). */
      readonly default?: string;
      readonly providers: readonly string[];
      readonly models: Record<string, ProviderModel>;
      readonly commands: readonly CommandSpec[];
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
        artifacts: coerceArtifacts(p.artifacts),
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
    case "assistant.recovered":
      return {
        type: "assistant.recovered",
        runId,
        action: str(p.action, "trim"),
        detail: str(p.detail),
        reclaimed: num(p.reclaimed),
      };
    case "assistant.progress":
      return {
        type: "assistant.progress",
        runId,
        usage: coerceUsage(p.usage),
        breakdown: coerceBreakdown(p.breakdown),
      };
    case "assistant.completed":
      return {
        type: "assistant.completed",
        runId,
        text: str(p.text),
        usage: coerceUsage(p.usage),
        breakdown: coerceBreakdown(p.breakdown),
        error: optStr(p.error),
        cancelled: p.cancelled === true,
        interrupted: p.interrupted === true,
        noReply: p.noReply === true,
        stepLimit: typeof p.stepLimit === "number" ? p.stepLimit : 0,
      };
    case "context.compacted":
      return {
        type: "context.compacted",
        // A fold without an explicit id falls back to the event's own id, so the rolling
        // chain still links (supersedes references a foldId) even on a forward-compat event.
        foldId: str(p.foldId, event.eventId),
        throughSeq: num(p.throughSeq),
        supersedes: optStr(p.supersedes),
        summary: str(p.summary),
        manifest: coerceManifest(p.manifest),
        tokensBefore: num(p.tokensBefore),
        tokensAfter: num(p.tokensAfter),
        model: str(p.model, "model"),
      };
    case "context.compacting":
      return {
        type: "context.compacting",
        foldId: str(p.foldId, event.eventId),
        tokens: num(p.tokens),
        budget: num(p.budget),
      };
    case "user.cancel":
      return { type: "user.cancel", runId };
    case "user.command":
      return { type: "user.command", command: str(p.command), args: str(p.args) };
    case "command.result":
      return {
        type: "command.result",
        command: str(p.command),
        text: str(p.text),
        ok: p.ok === true,
      };
    case "editor.open":
      return {
        type: "editor.open",
        path: str(p.path),
        line: typeof p.line === "number" ? p.line : undefined,
        column: typeof p.column === "number" ? p.column : undefined,
      };
    case "tasks.current":
      return { type: "tasks.current", tasks: coerceTasks(p.tasks) };
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
        default: optStr(p.default),
        providers: strList(p.providers),
        models: coerceProviderModels(p.models),
        commands: coerceCommands(p.commands),
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

import { HEX64 } from "./blob";
import { BREAKDOWN_CATEGORIES, emptyBreakdown, type UsageBreakdown } from "./breakdown";
import { asAnyNumber, asMaybeString, asString, asStringArray } from "./coerce";
import { type CommandMenuPayload, decodeCommandMenu } from "./command-menu";
import { coerceInternetSnapshot, type InternetSnapshot } from "./connectivity";
import type { SessionEvent } from "./event";
import {
  type CatalogEntry,
  decodeCatalogEntry,
  decodeModelRef,
  decodeSourceSignIn,
  decodeSourceSummary,
  type ModelRef,
  type SourceSignInState,
  type SourceSummary,
} from "./model-source";
import type { PastePayload } from "./paste-tokens";
import type {
  AgentSpec,
  ArtifactRef,
  CommandSpec,
  CompactionManifest,
  GitStatus,
  HandoffMode,
  ProviderDiagnostic,
  ProviderIncidentReason,
  ProviderModel,
  TaskSnapshot,
  TaskStatus,
  TurnStop,
  TurnStopAction,
  Usage,
  WorktreeSummary,
} from "./protocol";
import {
  decodeProviderQuestionAnswer,
  decodeProviderQuestionContract,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
} from "./provider-question";

// --- consume side: permissive coercion + discriminated decode ---
//
// The four wire helpers below are aliases for the shared `coerce` leaf, kept under their short local
// names so the dense decode arms stay readable: `str`/`optStr`/`num` allow empty strings and
// non-finite numbers (the char-count fields ride them), and `strList` is the string-array filter.
const str = asString;
const optStr = asMaybeString;
const num = asAnyNumber;
const strList = asStringArray;

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
  // Start from the canonical zero shape (every category key seeded once) and overlay the decoded
  // values, so the pool keys come from breakdown.ts's descriptor walk rather than a second copy.
  const result = emptyBreakdown();
  const input = result.input as unknown as Record<string, number>;
  const output = result.output as unknown as Record<string, number>;
  const byTool = result.input.byTool as Record<string, number>;
  for (const [name, chars] of Object.entries((inp.byTool ?? {}) as Record<string, unknown>)) {
    byTool[name] = num(chars);
  }
  input.imagesBase64 = num(inp.imagesBase64);
  input.imageCount = num(inp.imageCount);
  for (const c of BREAKDOWN_CATEGORIES) {
    if (c.pool === "input") {
      input[c.key] = num(inp[c.key]);
    } else {
      output[c.key] = num(out[c.key]);
    }
  }
  return result;
}

function coerceTurnStop(value: unknown): TurnStop | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const cause = str(raw.cause);
  const action = str(raw.action);
  if (!cause || !action) {
    return undefined;
  }
  const contextRaw =
    raw.context && typeof raw.context === "object" && !Array.isArray(raw.context)
      ? (raw.context as Record<string, unknown>)
      : undefined;
  return {
    cause,
    action: action as TurnStopAction,
    summary: str(raw.summary),
    ...(typeof raw.steps === "number" ? { steps: raw.steps } : {}),
    ...(contextRaw
      ? {
          context: {
            inputTokens: num(contextRaw.inputTokens),
            contextWindow: num(contextRaw.contextWindow),
            pressure: num(contextRaw.pressure),
          },
        }
      : {}),
    ...(raw.diagnosticRef === null ? { diagnosticRef: null } : {}),
    ...(typeof raw.diagnosticRef === "string" ? { diagnosticRef: raw.diagnosticRef } : {}),
  };
}

function coerceProviderDiagnostic(value: unknown): ProviderDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const provider = str(raw.provider);
  const phase = str(raw.phase);
  const reason = str(raw.reason);
  if (!provider || !phase || !reason) {
    return undefined;
  }
  const partialsRaw =
    raw.partials && typeof raw.partials === "object" && !Array.isArray(raw.partials)
      ? (raw.partials as Record<string, unknown>)
      : {};
  const model = optStr(raw.model);
  const status = typeof raw.status === "number" ? raw.status : undefined;
  const code = optStr(raw.code);
  const requestId = optStr(raw.requestId);
  return {
    provider,
    ...(model ? { model } : {}),
    phase,
    reason: reason as ProviderIncidentReason,
    retryable: raw.retryable === true,
    safeToRetry: raw.safeToRetry === true,
    attempt: num(raw.attempt),
    detail: str(raw.detail),
    partials: {
      textChars: num(partialsRaw.textChars),
      thinkingChars: num(partialsRaw.thinkingChars),
      toolCalls: num(partialsRaw.toolCalls),
      toolResults: num(partialsRaw.toolResults),
    },
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
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

function coerceCommands(value: unknown): CommandSpec[] {
  return coerceArray(value, (c) => {
    const name = str(c.name);
    return name ? { name, summary: str(c.summary), usage: optStr(c.usage) } : null;
  });
}

function coerceAgents(value: unknown): AgentSpec[] {
  return coerceArray(value, (a) => {
    const id = str(a.id);
    return id
      ? { id, description: str(a.description), tools: strList(a.tools), skills: strList(a.skills) }
      : null;
  });
}

function coerceWorktrees(value: unknown): WorktreeSummary[] {
  return coerceArray(value, (w) => {
    const id = str(w.id);
    if (!id) {
      return null;
    }
    return {
      id,
      baseRepo: str(w.baseRepo),
      baseRepoName: str(w.baseRepoName),
      branch: str(w.branch),
      path: str(w.path),
      sessionId: str(w.sessionId),
      dirty: w.dirty === true,
      ahead: num(w.ahead),
      behind: num(w.behind),
      conflict: w.conflict === true,
      detached: w.detached === true,
      current: w.current === true,
      baseline: w.baseline === true,
      missing: w.missing === true,
    };
  });
}

function coerceGitStatus(value: unknown): GitStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const g = value as Record<string, unknown>;
  return {
    branch: optStr(g.branch) ?? null,
    detached: optStr(g.detached) ?? null,
    dirty: g.dirty === true,
    ahead: num(g.ahead),
    behind: num(g.behind),
    upstream: g.upstream === true,
    worktree: g.worktree === true,
  };
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

/**
 * Coerces the pasted-text payloads on a user.message (10-large-paste-placeholders): each item must
 * carry a `text` string, preserved EXACTLY (no coercion/trim) so the model receives byte-for-byte
 * what was pasted. Junk items are dropped, so a malformed payload never crashes the decode. A legacy
 * message with no `pastes` decodes to `[]`.
 */
function coercePastes(value: unknown): PastePayload[] {
  return coerceArray(value, (p) => (typeof p.text === "string" ? { text: p.text } : null));
}

/** Coerces the announced per-source catalog (D-065): `{ sourceId: CatalogEntry[] }`, tolerant of junk. */
function coerceCatalog(value: unknown): Record<string, readonly CatalogEntry[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, readonly CatalogEntry[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = Array.isArray(raw) ? raw.map(decodeCatalogEntry) : [];
  }
  return out;
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
      /** The selected model reference (D-065 migration), when the producer sent one. */
      readonly model?: ModelRef;
      readonly artifacts: readonly ArtifactRef[];
      /** Exact pasted-text payloads paired to the message's `[Pasted text #N +M lines]` tokens, in
       *  reading order (10-large-paste-placeholders). `[]` on a legacy message with no pastes. */
      readonly pastes: readonly PastePayload[];
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
      readonly type: "assistant.continued";
      readonly runId: string;
      readonly steps: number;
      readonly pressure: number;
      readonly threshold: number;
      readonly detail: string;
    }
  | {
      readonly type: "assistant.reconnecting";
      readonly runId: string;
      readonly attempt: number;
      readonly maxAttempts?: number;
      readonly detail: string;
      readonly diagnostic?: ProviderDiagnostic;
    }
  | {
      readonly type: "delegated.to";
      readonly runId: string;
      readonly childSessionId: string;
      readonly agent: string;
      readonly task: string;
      readonly mode: string;
      readonly status: string;
      readonly result?: string;
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
      readonly stop?: TurnStop;
      readonly diagnostic?: ProviderDiagnostic;
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
      /** An optional host-owned nested command menu (plan 03); absent for plain text results. */
      readonly menu?: CommandMenuPayload;
    }
  | { readonly type: "session.switch"; readonly sessionId: string; readonly reason: string }
  | { readonly type: "session.archived"; readonly archived: boolean }
  | { readonly type: "session.title"; readonly title: string }
  | { readonly type: "session.deleted"; readonly deleted: boolean }
  | { readonly type: "user.shell"; readonly requestId: string; readonly command: string }
  | {
      readonly type: "shell.result";
      readonly requestId: string;
      readonly command: string;
      readonly output: string;
      readonly ok: boolean;
    }
  | {
      readonly type: "editor.open";
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  | {
      readonly type: "tasks.current";
      readonly tasks: readonly TaskSnapshot[];
      /** Monotonic freshness revision; legacy events without it decode to LEGACY_TASK_REVISION (0). */
      readonly rev: number;
    }
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
      readonly type: "tool.guardrail";
      readonly runId: string;
      readonly callId: string;
      readonly name: string;
      /** "warn" | "block" | "halt" (an `allow` never rides the wire); kept open for forward-compat. */
      readonly action: string;
      /** "repeated_failure" | "no_progress"; kept open for forward-compat reasons. */
      readonly reason: string;
      readonly count: number;
      readonly argsFingerprint: string;
      readonly resultFingerprint?: string;
      readonly failureFingerprint?: string;
    }
  | {
      readonly type: "host.online";
      readonly branch?: string;
      readonly git?: GitStatus;
      readonly instanceId?: string;
      readonly workspace?: string;
      readonly cwd?: string;
      /** The provider key the host announces as its default (host-owned; the UI's
       *  initial selection derives from this, never a hardcoded key). */
      readonly default?: string;
      readonly providers: readonly string[];
      readonly models: Record<string, ProviderModel>;
      readonly commands: readonly CommandSpec[];
      readonly agents: readonly AgentSpec[];
      readonly worktrees: readonly WorktreeSummary[];
      /** Latest internet snapshot (D-060), or unknown when the host announced none. */
      readonly internet: InternetSnapshot;
      /** Host-owned model sources (D-065), empty when the host announced none. */
      readonly sources: readonly SourceSummary[];
      /** Per-source model catalog (D-065), keyed by sourceId; empty when none announced. */
      readonly catalog: Readonly<Record<string, readonly CatalogEntry[]>>;
    }
  | {
      readonly type: "provider.question.requested";
      readonly questionId: string;
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly adapter: string;
      readonly contract: ProviderQuestionContract;
    }
  | {
      readonly type: "provider.question.answer";
      readonly questionId: string;
      readonly answer: ProviderQuestionAnswer;
    }
  | {
      readonly type: "provider.question.resolved";
      readonly questionId: string;
      readonly runId: string;
      readonly toolCallId: string;
      /** "answered" | "declined" | "cancelled" | "expired"; kept open for forward-compat outcomes. */
      readonly outcome: string;
      readonly summary: string;
    }
  | {
      readonly type: "handoff.requested";
      readonly handoffId: string;
      readonly mode: HandoffMode;
      readonly sourceSessionId: string;
      readonly prompt?: string;
      readonly proposed: boolean;
    }
  | { readonly type: "handoff.generating"; readonly handoffId: string; readonly detail?: string }
  | {
      readonly type: "handoff.generated";
      readonly handoffId: string;
      readonly prompt: string;
      readonly summary?: string;
    }
  | { readonly type: "handoff.approved"; readonly handoffId: string; readonly prompt?: string }
  | { readonly type: "handoff.rejected"; readonly handoffId: string; readonly reason?: string }
  | {
      readonly type: "handoff.failed";
      readonly handoffId: string;
      readonly code: string;
      readonly detail?: string;
    }
  | {
      readonly type: "handoff.accepted";
      readonly handoffId: string;
      readonly targetSessionId: string;
      readonly prompt: string;
    }
  | { readonly type: "host.internet"; readonly internet: InternetSnapshot }
  | { readonly type: "host.sourceAuth"; readonly auth: SourceSignInState }
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
    case "user.message": {
      // The new model reference (D-065), decoded tolerantly: a garbled/absent ref reads as undefined
      // and the host falls back to the legacy provider/reasoning below.
      const model = decodeModelRef(p.model);
      return {
        type: "user.message",
        text: str(p.text),
        provider: optStr(p.provider),
        reasoning: optStr(p.reasoning),
        ...(model ? { model } : {}),
        artifacts: coerceArtifacts(p.artifacts),
        pastes: coercePastes(p.pastes),
      };
    }
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
    case "assistant.continued":
      return {
        type: "assistant.continued",
        runId,
        steps: num(p.steps),
        pressure: num(p.pressure),
        threshold: num(p.threshold),
        detail: str(p.detail),
      };
    case "assistant.reconnecting": {
      const diagnostic = coerceProviderDiagnostic(p.diagnostic);
      return {
        type: "assistant.reconnecting",
        runId,
        attempt: num(p.attempt),
        // Optional: absent on logs written before the budget was threaded; the row falls back then.
        ...(typeof p.maxAttempts === "number" ? { maxAttempts: p.maxAttempts } : {}),
        detail: str(p.detail),
        ...(diagnostic ? { diagnostic } : {}),
      };
    }
    case "delegated.to":
      return {
        type: "delegated.to",
        runId,
        childSessionId: str(p.childSessionId),
        agent: str(p.agent, "general-purpose"),
        task: str(p.task),
        mode: str(p.mode, "inline"),
        status: str(p.status, "running"),
        result: optStr(p.result),
      };
    case "assistant.progress":
      return {
        type: "assistant.progress",
        runId,
        usage: coerceUsage(p.usage),
        breakdown: coerceBreakdown(p.breakdown),
      };
    case "assistant.completed": {
      const diagnostic = coerceProviderDiagnostic(p.diagnostic);
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
        stop: coerceTurnStop(p.stop),
        ...(diagnostic ? { diagnostic } : {}),
      };
    }
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
    case "command.result": {
      const menu = decodeCommandMenu(p.menu);
      return {
        type: "command.result",
        command: str(p.command),
        text: str(p.text),
        ok: p.ok === true,
        ...(menu ? { menu } : {}),
      };
    }
    case "session.switch":
      return {
        type: "session.switch",
        sessionId: str(p.sessionId),
        reason: str(p.reason),
      };
    case "session.archived":
      return { type: "session.archived", archived: p.archived === true };
    case "session.title":
      return { type: "session.title", title: str(p.title) };
    case "session.deleted":
      return { type: "session.deleted", deleted: p.deleted === true };
    case "user.shell":
      // A missing requestId falls back to the event's own id, so a forward-compat event still
      // pairs with its result rather than collapsing distinct shell runs together.
      return {
        type: "user.shell",
        requestId: str(p.requestId, event.eventId),
        command: str(p.command),
      };
    case "shell.result":
      return {
        type: "shell.result",
        requestId: str(p.requestId, event.eventId),
        command: str(p.command),
        output: str(p.output),
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
      return { type: "tasks.current", tasks: coerceTasks(p.tasks), rev: num(p.rev) };
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
    case "tool.guardrail": {
      const resultFingerprint = optStr(p.resultFingerprint);
      const failureFingerprint = optStr(p.failureFingerprint);
      return {
        type: "tool.guardrail",
        runId,
        callId: str(p.callId, event.eventId),
        name: str(p.name, "tool"),
        action: str(p.action, "warn"),
        reason: str(p.reason, "no_progress"),
        count: num(p.count),
        argsFingerprint: str(p.argsFingerprint),
        ...(resultFingerprint ? { resultFingerprint } : {}),
        ...(failureFingerprint ? { failureFingerprint } : {}),
      };
    }
    case "host.online":
      return {
        type: "host.online",
        branch: optStr(p.branch),
        git: coerceGitStatus(p.git),
        instanceId: optStr(p.instanceId),
        workspace: optStr(p.workspace),
        cwd: optStr(p.cwd),
        default: optStr(p.default),
        providers: strList(p.providers),
        models: coerceProviderModels(p.models),
        commands: coerceCommands(p.commands),
        agents: coerceAgents(p.agents),
        worktrees: coerceWorktrees(p.worktrees),
        internet: coerceInternetSnapshot(p.internet),
        sources: Array.isArray(p.sources) ? p.sources.map(decodeSourceSummary) : [],
        catalog: coerceCatalog(p.catalog),
      };
    case "provider.question.requested":
      return {
        type: "provider.question.requested",
        questionId: str(p.questionId, event.eventId),
        runId,
        toolCallId: str(p.toolCallId, event.eventId),
        toolName: str(p.toolName, "ask_user"),
        adapter: str(p.adapter, "ask_user"),
        contract: decodeProviderQuestionContract(p.contract),
      };
    case "provider.question.answer":
      return {
        type: "provider.question.answer",
        questionId: str(p.questionId, event.eventId),
        answer: decodeProviderQuestionAnswer(p.answer),
      };
    case "provider.question.resolved":
      return {
        type: "provider.question.resolved",
        questionId: str(p.questionId, event.eventId),
        runId,
        toolCallId: str(p.toolCallId, event.eventId),
        outcome: str(p.outcome, "answered"),
        summary: str(p.summary),
      };
    case "handoff.requested":
      return {
        type: "handoff.requested",
        handoffId: str(p.handoffId, event.eventId),
        mode: p.mode === "direct" ? "direct" : "generate",
        sourceSessionId: str(p.sourceSessionId, event.sessionId),
        ...(typeof p.prompt === "string" ? { prompt: p.prompt } : {}),
        proposed: p.proposed === true,
      };
    case "handoff.generating":
      return {
        type: "handoff.generating",
        handoffId: str(p.handoffId, event.eventId),
        ...(optStr(p.detail) ? { detail: str(p.detail) } : {}),
      };
    case "handoff.generated":
      return {
        type: "handoff.generated",
        handoffId: str(p.handoffId, event.eventId),
        prompt: str(p.prompt),
        ...(optStr(p.summary) ? { summary: str(p.summary) } : {}),
      };
    case "handoff.approved":
      return {
        type: "handoff.approved",
        handoffId: str(p.handoffId, event.eventId),
        ...(typeof p.prompt === "string" ? { prompt: p.prompt } : {}),
      };
    case "handoff.rejected":
      return {
        type: "handoff.rejected",
        handoffId: str(p.handoffId, event.eventId),
        ...(optStr(p.reason) ? { reason: str(p.reason) } : {}),
      };
    case "handoff.failed":
      return {
        type: "handoff.failed",
        handoffId: str(p.handoffId, event.eventId),
        code: str(p.code, "unknown"),
        ...(optStr(p.detail) ? { detail: str(p.detail) } : {}),
      };
    case "handoff.accepted":
      return {
        type: "handoff.accepted",
        handoffId: str(p.handoffId, event.eventId),
        targetSessionId: str(p.targetSessionId),
        prompt: str(p.prompt),
      };
    case "host.internet":
      return { type: "host.internet", internet: coerceInternetSnapshot(p.internet) };
    case "host.sourceAuth":
      return { type: "host.sourceAuth", auth: decodeSourceSignIn(p) };
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

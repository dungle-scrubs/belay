import { HEX64 } from "../blob";
import { BREAKDOWN_CATEGORIES, emptyBreakdown, type UsageBreakdown } from "../breakdown";
import { asAnyNumber, asMaybeString, asOptRecord, asString, asStringArray, oneOf } from "../coerce";
import { decodeCommandMenu } from "../command-menu";
import { coerceInternetSnapshot } from "../connectivity";
import type { SessionEvent } from "../event";
import { type FileMatch, isWorkspaceRelativePath, MAX_FILE_INDEX } from "../file-mention";
import type { LoopSnapshot } from "../loop-command";
import {
  LOOP_DURABILITIES,
  LOOP_LIFECYCLES,
  LOOP_RUNNERS,
  LOOP_STOP_REASONS,
} from "../loop-command";
import { decodeLucidAnnotations, decodeLucidMeta, LUCID_PROVENANCES } from "../lucid";
import {
  type CatalogEntry,
  decodeCatalogEntry,
  decodeModelRef,
  decodeSourceSignIn,
  decodeSourceSummary,
  type ModelRef,
} from "../model-source";
import type { PastePayload } from "../paste-tokens";
import {
  decodeProviderQuestionAnswer,
  decodeProviderQuestionContract,
  PROVIDER_QUESTION_ADAPTERS,
} from "../provider-question";
import { LIMIT_STATUSES } from "../usage-limit";
import type {
  AgentSpec,
  ArtifactRef,
  CommandSpec,
  CompactionManifest,
  GitStatus,
  HandoffMode,
  JobSnapshot,
  ModelSwitchEndpoint,
  ProviderDiagnostic,
  ProviderIncidentReason,
  ProviderModel,
  SupersedeReason,
  SupervisorProject,
  TaskSnapshot,
  TaskStatus,
  TurnStop,
  TurnStopAction,
  Usage,
  WorktreeSummary,
} from "./events";
import { SESSION_LAUNCH_STATUSES } from "./events";
import { createProtocolRegistry, type EventFamily } from "./registry";
import { field, type WireDecoded, wireEvent } from "./wire";

// --- consume side: permissive coercion + discriminated decode ---
//
// The four wire helpers below are aliases for the shared `coerce` leaf, kept under their short local
// names so the dense decode arms stay readable: `str`/`optStr`/`num` allow empty strings and
// non-finite numbers (the char-count fields ride them), and `strList` is the string-array filter.
const str = asString;
const optStr = asMaybeString;
const num = asAnyNumber;
const strList = asStringArray;

/**
 * Decodes the `projects.list.result` project list defensively (plan 44.1): keep only object entries
 * that carry a non-empty `root` AND `sessionId` (the two identity fields), dropping malformed or
 * partial rows, and pass `updatedAt` through as a string. Preserves the sender's order (the supervisor
 * sorts by recency before publishing), and a non-array reads as empty.
 */
function decodeSupervisorProjects(value: unknown): SupervisorProject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: SupervisorProject[] = [];
  for (const item of value) {
    const rec = asOptRecord(item);
    if (!rec) {
      continue;
    }
    const root = asString(rec.root);
    const sessionId = asString(rec.sessionId);
    if (!root || !sessionId) {
      continue;
    }
    out.push({
      root,
      sessionId,
      updatedAt: asString(rec.updatedAt),
      // `missing` is additive (plan 58.8): only a literal boolean rides through; anything else
      // (absent, malformed) reads as "not reported" so older supervisors decode unchanged.
      ...(typeof rec.missing === "boolean" ? { missing: rec.missing } : {}),
    });
  }
  return out;
}

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

function coerceLoopSnapshot(value: unknown): LoopSnapshot {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const max = typeof raw.max === "number" ? raw.max : undefined;
  const nextRun = typeof raw.nextRun === "number" ? raw.nextRun : undefined;
  const stopReason = oneOf(LOOP_STOP_REASONS, raw.stopReason, "stopped");
  const error = optStr(raw.error);
  return {
    completed: num(raw.completed),
    durability: oneOf(LOOP_DURABILITIES, raw.durability, "session"),
    ...(error ? { error } : {}),
    loopId: str(raw.loopId),
    ...(max !== undefined ? { max } : {}),
    ...(nextRun !== undefined ? { nextRun } : {}),
    runner: oneOf(LOOP_RUNNERS, raw.runner, "current_session_prompt"),
    status: oneOf(LOOP_LIFECYCLES, raw.status, "draft"),
    ...(raw.stopReason !== undefined ? { stopReason } : {}),
    summary: str(raw.summary),
  };
}

function coerceCommands(value: unknown): CommandSpec[] {
  return coerceArray(value, (c) => {
    const name = str(c.name);
    if (!name) {
      return null;
    }
    const argumentHint = optStr(c.argumentHint);
    const body = optStr(c.body);
    return {
      name,
      summary: str(c.summary),
      usage: optStr(c.usage),
      ...(argumentHint !== undefined ? { argumentHint } : {}),
      ...(body !== undefined ? { body } : {}),
    };
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
    // The Lucid addressability sidecar (plan 27) is decoded tolerantly and kept SEPARATE from the
    // blob fields: a garbled/absent marker reads as undefined, degrading to the plain HTML viewer.
    const lucid = decodeLucidMeta(a.lucid);
    return {
      kind,
      mimeType: str(a.mimeType, "application/octet-stream"),
      size: num(a.size),
      hash,
      ...(name ? { name } : {}),
      ...(lucid ? { lucid } : {}),
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

/** Coerces the announced background jobs (plan 09), tolerant of junk: keeps each entry with a string id
 *  + command + a known lifecycle, normalizing the optional/origin fields the support panel reads. */
function coerceJobs(value: unknown): readonly JobSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const lifecycles = new Set(["running", "exited", "killed"]);
  const sources = new Set(["process", "bash", "shell"]);
  const jobs: JobSnapshot[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const j = raw as Record<string, unknown>;
    if (typeof j.id !== "string" || typeof j.command !== "string") {
      continue;
    }
    const status = lifecycles.has(j.status as string)
      ? (j.status as JobSnapshot["status"])
      : "running";
    const source = sources.has(j.source as string)
      ? (j.source as JobSnapshot["source"])
      : "process";
    jobs.push({
      id: j.id,
      command: j.command,
      source,
      ...(typeof j.runId === "string" ? { runId: j.runId } : {}),
      ...(typeof j.callId === "string" ? { callId: j.callId } : {}),
      ...(typeof j.requestId === "string" ? { requestId: j.requestId } : {}),
      cwd: typeof j.cwd === "string" ? j.cwd : "",
      startedAt: typeof j.startedAt === "number" ? j.startedAt : 0,
      ...(typeof j.promotedAt === "number" ? { promotedAt: j.promotedAt } : {}),
      status,
      exitCode: typeof j.exitCode === "number" ? j.exitCode : null,
      stdoutTotal: typeof j.stdoutTotal === "number" ? j.stdoutTotal : 0,
      stderrTotal: typeof j.stderrTotal === "number" ? j.stderrTotal : 0,
      ...(typeof j.tail === "string" ? { tail: j.tail } : {}),
    });
  }
  return jobs;
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

/**
 * Decodes the host-owned model preference (plan 51) off `host.online`: the durable default (a single
 * {@link ModelRef}, or null) + the favorites (pinned refs). Reuses the single tolerant {@link decodeModelRef}
 * so a partial/garbled ref drops out, and defaults to `{ default: null, pinned: [] }` for a host that
 * omits the field entirely (older host - back-compat).
 */
function decodeModelPrefs(value: unknown): {
  readonly default: ModelRef | null;
  readonly pinned: readonly ModelRef[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { default: null, pinned: [] };
  }
  const p = value as Record<string, unknown>;
  const pinned = Array.isArray(p.pinned)
    ? p.pinned.map(decodeModelRef).filter((r): r is ModelRef => r != null)
    : [];
  return { default: decodeModelRef(p.default), pinned };
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
// --- the wire-event tables: one definition per event yields the decoded type AND the decoder ---
//
// Each event below is a single `wireEvent` spec (see ./wire): its field table IS the payload
// contract - the decoded TypeScript arm derives from it (`WireDecoded`), and the permissive
// decoder is driven by it, so the two can never drift. Field leniency is the same shared
// `../coerce` vocabulary the hand-written arms used; nested values (usage, breakdown, stop,
// diagnostics, catalogs, ...) still delegate to the sibling coercers above, which stay
// compiler-checked against their interfaces in ./events.

/** Decodes one side of a model switch tolerantly: a garbled endpoint reads as an empty model. */
const decodeEndpoint = (value: unknown): ModelSwitchEndpoint => {
  const raw = (value ?? {}) as Record<string, unknown>;
  const reasoning = optStr(raw.reasoning);
  return { model: str(raw.model), ...(reasoning !== undefined ? { reasoning } : {}) };
};

const TRANSCRIPT_EVENTS = [
  wireEvent("user.message", {
    text: field.string(),
    provider: field.optString(),
    reasoning: field.optString(),
    // The new model reference (D-065), decoded tolerantly: a garbled/absent ref reads as undefined
    // (key absent) and the host falls back to the legacy provider/reasoning above.
    model: field.viaTruthy(decodeModelRef),
    artifacts: field.via(coerceArtifacts),
    // Exact pasted-text payloads paired to the message's `[Pasted text #N +M lines]` tokens, in
    // reading order (10-large-paste-placeholders). `[]` on a legacy message with no pastes.
    pastes: field.via(coercePastes),
  }),
  wireEvent("assistant.started", {
    runId: field.idWithEventFallback(),
    warm: field.boolean(),
    model: field.string("model"),
    provider: field.optString(),
  }),
  wireEvent("assistant.delta", {
    runId: field.idWithEventFallback(),
    text: field.string(),
  }),
  wireEvent("assistant.thinking", {
    runId: field.idWithEventFallback(),
    text: field.string(),
  }),
  wireEvent("assistant.overflow", {
    runId: field.idWithEventFallback(),
    reason: field.string("context overflow"),
  }),
  wireEvent("assistant.recovered", {
    runId: field.idWithEventFallback(),
    action: field.string("trim"),
    detail: field.string(),
    reclaimed: field.number(),
  }),
  wireEvent("assistant.continued", {
    runId: field.idWithEventFallback(),
    steps: field.number(),
    pressure: field.number(),
    threshold: field.number(),
    detail: field.string(),
  }),
  wireEvent("assistant.reconnecting", {
    runId: field.idWithEventFallback(),
    attempt: field.number(),
    // Optional: absent on logs written before the budget was threaded; the row falls back then.
    maxAttempts: field.numberKey(),
    detail: field.string(),
    diagnostic: field.viaTruthy(coerceProviderDiagnostic),
  }),
  // A provider usage-limit signal (plan 44.4): approaching/reached a rate/usage window. NOT
  // run-scoped (it reflects the provider/session, not one turn's output). Status coerces to the
  // safe `reached` default for a forward-compat/garbled value; resetsAt/utilization stay ABSENT
  // unless a finite number is present (never defaulted to 0, which would misread as "resets at
  // the epoch / 0% used").
  wireEvent("assistant.limit", {
    provider: field.string(),
    status: field.oneOf(LIMIT_STATUSES, "reached"),
    scope: field.string("unknown"),
    resetsAt: field.finiteNumberKey(),
    utilization: field.finiteNumberKey(),
  }),
  wireEvent("model.switched", {
    runId: field.idWithEventFallback(),
    from: field.via(decodeEndpoint),
    to: field.via(decodeEndpoint),
    initiator: field.oneOf(["auto", "manual"] as const, "manual"),
    outcome: field.oneOf(["blocked", "applied"] as const, "applied"),
    reason: field.optString(),
  }),
  wireEvent("model.switch.requested", {
    runId: field.idWithEventFallback(),
    model: field.viaTruthy(decodeModelRef),
    initiator: field.oneOf(["auto", "manual"] as const, "manual"),
  }),
  wireEvent("delegated.to", {
    runId: field.idWithEventFallback(),
    childSessionId: field.string(),
    agent: field.string("general-purpose"),
    task: field.string(),
    mode: field.string("inline"),
    status: field.string("running"),
    result: field.optString(),
    model: field.optString(),
    reasoningLevel: field.optString(),
    tokens: field.numberOrUndefined(),
  }),
  wireEvent("workflow.started", {
    runId: field.idWithEventFallback(),
    workflow: field.string(),
    args: field.rawKey(),
  }),
  wireEvent("workflow.phase", {
    runId: field.idWithEventFallback(),
    title: field.string(),
  }),
  wireEvent("workflow.agent", {
    runId: field.idWithEventFallback(),
    ordinal: field.custom("always", (value): readonly number[] =>
      Array.isArray(value) ? value.map(num) : [],
    ),
    fingerprint: field.string(),
    status: field.oneOf(["replayed", "completed"] as const, "completed"),
    usage: field.custom("always", (value) => {
      const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      return { input: num(raw.input), output: num(raw.output) };
    }),
    result: field.raw(),
  }),
  wireEvent("workflow.leaf-failed", {
    runId: field.idWithEventFallback(),
    kind: field.string(),
    cause: field.string(),
    childSessionId: field.string(),
    detail: field.rawKey(),
  }),
  wireEvent("workflow.log", {
    runId: field.idWithEventFallback(),
    message: field.string(),
  }),
  wireEvent("workflow.completed", {
    runId: field.idWithEventFallback(),
    ok: field.boolean(),
    leaves: field.number(),
  }),
  wireEvent("assistant.progress", {
    runId: field.idWithEventFallback(),
    usage: field.via(coerceUsage),
    breakdown: field.via(coerceBreakdown),
  }),
  wireEvent("assistant.completed", {
    runId: field.idWithEventFallback(),
    text: field.string(),
    usage: field.via(coerceUsage),
    breakdown: field.via(coerceBreakdown),
    error: field.optString(),
    cancelled: field.boolean(),
    // Closed by a host reap (restart/crash mid-turn), not a user cancel - rendered distinctly.
    interrupted: field.boolean(),
    // Closed by the user steering (Esc with queued prompts). Rendered as a muted note, not red.
    steered: field.boolean(),
    noReply: field.boolean(),
    // Steps run when the turn hit its budget (0 = not budget-terminated).
    stepLimit: field.number(),
    stop: field.via(coerceTurnStop),
    diagnostic: field.viaTruthy(coerceProviderDiagnostic),
  }),
  wireEvent("context.compacted", {
    // A fold without an explicit id falls back to the event's own id, so the rolling
    // chain still links (supersedes references a foldId) even on a forward-compat event.
    foldId: field.idWithEventFallback(),
    throughSeq: field.number(),
    supersedes: field.optString(),
    summary: field.string(),
    manifest: field.via(coerceManifest),
    tokensBefore: field.number(),
    tokensAfter: field.number(),
    model: field.string("model"),
  }),
  wireEvent("context.compacting", {
    foldId: field.idWithEventFallback(),
    tokens: field.number(),
    budget: field.number(),
  }),
] as const;

const USER_CONTROL_EVENTS = [
  wireEvent("user.cancel", {
    runId: field.idWithEventFallback(),
    steered: field.boolean(),
  }),
  // The retracted ids are string eventIds (plan 47); junk entries drop out so a malformed event
  // can never supersede a message it never named. `reason` defaults to "unqueue" (the plainest
  // retraction) and is kept open for forward-compat reasons.
  wireEvent("user.supersede", {
    supersedes: field.stringList(),
    reason: field.custom("always", (value): SupersedeReason => str(value, "unqueue")),
  }),
  wireEvent("user.command", {
    command: field.string(),
    args: field.string(),
  }),
  wireEvent("command.result", {
    command: field.string(),
    text: field.string(),
    ok: field.boolean(),
    // An optional host-owned nested command menu (plan 03); absent for plain text results.
    menu: field.viaTruthy(decodeCommandMenu),
    // Transient browser focus hint for command-created sessions; not durable switch semantics.
    focusSessionId: field.truthyString(),
  }),
  // A missing requestId falls back to the event's own id, so a forward-compat event still
  // pairs with its result rather than collapsing distinct shell runs together.
  wireEvent("user.shell", {
    requestId: field.idWithEventFallback(),
    command: field.string(),
  }),
  wireEvent("shell.result", {
    requestId: field.idWithEventFallback(),
    command: field.string(),
    output: field.string(),
    ok: field.boolean(),
  }),
  wireEvent("editor.open", {
    path: field.string(),
    line: field.numberOrUndefined(),
    column: field.numberOrUndefined(),
  }),
] as const;

const SESSION_EVENTS = [
  wireEvent("session.switch", {
    sessionId: field.string(),
    reason: field.string(),
  }),
  wireEvent("session.archived", { archived: field.boolean() }),
  wireEvent("session.title", { title: field.string() }),
  wireEvent("session.deleted", { deleted: field.boolean() }),
  wireEvent("session.forkedFrom", {
    parentSessionId: field.string(),
    forkSeq: field.number(),
  }),
  wireEvent("session.tangentOf", {
    parentSessionId: field.string(),
    // The parent transcript message the selection came from.
    sourceMessageId: field.string(),
    // The selected snapshot the tangent is seeded from (the anchor quote).
    quote: field.string(),
    label: field.truthyString(),
  }),
  wireEvent("session.project", { path: field.string() }),
  wireEvent("session.worktree", {
    id: field.string(),
    branch: field.string(),
    path: field.string(),
  }),
  wireEvent("tangent.foldedBack", {
    tangentSessionId: field.string(),
    parentSessionId: field.string(),
    // "quote" | "message" | "summary"; kept open for forward-compat fold-back modes.
    mode: field.string("quote"),
    preview: field.string(),
  }),
  wireEvent("tangent.created", {
    tangentSessionId: field.string(),
    sourceMessageId: field.string(),
  }),
  wireEvent("file.index.requested", { requestId: field.idWithEventFallback() }),
  // Relative-path-only payloads: rebuild `{ path }` matches from the string list, and drop any
  // stray absolute / `..`-escaping path (the shared predicate, also applied host-side) so a
  // malformed event can never surface one to the picker. The finish step re-caps at decode time
  // to the SAME shared limit the host enumeration caps at: decode must not just trust the wire's
  // `truncated` flag - a malformed or oversized payload is clamped here too, and clamping always
  // forces truncated=true so the UI never claims a complete index it doesn't actually have.
  wireEvent(
    "file.index.result",
    {
      requestId: field.idWithEventFallback(),
      files: field.custom("always", (value): FileMatch[] =>
        strList(value)
          .filter(isWorkspaceRelativePath)
          .map((path) => ({ path })),
      ),
      truncated: field.boolean(),
    },
    (draft) => {
      const files = draft.files as readonly FileMatch[];
      return files.length > MAX_FILE_INDEX
        ? { ...draft, files: files.slice(0, MAX_FILE_INDEX), truncated: true }
        : draft;
    },
  ),
  // Supervisor side-channel (plan 44.1). A missing requestId falls back to the event's own id so
  // a forward-compat request still correlates; `status` decodes tolerantly to failed-safe.
  wireEvent("session.launch.requested", {
    requestId: field.idWithEventFallback(),
    root: field.string(),
    sessionId: field.truthyString(),
    projectPath: field.truthyString(),
  }),
  wireEvent("session.launch.result", {
    requestId: field.idWithEventFallback(),
    sessionId: field.string(),
    status: field.oneOf(SESSION_LAUNCH_STATUSES, "failed"),
    error: field.truthyString(),
  }),
  wireEvent("folder.pick.requested", { requestId: field.idWithEventFallback() }),
  wireEvent("folder.pick.result", {
    requestId: field.idWithEventFallback(),
    cancelled: field.boolean(),
    path: field.truthyString(),
  }),
  wireEvent("projects.list.requested", { requestId: field.idWithEventFallback() }),
  wireEvent("projects.list.result", {
    requestId: field.idWithEventFallback(),
    projects: field.via(decodeSupervisorProjects),
  }),
  wireEvent("project.add.requested", { requestId: field.idWithEventFallback() }),
  wireEvent("project.add.result", {
    requestId: field.idWithEventFallback(),
    cancelled: field.boolean(),
    path: field.truthyString(),
    displayName: field.truthyString(),
    error: field.truthyString(),
  }),
  wireEvent("project.rename.requested", {
    requestId: field.idWithEventFallback(),
    path: field.string(),
    displayName: field.string(),
  }),
  wireEvent("project.rename.result", {
    requestId: field.idWithEventFallback(),
    path: field.truthyString(),
    displayName: field.truthyString(),
    error: field.truthyString(),
  }),
  wireEvent("project.collapse.requested", {
    requestId: field.idWithEventFallback(),
    path: field.string(),
    collapsed: field.boolean(),
  }),
  wireEvent("project.collapse.result", {
    requestId: field.idWithEventFallback(),
    collapsed: field.boolean(),
    path: field.truthyString(),
    error: field.truthyString(),
  }),
  wireEvent("project.remove.requested", {
    requestId: field.idWithEventFallback(),
    path: field.string(),
  }),
  wireEvent("project.remove.result", {
    requestId: field.idWithEventFallback(),
    removed: field.boolean(),
    path: field.truthyString(),
    blockedBy: field.nonEmptyStringList(),
    error: field.truthyString(),
  }),
] as const;

const LUCID_EVENTS = [
  wireEvent("lucid.published", {
    lucidId: field.string(),
    version: field.custom("always", (value) => Math.max(1, Math.trunc(num(value, 1)))),
    htmlHash: field.string(),
    provenance: field.oneOf(LUCID_PROVENANCES, "agent"),
    title: field.truthyString(),
  }),
  wireEvent("lucid.feedback", {
    lucidId: field.string(),
    version: field.custom("always", (value) => Math.max(1, Math.trunc(num(value, 1)))),
    cursor: field.number(),
    annotations: field.via(decodeLucidAnnotations),
    message: field.truthyString(),
  }),
  wireEvent("lucid.review", {
    lucidId: field.string(),
    resolved: field.boolean(),
    cursor: field.number(),
  }),
] as const;

const HOST_EVENTS = [
  wireEvent("tasks.current", {
    tasks: field.via(coerceTasks),
    rev: field.number(),
  }),
  wireEvent("tool.started", {
    runId: field.idWithEventFallback(),
    callId: field.idWithEventFallback(),
    name: field.string("tool"),
    arguments: field.string(),
  }),
  wireEvent("tool.completed", {
    runId: field.idWithEventFallback(),
    callId: field.idWithEventFallback(),
    name: field.string("tool"),
    result: field.string(),
  }),
  wireEvent("tool.guardrail", {
    runId: field.idWithEventFallback(),
    callId: field.idWithEventFallback(),
    name: field.string("tool"),
    action: field.string("warn"),
    reason: field.string("no_progress"),
    count: field.number(),
    argsFingerprint: field.string(),
    resultFingerprint: field.truthyString(),
    failureFingerprint: field.truthyString(),
  }),
  wireEvent("hook.decision", {
    runId: field.idWithEventFallback(),
    hookId: field.string(),
    event: field.string("PreToolUse"),
    decision: field.string("error"),
    toolName: field.truthyString(),
    reason: field.truthyString(),
  }),
  wireEvent("host.online", {
    branch: field.optString(),
    git: field.via(coerceGitStatus),
    instanceId: field.optString(),
    workspace: field.optString(),
    cwd: field.optString(),
    default: field.optString(),
    providers: field.stringList(),
    models: field.via(coerceProviderModels),
    commands: field.via(coerceCommands),
    agents: field.via(coerceAgents),
    worktrees: field.via(coerceWorktrees),
    internet: field.via(coerceInternetSnapshot),
    sources: field.custom("always", (value) =>
      Array.isArray(value) ? value.map(decodeSourceSummary) : [],
    ),
    catalog: field.via(coerceCatalog),
    vimEnabled: field.boolean(),
    jobs: field.via(coerceJobs),
    modelPrefs: field.via(decodeModelPrefs),
  }),
  wireEvent("provider.question.requested", {
    questionId: field.idWithEventFallback(),
    runId: field.idWithEventFallback(),
    toolCallId: field.idWithEventFallback(),
    toolName: field.string("ask_user"),
    adapter: field.string(PROVIDER_QUESTION_ADAPTERS.askUser),
    contract: field.via(decodeProviderQuestionContract),
  }),
  wireEvent("provider.question.answer", {
    questionId: field.idWithEventFallback(),
    answer: field.via(decodeProviderQuestionAnswer),
  }),
  wireEvent("provider.question.resolved", {
    questionId: field.idWithEventFallback(),
    runId: field.idWithEventFallback(),
    toolCallId: field.idWithEventFallback(),
    outcome: field.string("answered"),
    summary: field.string(),
  }),
  wireEvent("handoff.requested", {
    handoffId: field.idWithEventFallback(),
    mode: field.custom(
      "always",
      (value): HandoffMode => (value === "direct" ? "direct" : "generate"),
    ),
    sourceSessionId: field.custom("always", (value, event) => str(value, event.sessionId)),
    prompt: field.stringKey(),
    proposed: field.boolean(),
  }),
  wireEvent("handoff.generating", {
    handoffId: field.idWithEventFallback(),
    detail: field.truthyString(),
  }),
  wireEvent("handoff.generated", {
    handoffId: field.idWithEventFallback(),
    prompt: field.string(),
    summary: field.truthyString(),
  }),
  wireEvent("handoff.approved", {
    handoffId: field.idWithEventFallback(),
    prompt: field.stringKey(),
  }),
  wireEvent("handoff.rejected", {
    handoffId: field.idWithEventFallback(),
    reason: field.truthyString(),
  }),
  wireEvent("handoff.failed", {
    handoffId: field.idWithEventFallback(),
    code: field.string("unknown"),
    detail: field.truthyString(),
  }),
  wireEvent("handoff.accepted", {
    handoffId: field.idWithEventFallback(),
    targetSessionId: field.string(),
    prompt: field.string(),
  }),
  wireEvent("host.internet", { internet: field.via(coerceInternetSnapshot) }),
  // The auth state rides the payload ROOT (not a nested key), so the field reads the envelope.
  wireEvent("host.sourceAuth", {
    auth: field.custom("always", (_value, event) => decodeSourceSignIn(event.payload)),
  }),
  wireEvent("loop.status", { snapshot: field.via(coerceLoopSnapshot) }),
  wireEvent("host.hello", { instanceId: field.optString() }),
  wireEvent("host.beat", { instanceId: field.optString() }),
  wireEvent("host.role", {
    instanceId: field.optString(),
    role: field.optString(),
  }),
  wireEvent("admission.status", {
    runId: field.idWithEventFallback(),
    phase: field.string("queued"),
    provider: field.string(),
    model: field.string(),
    priority: field.string("foreground"),
    position: field.numberKey(),
    refusal: field.stringKey(),
  }),
] as const;

/**
 * The decoded trevor event union, derived from the wire-event tables above: adding or
 * changing a field spec IS the type change - there is no second hand-maintained union.
 */
export type DecodedEvent =
  | WireDecoded<(typeof TRANSCRIPT_EVENTS)[number]>
  | WireDecoded<(typeof USER_CONTROL_EVENTS)[number]>
  | WireDecoded<(typeof SESSION_EVENTS)[number]>
  | WireDecoded<(typeof LUCID_EVENTS)[number]>
  | WireDecoded<(typeof HOST_EVENTS)[number]>;

/** The erased view familyOf needs: table entries differ in their spec generics. */
interface WireEventLike {
  readonly type: string;
  readonly decode: (event: SessionEvent) => unknown;
}

/** Builds an EventFamily from one wire-event table: wireNames derive from the entries
 *  (no second hand-maintained name list). The cast is sound because DecodedEvent is the
 *  union of exactly these tables' decode results. */
function familyOf(notes: string, entries: readonly WireEventLike[]): EventFamily {
  const byType = new Map(entries.map((entry) => [entry.type, entry]));
  return {
    decode: (event) => (byType.get(event.type)?.decode(event) as DecodedEvent | undefined) ?? null,
    notes,
    wireNames: entries.map((entry) => entry.type),
  };
}

const trevorEventRegistry = createProtocolRegistry([
  familyOf("User, assistant, model, delegation, and workflow turn events.", TRANSCRIPT_EVENTS),
  familyOf("User control, command, and shell/editor events.", USER_CONTROL_EVENTS),
  familyOf("Session lifecycle, lineage, supervisor, and project events.", SESSION_EVENTS),
  familyOf("Lucid artifact publication and review events.", LUCID_EVENTS),
  familyOf(
    "Host presence, source state, task, hook, tool, question, handoff, and loop events.",
    HOST_EVENTS,
  ),
]);

/**
 * Decodes one raw SessionEvent into a typed trevor event, or `null` for an unrecognized type.
 * runId/callId fall back to the event's own id so a missing correlation id never collapses distinct
 * turns together.
 */
export function decodeTrevorEvent(event: SessionEvent): DecodedEvent | null {
  return trevorEventRegistry.decode(event);
}

/** Every wire type the decoder dispatches on, derived from the tables (sorted). The decode
 *  robustness net asserts its seed corpus against this list, so corpus coverage cannot
 *  silently drift from the registry. */
export const REGISTERED_WIRE_TYPES: readonly string[] = trevorEventRegistry.wireNames();

import { discoverSkills } from "@host/skills/skills";
import type { AgentDefinition } from "@host/subagents/discovery";
import { resolveAgentTools } from "@host/subagents/discovery";
import { Emit } from "@host/transport/services";
import {
  type DecodedEvent,
  decodeTrevorEvent,
  events,
  isTerminalDelegationStatus,
  type SessionEvent,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { Effect, Layer } from "effect";
import type { ChatMessage, Provider, ToolDef } from "../providers";
import { READ_ONLY_TOOLS, TOOL_DEFS } from "../tools";
import type { DelegateCapability, TurnHooks } from "./loop";
import { publishTurn } from "./turn";

/**
 * The subagent delegation MECHANISM (D-046/D-047): run a delegated agent in its OWN isolated child
 * session and fold its distilled result back to the parent. It owns the session/link/isolation:
 *   - mint a fresh child session and seed it with ONLY the parent-authored task (the entire slice
 *     the child sees - nothing from the parent transcript leaks in),
 *   - link parent -> child with a `delegated.to` event on the PARENT session (running, then
 *     done/failed with the result - the frozen distilled message),
 *   - run the child's turn with the agent's resolved tool allow-list, publishing its lifecycle to
 *     the CHILD session, and capture its final message as the result.
 * The tool SURFACE that triggers this (delegate_inline / delegate_background) and the depth/cap
 * policy are layered on top (M3); this module is agnostic to who calls it.
 *
 * Responsible for: running a delegated subagent in an isolated child session to a distilled
 * result, plus the delegate_inline / delegate_background tool surface layered on it.
 * Not for: agent definition discovery and tool resolution - @host/subagents/discovery.
 */

/** What a delegation needs from the host: the transport, the parent session + producer to link on,
 *  and a child-session-id minter (injected so tests are deterministic). */
export interface DelegationContext {
  readonly transport: SessionTransport;
  readonly parentSessionId: string;
  readonly producerId: string;
  readonly mintChildSessionId: () => string;
  /** PreToolUse hook wiring for CHILD turns (plan 25 M5): the host-lifetime dispatcher (plus
   *  its hasHooks predicate) and the hook cwd. The child-specific identity (its session id,
   *  callerKind "subagent") is bound per child in runDelegatedChild. Absent = children run
   *  without hooks (tests). */
  readonly hooks?: Pick<TurnHooks, "dispatchPreToolUse" | "hasHooks"> & { readonly cwd: string };
}

export interface DelegationRequest {
  readonly agent: AgentDefinition;
  readonly task: string;
  readonly provider: Provider;
  /** The parent turn's run id (the delegated.to link correlates to it). */
  readonly parentRunId: string;
  /** The child turn's run id (its lifecycle in the child session). */
  readonly childRunId: string;
  /** The child's isolated session id. Pre-minted by the caller for a background child (so a spawner
   *  can track + acknowledge it before it runs); minted from the context when omitted (inline). */
  readonly childSessionId?: string;
  readonly mode: "inline" | "background";
}

export interface DelegationResult {
  readonly childSessionId: string;
  readonly result: string;
  readonly failed: boolean;
}

/** The child's isolated conversation: the agent's instructions framing ONLY the parent task. The
 *  child shares no parent transcript - this single seeded message is its entire input. Shared by the
 *  delegation entry and the workflow `agent()` leaf (plan 21 M2). */
export function childHistory(agent: AgentDefinition, task: string): ChatMessage[] {
  return [{ role: "user", content: `${agent.body}\n\n---\n\nYour task:\n${task}` }];
}

/** Publishes one event to a session through the transport, attaching the producer id. */
export function publishTo(
  ctx: DelegationContext,
  sessionId: string,
  event: TrevorEventInput,
): Promise<void> {
  return ctx.transport.publishEvent(sessionId, {
    type: event.type,
    producerId: ctx.producerId,
    payload: event.payload,
  });
}

/**
 * The shared child-session SEED (plan 21 M2): mint-agnostic. Ensures the child session, seeds it with
 * ONLY the parent task as its first user message (the entire slice it sees - no parent transcript), and
 * links parent -> child (running) on the PARENT session. Both `runDelegatedChild` and the workflow leaf
 * reuse this so the isolation invariant lives in one place.
 */
export async function seedChildSession(
  ctx: DelegationContext,
  req: DelegationRequest,
  childSessionId: string,
): Promise<void> {
  await ctx.transport.ensureSession(childSessionId);
  await publishTo(
    ctx,
    childSessionId,
    events.userMessage({ text: req.task, provider: req.provider.id }),
  );
  await publishTo(
    ctx,
    ctx.parentSessionId,
    events.delegatedTo({
      runId: req.parentRunId,
      childSessionId,
      agent: req.agent.id,
      task: req.task,
      mode: req.mode,
      status: "running",
    }),
  );
}

/** The shared FOLD-BACK link (plan 21 M2): the terminal `delegated.to` (done/failed) carrying the
 *  frozen result, on the PARENT session, so no child is ever left "running". Best-effort. */
export async function foldBackLink(
  ctx: DelegationContext,
  req: DelegationRequest,
  childSessionId: string,
  result: string,
  failed: boolean,
): Promise<void> {
  await publishTo(
    ctx,
    ctx.parentSessionId,
    events.delegatedTo({
      runId: req.parentRunId,
      childSessionId,
      agent: req.agent.id,
      task: req.task,
      mode: req.mode,
      status: failed ? "failed" : "done",
      result,
    }),
  ).catch(() => {});
}

/**
 * Derives the ORPHANED background subagents from the replayed PARENT log (plan 52 / D-001): every
 * `delegated.to{status:"running"}` child with no terminal link for the same `childSessionId` that is NOT
 * in `activeChildSessionIds` (a child THIS host is itself running - the subagent analogue of
 * `reapExcept(activeRunId)` excluding the live turn). Returns the terminal `delegated.to{interrupted}`
 * links to emit so a new/reconnecting leader closes children a dead leader left dangling. Any terminal
 * status (`done|failed|interrupted`) closes the link, so a second takeover after the interrupted link is
 * already in the log yields nothing (idempotent by `childSessionId`). Pure over the log; the caller
 * emits + logs.
 */
export function orphanedSubagentReaps(
  parentEvents: readonly SessionEvent[],
  activeChildSessionIds: ReadonlySet<string>,
): TrevorEventInput[] {
  const running = new Map<string, Extract<DecodedEvent, { type: "delegated.to" }>>();
  const terminated = new Set<string>();
  for (const event of parentEvents) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type !== "delegated.to") {
      continue;
    }
    if (isTerminalDelegationStatus(decoded.status)) {
      terminated.add(decoded.childSessionId);
    } else {
      running.set(decoded.childSessionId, decoded);
    }
  }
  const out: TrevorEventInput[] = [];
  for (const [childSessionId, link] of running) {
    if (terminated.has(childSessionId) || activeChildSessionIds.has(childSessionId)) {
      continue;
    }
    out.push(
      events.delegatedTo({
        runId: link.runId,
        childSessionId,
        agent: link.agent,
        task: link.task,
        mode: link.mode === "background" ? "background" : "inline",
        status: "interrupted",
        result:
          "The host that started this subagent went away before it finished; a new leader recovered it.",
      }),
    );
  }
  return out;
}

/** The child's tool allow-list. A BACKGROUND child is clamped to READ-ONLY tools (D-048): it may
 *  observe but never mutate, so a detached child can't race the parent or another child's writes -
 *  discovered + ephemeral alike (an ephemeral `tools:['*']` collapses to the read-only set). Inline
 *  keeps the full resolved allow-list. */
export function resolveChildTools(req: DelegationRequest): Set<string> {
  const allow = resolveAgentTools(req.agent);
  return req.mode === "background"
    ? new Set(allow.filter((name) => READ_ONLY_TOOLS.has(name)))
    : new Set(allow);
}

/**
 * Runs a delegated subagent end to end and returns its distilled result. Best-effort: it NEVER throws
 * (publishTurn surfaces a model failure as an error completion, and any other fault is caught and
 * folded into a `failed` result), so the parent - or a detached background spawner - always gets a
 * result string and a `failed` flag, and the parent link always reaches a terminal done/failed (no
 * child is ever left "running" forever).
 */
export async function runDelegatedChild(
  ctx: DelegationContext,
  req: DelegationRequest,
): Promise<DelegationResult> {
  const childSessionId = req.childSessionId ?? ctx.mintChildSessionId();
  // Run the child's turn with the agent's (mode-clamped) allow-list, publishing its lifecycle to the
  // CHILD session and capturing its final message + whether it errored. Wrapped so a fault before the
  // completion (e.g. ensureSession) still produces a terminal failed link instead of a stuck child.
  let result = "";
  let failed = false;
  try {
    // Ensure + seed the child (parent task only) + link running - the shared isolation/seed (M2).
    await seedChildSession(ctx, req, childSessionId);

    const childEmit = Layer.succeed(Emit, {
      publish: (event: TrevorEventInput) =>
        Effect.promise(async () => {
          if (event.type === "assistant.completed") {
            const p = event.payload as { text?: unknown; error?: unknown };
            result = typeof p.text === "string" ? p.text : "";
            failed = typeof p.error === "string" && p.error.length > 0;
          }
          await publishTo(ctx, childSessionId, event);
        }),
    });
    await Effect.runPromise(
      publishTurn(req.provider, childHistory(req.agent, req.task), {
        runId: req.childRunId,
        toolNames: resolveChildTools(req),
        // A subagent's local-model work queues behind foreground user turns sharing the runtime (D-004).
        priority: "background",
        // A child's tool calls go through the SAME executeTool boundary as the parent's, so the
        // PreToolUse gate applies to them too (plan 25 M5) - bound to the child's own session id
        // and identified as a subagent-initiated call.
        ...(ctx.hooks
          ? {
              hooks: {
                dispatchPreToolUse: ctx.hooks.dispatchPreToolUse,
                ...(ctx.hooks.hasHooks ? { hasHooks: ctx.hooks.hasHooks } : {}),
                identity: {
                  sessionId: childSessionId,
                  callerKind: "subagent" as const,
                  cwd: ctx.hooks.cwd,
                },
              },
            }
          : {}),
      }).pipe(Effect.provide(childEmit)),
    );
  } catch (cause) {
    failed = true;
    result =
      result || `delegation error: ${cause instanceof Error ? cause.message : String(cause)}`;
  }

  // Fold-back link (done/failed) carrying the frozen result the parent reuses.
  await foldBackLink(ctx, req, childSessionId, result, failed);

  return { childSessionId, result, failed };
}

// --- the delegation tool surface (D-048/D-049): delegate_inline + delegate_background ---

/** How many background subagents one session may run at once (D-048). A small cap: background
 *  children are detached fan-out, not a job queue, and each is a full model turn. */
export const MAX_BACKGROUND_CHILDREN_PER_SESSION = 4;

/** Identifies a background child for tracking + surfacing (the cap, /doctor). */
export interface BackgroundChildInfo {
  readonly childRunId: string;
  readonly childSessionId: string;
  readonly agent: string;
  readonly task: string;
}

/**
 * The host-owned background runner the capability defers the detached lifecycle to. The host owns it
 * because a background child OUTLIVES the parent turn: the capability only decides to start one, while
 * the host owns the session-level registry, the cap, and the fork that keeps running (publishing the
 * child's terminal `delegated.to` to the parent log) after the parent turn has ended.
 */
export interface BackgroundDelegator {
  /** Active-child cap, surfaced in the model-facing "started" / "too many" message. */
  readonly cap: number;
  /** Whether another background child may start now (under the cap). False -> the call is rejected. */
  readonly canStart: () => boolean;
  /** Register + run a background child detached from the parent turn (returns immediately). */
  readonly start: (req: DelegationRequest) => void;
}

/** The agent/define/task parameters both delegation tools share. */
function delegationParams(): ToolDef["parameters"] {
  return {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "A discovered subagent id from the list (omit if using `define`)",
      },
      define: {
        type: "object",
        description: "An inline one-off subagent contract (omit if using `agent`)",
        properties: {
          description: { type: "string", description: "What this one-off agent is for" },
          instructions: { type: "string", description: "The agent's system instructions" },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Tool allow-list (names from the tool registry); omit for all tools",
          },
          skills: {
            type: "array",
            items: { type: "string" },
            description: "Skill allow-list (discovered skill ids); omit for all skills",
          },
        },
        required: ["description", "instructions"],
      },
      task: {
        type: "string",
        description:
          "The complete, self-contained task for the subagent - it sees ONLY this, never your conversation, so include all the context it needs.",
      },
    },
    required: ["task"],
  };
}

/** The delegation tools the parent model can call. `delegate_inline` blocks for the result;
 *  `delegate_background` fans out an async read-only child whose result arrives later. The agent
 *  inventory rides each description so the model picks a valid id; the host validates it again at run
 *  time. A one-off agent can be `define`d inline either way. */
export function buildDelegationDefs(
  agents: readonly AgentDefinition[],
  backgroundCap = MAX_BACKGROUND_CHILDREN_PER_SESSION,
): ToolDef[] {
  const inventory = agents.map((a) => `- ${a.id}: ${a.description}`).join("\n");
  return [
    {
      name: "delegate_inline",
      description:
        "Delegate a focused subtask to a subagent that runs in its OWN isolated context (it sees " +
        "only the task you give it, not your conversation) and returns a single distilled result. " +
        "Blocks until the subagent finishes, then you get its final message as the tool result. Pass " +
        "either `agent` (a discovered agent id) or `define` (a one-off ephemeral agent). Use it to " +
        "hand off a self-contained investigation or multi-step subtask whose intermediate steps you " +
        `don't need to see. Available agents:\n${inventory}`,
      parameters: delegationParams(),
    },
    {
      name: "delegate_background",
      description:
        "Delegate a subtask to a subagent that runs ASYNCHRONOUSLY in its OWN isolated context and " +
        "returns IMMEDIATELY - you keep working while it runs. Its result arrives later as a " +
        "delegation update, NOT as this tool's result, so use it only when you don't need the answer " +
        "before continuing. Background subagents are READ-ONLY (they can search/read but never " +
        `edit/write/run). Up to ${backgroundCap} run at once. Pass either \`agent\` or \`define\`. ` +
        `Use it to fan out independent investigations in parallel. Available agents:\n${inventory}`,
      parameters: delegationParams(),
    },
  ];
}

const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delegate_inline",
  "delegate_background",
]);

interface EphemeralSpec {
  readonly description: string;
  readonly instructions: string;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
}

interface DelegateArgs {
  readonly agent?: string;
  readonly task?: string;
  readonly define?: EphemeralSpec;
}

type EphemeralRegistry = {
  readonly tools: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
};

function strArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function parseDelegateArgs(raw: string): DelegateArgs {
  try {
    const p = JSON.parse(raw || "{}") as Record<string, unknown>;
    const d = p.define as Record<string, unknown> | undefined;
    const define =
      d && typeof d === "object"
        ? {
            description: typeof d.description === "string" ? d.description : "",
            instructions: typeof d.instructions === "string" ? d.instructions : "",
            tools: strArray(d.tools),
            skills: strArray(d.skills),
          }
        : undefined;
    return {
      agent: typeof p.agent === "string" ? p.agent : undefined,
      task: typeof p.task === "string" ? p.task : undefined,
      define,
    };
  } catch {
    return {};
  }
}

class EphemeralAgentValidator {
  constructor(private readonly registry: EphemeralRegistry) {}

  validate(spec: EphemeralSpec): { agent: AgentDefinition } | { error: string } {
    if (!spec.description.trim()) {
      return { error: 'error: an ephemeral agent needs a "description"' };
    }
    if (!spec.instructions.trim()) {
      return { error: 'error: an ephemeral agent needs "instructions"' };
    }
    const tools = spec.tools ?? ["*"];
    if (!tools.includes("*")) {
      const toolError = this.validateTools(tools);
      if (toolError) {
        return { error: toolError };
      }
    }
    if (spec.skills && !spec.skills.includes("*")) {
      const skillError = this.validateSkills(spec.skills);
      if (skillError) {
        return { error: skillError };
      }
    }
    return {
      agent: {
        id: "ephemeral",
        description: spec.description.trim(),
        tools,
        skills: spec.skills,
        body: spec.instructions,
        source: "ephemeral",
      },
    };
  }

  private validateTools(tools: readonly string[]): string | null {
    const forbidden = tools.filter((t) => DELEGATION_TOOL_NAMES.has(t));
    if (forbidden.length) {
      return `error: an ephemeral agent may not use delegation tools (${forbidden.join(", ")})`;
    }
    const unknown = tools.filter((t) => !this.registry.tools.has(t));
    return unknown.length
      ? `error: unknown tool(s) for the ephemeral agent: ${unknown.join(", ")}`
      : null;
  }

  private validateSkills(skills: readonly string[]): string | null {
    const unknown = skills.filter((s) => !this.registry.skills.has(s));
    return unknown.length
      ? `error: unknown skill(s) for the ephemeral agent: ${unknown.join(", ")}`
      : null;
  }
}

/**
 * Resolves a delegation call to the agent it runs: a discovered id, or a runtime-only ("ephemeral")
 * definition the model minted inline (D-049). Ephemeral validation is delegated to
 * EphemeralAgentValidator so the resolver only selects the agent source and handles unknown ids.
 */
function resolveDelegationAgent(
  args: DelegateArgs,
  agents: readonly AgentDefinition[],
  validator: EphemeralAgentValidator,
): { agent: AgentDefinition } | { error: string } {
  if (args.define) {
    return validator.validate(args.define);
  }
  if (args.agent) {
    const found = agents.find((a) => a.id === args.agent);
    if (!found) {
      const ids = agents.map((a) => a.id).join(", ") || "(none)";
      return { error: `error: unknown agent "${args.agent}". Available: ${ids}` };
    }
    return { agent: found };
  }
  return { error: 'error: delegate requires an "agent" id or an inline "define"' };
}

/**
 * Binds the delegation capability the loop injects into a PARENT turn: the offered tool defs plus a
 * runner that resolves the call (discovered or ephemeral, strictly validated), runs the child end to
 * end (runDelegatedChild), and returns the model-facing result. A child turn is NOT given this, so a
 * child can neither see nor invoke delegation (depth-1, D-048). Validation failures return a
 * structured `error: …` string the model can read and recover from, never an exception.
 */
export function buildDelegateCapability(
  ctx: DelegationContext,
  params: {
    readonly provider: Provider;
    readonly parentRunId: string;
    readonly agents: readonly AgentDefinition[];
    /** Mints the child turn's run id (injected so tests are deterministic). */
    readonly mintRunId: () => string;
    /** The host-owned background runner. Omitted -> background delegation is unavailable this turn. */
    readonly background?: BackgroundDelegator;
  },
): DelegateCapability {
  // The live registries an ephemeral contract is validated against (D-049).
  const registry = {
    tools: new Set(TOOL_DEFS.map((t) => t.name)),
    skills: new Set(discoverSkills().map((s) => s.id)),
  };
  const ephemeralValidator = new EphemeralAgentValidator(registry);
  const cap = params.background?.cap ?? MAX_BACKGROUND_CHILDREN_PER_SESSION;
  return {
    defs: buildDelegationDefs(params.agents, cap),
    names: DELEGATION_TOOL_NAMES,
    run: async (name, argsJson) => {
      const args = parseDelegateArgs(argsJson);
      if (!args.task?.trim()) {
        return 'error: delegate requires a non-empty "task"';
      }
      const resolved = resolveDelegationAgent(args, params.agents, ephemeralValidator);
      if ("error" in resolved) {
        return resolved.error;
      }
      const req: DelegationRequest = {
        agent: resolved.agent,
        task: args.task,
        provider: params.provider,
        parentRunId: params.parentRunId,
        childRunId: params.mintRunId(),
        childSessionId: ctx.mintChildSessionId(),
        mode: name === "delegate_background" ? "background" : "inline",
      };
      if (req.mode === "background") {
        const bg = params.background;
        if (!bg) {
          return "error: background delegation is not available on this turn";
        }
        if (!bg.canStart()) {
          return `error: too many background subagents already running (max ${bg.cap}); wait for one to finish or use delegate_inline`;
        }
        // Detached by the host: it outlives this turn and its result lands later as a delegation
        // update on the parent session. The model gets only this acknowledgement now.
        bg.start(req);
        return (
          `Started background subagent "${resolved.agent.id}" in its own read-only session. ` +
          "Continue with other work; its result will arrive later as a delegation update, not as this tool's result."
        );
      }
      const out = await runDelegatedChild(ctx, req);
      if (out.failed) {
        return `The "${resolved.agent.id}" subagent failed before finishing${out.result ? `: ${out.result}` : "."}`;
      }
      return out.result.trim() || "(the subagent returned no result)";
    },
  };
}

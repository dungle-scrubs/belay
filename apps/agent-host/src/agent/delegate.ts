import { events, type SessionTransport, type TrevorEventInput } from "@trevor/session";
import { Effect, Layer } from "effect";
import type { AgentDefinition } from "../agents";
import { resolveAgentTools } from "../agents";
import type { ChatMessage, Provider, ToolDef } from "../providers";
import { Emit } from "../services";
import { publishTurn } from "../turn";
import type { DelegateCapability } from "./loop";

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
 */

/** What a delegation needs from the host: the transport, the parent session + producer to link on,
 *  and a child-session-id minter (injected so tests are deterministic). */
export interface DelegationContext {
  readonly transport: SessionTransport;
  readonly parentSessionId: string;
  readonly producerId: string;
  readonly mintChildSessionId: () => string;
}

export interface DelegationRequest {
  readonly agent: AgentDefinition;
  readonly task: string;
  readonly provider: Provider;
  /** The parent turn's run id (the delegated.to link correlates to it). */
  readonly parentRunId: string;
  /** The child turn's run id (its lifecycle in the child session). */
  readonly childRunId: string;
  readonly mode: "inline" | "background";
}

export interface DelegationResult {
  readonly childSessionId: string;
  readonly result: string;
  readonly failed: boolean;
}

/** The child's isolated conversation: the agent's instructions framing ONLY the parent task. The
 *  child shares no parent transcript - this single seeded message is its entire input. */
function childHistory(agent: AgentDefinition, task: string): ChatMessage[] {
  return [{ role: "user", content: `${agent.body}\n\n---\n\nYour task:\n${task}` }];
}

/** Publishes one event to a session through the transport, attaching the producer id. */
function publishTo(
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
 * Runs a delegated subagent end to end and returns its distilled result. Best-effort: a child turn
 * never throws (publishTurn surfaces failures as a completion with an error), so the parent always
 * gets a result string and a `failed` flag, never an exception that would break the parent turn.
 */
export async function runDelegatedChild(
  ctx: DelegationContext,
  req: DelegationRequest,
): Promise<DelegationResult> {
  const childSessionId = ctx.mintChildSessionId();
  await ctx.transport.ensureSession(childSessionId);

  // Seed the child log with the parent task as its first user message (the entire slice it sees).
  await publishTo(
    ctx,
    childSessionId,
    events.userMessage({ text: req.task, provider: req.provider.id }),
  );

  // Link parent -> child (running) on the PARENT session.
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

  // Run the child's turn with the agent's allow-list, publishing its lifecycle to the CHILD session
  // and capturing its final message + whether it errored.
  let result = "";
  let failed = false;
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
  const toolNames = new Set(resolveAgentTools(req.agent));
  await Effect.runPromise(
    publishTurn(req.provider, childHistory(req.agent, req.task), {
      runId: req.childRunId,
      toolNames,
    }).pipe(Effect.provide(childEmit)),
  );

  // Fold-back link (done/failed) carrying the frozen result the parent reuses.
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
  );

  return { childSessionId, result, failed };
}

// --- the delegation tool surface (D-048): delegate_inline, exposed to the parent model ---

/** The one delegation tool (inline) the model can call. `delegate_background` (async, read-only,
 *  capped) is the immediate follow-on. The agent inventory rides the description so the model picks
 *  a valid id; the host validates it again at run time. */
export function buildDelegationDefs(agents: readonly AgentDefinition[]): ToolDef[] {
  const inventory = agents.map((a) => `- ${a.id}: ${a.description}`).join("\n");
  return [
    {
      name: "delegate_inline",
      description:
        "Delegate a focused subtask to a subagent that runs in its OWN isolated context (it sees " +
        "only the task you give it, not your conversation) and returns a single distilled result. " +
        "Blocks until the subagent finishes, then you get its final message as the tool result. Use " +
        "it to hand off a self-contained investigation or multi-step subtask whose intermediate " +
        `steps you don't need to see. Available agents:\n${inventory}`,
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "The subagent id to delegate to (from the list)" },
          task: {
            type: "string",
            description:
              "The complete, self-contained task for the subagent - it sees ONLY this, never your conversation, so include all the context it needs.",
          },
        },
        required: ["agent", "task"],
      },
    },
  ];
}

const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["delegate_inline"]);

function parseDelegateArgs(raw: string): { agent?: string; task?: string } {
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    return {
      agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
      task: typeof parsed.task === "string" ? parsed.task : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Binds the delegation capability the loop injects into a PARENT turn: the offered tool defs plus a
 * runner that validates the call, runs the child end to end (runDelegatedChild), and returns the
 * model-facing result string. A child turn is NOT given this, so a child can neither see nor invoke
 * delegation (depth-1, D-048). Validation failures (unknown agent, empty task) return a structured
 * `error: …` string the model can read and recover from, never an exception.
 */
export function buildDelegateCapability(
  ctx: DelegationContext,
  params: {
    readonly provider: Provider;
    readonly parentRunId: string;
    readonly agents: readonly AgentDefinition[];
    /** Mints the child turn's run id (injected so tests are deterministic). */
    readonly mintRunId: () => string;
  },
): DelegateCapability {
  return {
    defs: buildDelegationDefs(params.agents),
    names: DELEGATION_TOOL_NAMES,
    run: async (_name, argsJson) => {
      const { agent: agentId, task } = parseDelegateArgs(argsJson);
      if (!agentId) {
        return 'error: delegate requires an "agent" id';
      }
      const agent = params.agents.find((a) => a.id === agentId);
      if (!agent) {
        const ids = params.agents.map((a) => a.id).join(", ") || "(none)";
        return `error: unknown agent "${agentId}". Available: ${ids}`;
      }
      if (!task?.trim()) {
        return 'error: delegate requires a non-empty "task"';
      }
      const out = await runDelegatedChild(ctx, {
        agent,
        task,
        provider: params.provider,
        parentRunId: params.parentRunId,
        childRunId: params.mintRunId(),
        mode: "inline",
      });
      if (out.failed) {
        return `The "${agentId}" subagent failed before finishing${out.result ? `: ${out.result}` : "."}`;
      }
      return out.result.trim() || "(the subagent returned no result)";
    },
  };
}

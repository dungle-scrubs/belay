import { events, type SessionTransport, type TrevorEventInput } from "@trevor/session";
import { Effect, Layer } from "effect";
import type { AgentDefinition } from "../agents";
import { resolveAgentTools } from "../agents";
import type { ChatMessage, Provider, ToolDef } from "../providers";
import { Emit } from "../services";
import { discoverSkills } from "../skills";
import { TOOL_DEFS } from "../tools";
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

// --- the delegation tool surface (D-048/D-049): delegate_inline, exposed to the parent model ---

/** The one delegation tool (inline) the model can call. `delegate_background` (async, read-only,
 *  capped) is the immediate follow-on. The agent inventory rides the description so the model picks
 *  a valid id; the host validates it again at run time. A one-off agent can be `define`d inline. */
export function buildDelegationDefs(agents: readonly AgentDefinition[]): ToolDef[] {
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
      parameters: {
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
      },
    },
  ];
}

const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["delegate_inline"]);

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

/**
 * Resolves a delegation call to the agent it runs: a discovered id, or a runtime-only ("ephemeral")
 * definition the model minted inline (D-049). An ephemeral contract is validated STRICTLY against the
 * live registries before it runs - unknown tools/skills and policy-forbidden delegation tools are
 * rejected with a structured error, never silently dropped - and is runtime-only (no file written, no
 * registry entry). Either way the resolved agent gets the same isolation, allow-list, and depth-1
 * (no delegation capability) as a discovered one.
 */
function resolveDelegationAgent(
  args: DelegateArgs,
  agents: readonly AgentDefinition[],
  registry: { readonly tools: ReadonlySet<string>; readonly skills: ReadonlySet<string> },
): { agent: AgentDefinition } | { error: string } {
  if (args.define) {
    const d = args.define;
    if (!d.description.trim()) {
      return { error: 'error: an ephemeral agent needs a "description"' };
    }
    if (!d.instructions.trim()) {
      return { error: 'error: an ephemeral agent needs "instructions"' };
    }
    const tools = d.tools ?? ["*"];
    if (!tools.includes("*")) {
      const forbidden = tools.filter((t) => DELEGATION_TOOL_NAMES.has(t));
      if (forbidden.length) {
        return {
          error: `error: an ephemeral agent may not use delegation tools (${forbidden.join(", ")})`,
        };
      }
      const unknown = tools.filter((t) => !registry.tools.has(t));
      if (unknown.length) {
        return { error: `error: unknown tool(s) for the ephemeral agent: ${unknown.join(", ")}` };
      }
    }
    if (d.skills && !d.skills.includes("*")) {
      const unknown = d.skills.filter((s) => !registry.skills.has(s));
      if (unknown.length) {
        return { error: `error: unknown skill(s) for the ephemeral agent: ${unknown.join(", ")}` };
      }
    }
    return {
      agent: {
        id: "ephemeral",
        description: d.description.trim(),
        tools,
        skills: d.skills,
        body: d.instructions,
        source: "ephemeral",
      },
    };
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
  },
): DelegateCapability {
  // The live registries an ephemeral contract is validated against (D-049).
  const registry = {
    tools: new Set(TOOL_DEFS.map((t) => t.name)),
    skills: new Set(discoverSkills().map((s) => s.id)),
  };
  return {
    defs: buildDelegationDefs(params.agents),
    names: DELEGATION_TOOL_NAMES,
    run: async (_name, argsJson) => {
      const args = parseDelegateArgs(argsJson);
      if (!args.task?.trim()) {
        return 'error: delegate requires a non-empty "task"';
      }
      const resolved = resolveDelegationAgent(args, params.agents, registry);
      if ("error" in resolved) {
        return resolved.error;
      }
      const out = await runDelegatedChild(ctx, {
        agent: resolved.agent,
        task: args.task,
        provider: params.provider,
        parentRunId: params.parentRunId,
        childRunId: params.mintRunId(),
        mode: "inline",
      });
      if (out.failed) {
        return `The "${resolved.agent.id}" subagent failed before finishing${out.result ? `: ${out.result}` : "."}`;
      }
      return out.result.trim() || "(the subagent returned no result)";
    },
  };
}

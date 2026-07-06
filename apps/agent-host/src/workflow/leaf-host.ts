/**
 * The host adapter for the workflow `agent()` leaf: it runs the child turn(s) via `publishTurn`
 * IN the orchestration fiber (not a detached `Effect.runPromise`, so fiber interruption halts an
 * in-flight leaf - 21/D-011), maps each terminal completion onto a `TurnOutcome`, reprojects the
 * child's durable log between turns for a multi-turn worker leaf (21/D-017), and resolves a
 * `ModelRef` to a warm provider through the catalog with a local-readiness gate (21/D-014). It reuses
 * the shared seed/isolation/fold-back from delegate.ts so the isolation invariant lives in one place.
 *
 * Responsible for: wiring the real turn/transport/catalog collaborators into the leaf control logic
 * (leaf.ts) - the in-fiber turn runner, continuation reprojection, and model resolution.
 * Not for: the leaf's typed-result control logic (leaf.ts) or fan-out over leaves (M3).
 */
import { Emit } from "@host/transport/services";
import { events, type SessionIdentity, WORKFLOW_LEAF_AGENT_ID } from "@trevor/session";
import { Effect, Either, Layer } from "effect";
import type { AdmissionPriority } from "../admission/contract";
import {
  childHistory,
  type DelegationContext,
  type DelegationRequest,
  foldBackLink,
  publishTo,
  resolveChildTools,
  seedChildSession,
} from "../agent/delegate";
import { buildHistory } from "../agent/history-projection";
import { publishTurn } from "../agent/turn";
import type { ChatMessage, Provider } from "../providers";
import { buildSourceProvider } from "../providers/catalog";
import type { AgentDefinition } from "../subagents/discovery";
import { type LeafWorkspace, withLeafWorkspace } from "../tools/workspace";
import type { TurnOutcome } from "./leaf";
import {
  type LeafDeps,
  type LeafFailure,
  type LeafRequest,
  type LeafResult,
  runLeaf,
} from "./leaf";
import type { ModelRef } from "./spec";

/** The subset of a terminal `assistant.completed` payload the leaf reads to classify a turn. */
export interface CompletionSignal {
  readonly text?: string;
  readonly error?: string;
  readonly cancelled?: boolean;
  readonly stepLimit?: number;
  readonly usage?: { readonly input: number; readonly output: number };
}

/**
 * Classify one child turn from its terminal completion (turn.ts emits exactly one). Precedence:
 * a provider/host `error` -> `error`; a fiber-interrupt `cancelled` -> `cancelled`; a budget-terminated
 * turn (`stepLimit > 0`, a forced synthesis) -> `cutoff` (a whole-plan task continues); otherwise the
 * model answered -> `answered` (semantic completion).
 */
export function mapCompletionToOutcome(payload: CompletionSignal): TurnOutcome {
  const text = typeof payload.text === "string" ? payload.text : "";
  const usage = { input: payload.usage?.input ?? 0, output: payload.usage?.output ?? 0 };
  if (typeof payload.error === "string" && payload.error.length > 0) {
    return { text, usage, endReason: "error", cause: payload.error };
  }
  if (payload.cancelled === true) {
    return { text, usage, endReason: "cancelled" };
  }
  if (typeof payload.stepLimit === "number" && payload.stepLimit > 0) {
    return { text, usage, endReason: "cutoff" };
  }
  return { text, usage, endReason: "answered" };
}

/** The catalog seam injected so the model gate is unit-testable (D-014). */
export interface ModelResolveDeps {
  /** Build a provider from a ModelRef via the catalog; null when the model is absent from it. */
  readonly buildProvider: (model: ModelRef) => Provider | null;
}

/**
 * Resolve a leaf's `opts.model` to a runnable provider (D-014): a source+model the catalog cannot
 * build fails `model-unresolvable`; a LOCAL provider (`kind === "local"`) additionally gates on
 * `readiness().warm` and fails `local-not-ready` when the model is not loaded. Cloud providers are
 * always warm, so they pass through (the local admission gate then serialises the warm ones).
 */
export function resolveLeafProvider(
  model: ModelRef,
  childSessionId: string,
  deps: ModelResolveDeps,
): Effect.Effect<Either.Either<Provider, LeafFailure>> {
  return Effect.gen(function* () {
    const provider = deps.buildProvider(model);
    if (provider === null) {
      return Either.left<LeafFailure>({
        ok: false,
        kind: "model-unresolvable",
        childSessionId,
        cause: `model "${model.sourceId}:${model.modelId}" is not in the catalog`,
      });
    }
    if (provider.kind === "local") {
      const readiness = yield* provider.readiness();
      if (!readiness.warm) {
        return Either.left<LeafFailure>({
          ok: false,
          kind: "local-not-ready",
          childSessionId,
          cause: `local model "${model.sourceId}:${model.modelId}" is not warm (loaded)`,
        });
      }
    }
    return Either.right(provider);
  });
}

const DEFAULT_LEAF_BODY =
  "You are a workflow leaf: complete the self-contained task below and reply with your result. " +
  "You have no access to the launching conversation.";

const CONTINUE_PROMPT =
  "Continue working toward completing the task. When it is fully done, give your final result.";

/** What the host needs to run one `agent()` leaf: the delegation context (transport/session/link), a
 *  reader identity for durable-log reprojection, and a run-id minter. */
export interface LeafHostContext {
  readonly ctx: DelegationContext;
  readonly identity: SessionIdentity;
  readonly mintRunId: () => string;
}

/** One `agent()` invocation, resolved to a concrete child session + base provider. */
export interface AgentLeafRequest extends LeafRequest {
  readonly prompt: string;
  readonly childRunId: string;
  readonly parentRunId: string;
  readonly provider: Provider;
  readonly agentBody?: string;
  readonly toolNames?: ReadonlySet<string>;
  readonly model?: ModelRef;
  readonly stepBudget?: number;
  readonly priority?: AdmissionPriority;
  /** The leaf's isolated worktree workspace (its own cwd + confinement root). When set (an
   *  `isolation:'worktree'` leaf), the leaf's tool calls route against it, so N parallel worktree
   *  leaves in one host process write to DISTINCT trees without racing (M6, D-024). */
  readonly workspace?: LeafWorkspace;
}

/**
 * Run one `agent()` leaf end to end and return its typed `LeafResult`. Resolves the model (readiness
 * gate), seeds the isolated child, drives one or more child turns IN this fiber, folds the result
 * back onto the parent link, and never throws - failures are typed values (D-012).
 */
export function runAgentLeaf(
  host: LeafHostContext,
  request: AgentLeafRequest,
): Effect.Effect<LeafResult> {
  return Effect.gen(function* () {
    let provider = request.provider;
    if (request.model !== undefined) {
      const resolved = yield* resolveLeafProvider(request.model, request.childSessionId, {
        buildProvider: (model) => buildSourceProvider(model.sourceId, model.modelId),
      });
      if (Either.isLeft(resolved)) {
        return resolved.left;
      }
      provider = resolved.right;
    }
    const reasoning = request.model?.reasoning ?? undefined;

    const agentDef: AgentDefinition = {
      id: WORKFLOW_LEAF_AGENT_ID,
      description: "a workflow engine leaf",
      tools: request.toolNames ? [...request.toolNames] : ["*"],
      body: request.agentBody ?? DEFAULT_LEAF_BODY,
      source: "ephemeral",
    };
    const delegationReq: DelegationRequest = {
      agent: agentDef,
      task: request.prompt,
      provider,
      parentRunId: request.parentRunId,
      childRunId: request.childRunId,
      childSessionId: request.childSessionId,
      mode: "inline",
    };

    yield* Effect.promise(() => seedChildSession(host.ctx, delegationReq, request.childSessionId));

    const runOneTurn = (history: readonly ChatMessage[]) =>
      Effect.gen(function* () {
        let signal: CompletionSignal = {};
        const childEmit = Layer.succeed(Emit, {
          publish: (event) =>
            Effect.promise(async () => {
              if (event.type === "assistant.completed") {
                signal = event.payload as CompletionSignal;
              }
              await publishTo(host.ctx, request.childSessionId, event);
            }),
        });
        yield* publishTurn(provider, history, {
          runId: host.mintRunId(),
          ...(reasoning ? { reasoning } : {}),
          toolNames: resolveChildTools(delegationReq),
          priority: request.priority ?? "background",
          ...(request.stepBudget ? { loop: { emergencyMaxSteps: request.stepBudget } } : {}),
        }).pipe(Effect.provide(childEmit));
        return mapCompletionToOutcome(signal);
      });

    // Reproject the child's durable log (its own messages included - no selfProducerId exclusion) and
    // append a fresh user message, so the next turn continues the same conversation (D-017).
    const continueWith = (message: string) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          publishTo(
            host.ctx,
            request.childSessionId,
            events.userMessage({ text: message, provider: provider.id }),
          ),
        );
        const logEvents = yield* Effect.promise(() =>
          host.ctx.transport.readLog(request.childSessionId, host.identity, { afterSeq: 0 }),
        );
        const history = buildHistory(logEvents);
        return yield* runOneTurn(history);
      });

    const deps: LeafDeps = {
      runTurn: (index) =>
        index === 0
          ? runOneTurn(childHistory(agentDef, request.prompt))
          : continueWith(CONTINUE_PROMPT),
      repair: (detail) =>
        continueWith(
          `Your previous reply did not match the required schema (${detail}). ` +
            "Reply with ONLY valid JSON matching the schema, nothing else.",
        ),
    };

    // A worktree-isolated leaf runs its turns with its own fiber-local workspace, so its tool calls
    // resolve against its tree (not the host cwd) and parallel siblings never collide (M6, D-024).
    const result = yield* request.workspace
      ? withLeafWorkspace(request.workspace, runLeaf(request, deps))
      : runLeaf(request, deps);

    yield* Effect.promise(() =>
      foldBackLink(
        host.ctx,
        delegationReq,
        request.childSessionId,
        result.ok ? result.text : result.cause,
        !result.ok,
      ),
    );
    return result;
  });
}

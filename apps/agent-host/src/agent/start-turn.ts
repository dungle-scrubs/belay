import type { InternetMonitor } from "@host/connectivity/probe";
import { hooksRuntime } from "@host/hooks/host-runtime";
import { type ChatMessage, DEFAULT_PROVIDER, type ProviderRegistry } from "@host/providers/index";
import {
  createTurnProviderResolver,
  type TurnProviderResolver,
} from "@host/providers/turn-provider-resolver";
import type { HostResidency } from "@host/residency/host";
import type { Lease } from "@host/session/lease";
import { discoverAgents } from "@host/subagents/discovery";
import { CLIPBOARD_TOOL_NAMES } from "@host/tools/clip";
import { log, warn } from "@host/transport/log";
import type { Emit } from "@host/transport/services";
import {
  decodeTrevorEvent,
  isAnswerableProducer,
  isClipProducer,
  type ModelRef,
  type SessionEvent,
  type SessionTransport,
} from "@trevor/session";
import type { TelemetrySink } from "@trevor/session/telemetry";
import type { ProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import { Effect, type Layer } from "effect";
import { interpretFiberExit, interruptFiber } from "../effect/fiber-exit";
import type { ActiveRun } from "./active-run";
import type { CompactionController } from "./compaction-controller";
import {
  type BackgroundChildInfo,
  type BackgroundDelegator,
  buildDelegateCapability,
  MAX_BACKGROUND_CHILDREN_PER_SESSION,
  runDelegatedChild,
} from "./delegate";
import { createSwitchCell } from "./switch-cell";
import { publishTurn } from "./turn";
import type { ActiveTurn, TurnScheduler } from "./turn-scheduler";

/**
 * The turn fork, extracted from main.ts (plan 22.3): main.ts constructs {@link makeStartTurn} once
 * over its live provider/controller/lease state; the TurnScheduler's `start` closure dispatches
 * into it under the same local name (resolved at dispatch time, so the scheduler-first wiring
 * order is TDZ-safe). The active-run and switch-cell markers stay main.ts state - handleEvent and
 * the run lifecycle read them there - threaded through as get/set refs.
 *
 * Responsible for: resolving a user.message's provider/model, assembling the turn's delegation +
 * hooks + switch surface, forking its fiber, and returning the scheduler's ActiveTurn handle.
 * Not for: WHEN a turn runs (agent/turn-scheduler.ts), the turn program itself (agent/turn.ts +
 * agent/loop.ts), or closing runs that die without a completion (agent/run-lifecycle.ts).
 */

/** The live main.ts state the turn fork reads - singletons plus mutable-marker get/set refs. */
export interface StartTurnDeps {
  /** The current session's id (main.ts's SESSION_ID, computed from env). */
  readonly sessionId: string;
  /** The host's shared producer id: the self-echo gate + child-turn attribution. */
  readonly producerId: string;
  /** The durable-log transport, handed to the delegation context for child sessions. */
  readonly transport: SessionTransport;
  /** The registered providers the legacy provider-string path picks from. */
  readonly providers: ProviderRegistry;
  /** Shared turn provider resolver, also used by prompt preflight before compaction checks. */
  readonly turnProviderResolver?: TurnProviderResolver;
  /** The compaction controller: notes the turn's provider + seeds carried-forward usage. */
  readonly compactionController: Pick<CompactionController, "noteProvider" | "usageSeed">;
  /** The host's local-model residency: reconciled to this turn's provider (plan 11.1). */
  readonly residency: Pick<HostResidency, "onActiveModelChanged">;
  /** The internet monitor (D-060): a cloud turn refreshes a stale advisory, fire-and-forget. */
  readonly internet: Pick<InternetMonitor, "refreshIfStale">;
  /** The lease: only the leader forks turns. */
  readonly lease: Pick<Lease, "isLeader">;
  /** The host telemetry sink threaded into every turn (plan 13 M5). */
  readonly hostTelemetry: TelemetrySink;
  /** The opt-in provider-attempt trace writer (plan 13 M6). */
  readonly providerTrace: ProviderTraceWriter;
  /** The live Emit layer (main.ts's EmitLive): the turn program's events reach the durable log. */
  readonly emitLive: Layer.Layer<Emit>;
  /** The turn scheduler: the fiber observer frees its slot when the fiber exits. */
  readonly scheduler: Pick<TurnScheduler, "settle">;
  /** Background subagents currently running across the session (main.ts's registry, D-048). */
  readonly backgroundChildren: Map<string, BackgroundChildInfo>;
  /** The active run owner: run id plus optional switch cell move together. */
  readonly activeRun: Pick<ActiveRun, "open" | "clear">;
}

/** Builds the turn fork over the host's live state; main.ts wires it once. */
export function makeStartTurn(deps: StartTurnDeps) {
  const {
    sessionId: SESSION_ID,
    producerId: PRODUCER_ID,
    transport,
    providers,
    compactionController,
    residency,
    internet,
    lease,
    hostTelemetry,
    providerTrace,
    emitLive: EmitLive,
    scheduler,
    backgroundChildren,
    activeRun,
  } = deps;
  const turnProviderResolver =
    deps.turnProviderResolver ??
    createTurnProviderResolver({
      providers,
      defaultProviderKey: DEFAULT_PROVIDER,
    });

  /**
   * Forks the agent turn for a user.message and returns its handle for the scheduler to
   * track, or null when this host should not answer it (self-authored, not the leader, or
   * not a user.message). One fiber per turn: cancelling it (ESC in the browser) tears down
   * the in-flight provider stream and publishes the cancelled completion. The fiber
   * observer is a backstop that frees the scheduler's slot if the fiber dies without a
   * completion event; the scheduler structurally guarantees one turn at a time, so there
   * is no "already active" case to guard here.
   */
  function startTurn(event: SessionEvent, turnHistory: readonly ChatMessage[]): ActiveTurn | null {
    if (!isAnswerableProducer(event.producerId, PRODUCER_ID) || !lease.isLeader()) {
      return null;
    }
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type !== "user.message") {
      return null;
    }
    const runId = crypto.randomUUID();
    const {
      provider,
      model: turnModel,
      budgetWindow,
    } = turnProviderResolver.resolveTurnProvider(decoded);
    // Remember the turn's provider so a between-turn fold summarizes with the same model (D-043).
    compactionController.noteProvider(provider, budgetWindow);
    // Reconcile local-model residency for this turn's provider (plan 11.1): claim the local model it holds
    // (releasing + sweeping the prior one), or release the current claim when the turn goes to the cloud.
    // Fire-and-forget: residency is best-effort and must never gate a turn.
    void residency.onActiveModelChanged(provider.residencyTarget?.() ?? null);
    // A cloud turn may want fresh connectivity for the advisory (D-060): refresh if stale, never block
    // the turn on it (fire-and-forget; the result rides a later host.internet).
    if (provider.kind === "cloud") {
      void internet.refreshIfStale();
    }
    // The delegation capability for this PARENT turn (D-048): it can hand a subtask to a discovered
    // subagent, which runs in its own isolated child session and folds its distilled result back.
    // A child turn (run inside runDelegatedChild) is given no capability, so depth stays 1.
    const delegationCtx = {
      transport,
      parentSessionId: SESSION_ID,
      producerId: PRODUCER_ID,
      mintChildSessionId: () => `${SESSION_ID}::sub::${crypto.randomUUID()}`,
      // Child turns share the host-wide hooks runtime (plan 25 M5): a delegated subagent's tool
      // calls pass the same PreToolUse gate, attributed to its own child session.
      hooks: {
        dispatchPreToolUse: hooksRuntime.dispatchPreToolUse,
        hasHooks: hooksRuntime.hasHooks,
        cwd: process.cwd(),
      },
    };
    // The host owns the background lifecycle: a background child OUTLIVES this turn, so it runs detached
    // here against the SESSION-level registry + cap, publishing its terminal delegated.to to the parent
    // log whenever it finishes (the parent turn's fiber may be long gone). runDelegatedChild never throws.
    const background: BackgroundDelegator = {
      cap: MAX_BACKGROUND_CHILDREN_PER_SESSION,
      canStart: () => backgroundChildren.size < MAX_BACKGROUND_CHILDREN_PER_SESSION,
      start: (req) => {
        backgroundChildren.set(req.childRunId, {
          childRunId: req.childRunId,
          childSessionId: req.childSessionId ?? "",
          agent: req.agent.id,
          task: req.task,
        });
        void runDelegatedChild(delegationCtx, req).finally(() =>
          backgroundChildren.delete(req.childRunId),
        );
      },
    };
    // A restricted `/clip <request>` turn (plan 06): narrow the surface to clipboard_write only and
    // withhold delegation entirely, so the model can neither see another tool nor hand work to a
    // subagent that could. A normal turn gets the full registry + delegation.
    const restricted = isClipProducer(event.producerId, PRODUCER_ID);
    const delegate = restricted
      ? undefined
      : buildDelegateCapability(delegationCtx, {
          provider,
          parentRunId: runId,
          // Inline children inherit THIS turn's reasoning level so it runs at (and the row displays,
          // 09.4 M2) the same thinking level the parent chose; undefined = provider default, no cell.
          reasoningLevel: turnModel.reasoning,
          agents: discoverAgents(),
          mintRunId: () => crypto.randomUUID(),
          background,
        });
    // The per-turn mid-turn-switch cell (09.1): a `/clip` turn is not switchable (restricted surface), an
    // ordinary turn is. Registered so `handleEvent` can route a `model.switch.requested` for this run into
    // it; the loop reads it at the next step boundary.
    const switchCell = restricted ? undefined : createSwitchCell();
    activeRun.open(runId, switchCell);
    // Carry the prior turn's measured context forward (03.1 D-002): when compaction has floored out and
    // the turn legitimately starts at/above the fraction, this lets the context-pressure gate synthesize
    // at step 0 instead of opening one doomed tool round. Absent on a session's first turn.
    const seedUsage = compactionController.usageSeed();
    const fiber = Effect.runFork(
      publishTurn(provider, turnHistory, {
        runId,
        reasoning: decoded.model?.reasoning ?? decoded.reasoning,
        delegate,
        telemetry: hostTelemetry,
        providerTrace,
        // The PreToolUse gate (plan 25 M5): every tool call this turn executes passes the
        // host-wide hooks runtime, identified as a main-loop or restricted /clip call. The Stop
        // gate (25 M7) reviews this turn's terminal result before its completion publishes; child
        // (subagent) turns deliberately carry no Stop gate - finalization review is a main-turn
        // concern, and a child's distilled result is reviewed when the PARENT turn finalizes.
        hooks: {
          dispatchPreToolUse: hooksRuntime.dispatchPreToolUse,
          dispatchStop: hooksRuntime.dispatchStop,
          hasHooks: hooksRuntime.hasHooks,
          identity: {
            sessionId: SESSION_ID,
            callerKind: restricted ? ("clip" as const) : ("main" as const),
            cwd: process.cwd(),
          },
        },
        ...(restricted ? { toolNames: CLIPBOARD_TOOL_NAMES } : {}),
        ...(seedUsage ? { seedUsage } : {}),
        // The mid-turn model-switch surface (09.1), built as one unit for a switchable turn:
        //  - rebuildProvider uses the same source builder as the turn's initial provider, so any catalog
        //    model can be swapped to mid-flight;
        //  - initialModel (when the turn carried a ref) seeds the same-model check, so a reasoning-only
        //    re-send of the unchanged model does not pointlessly rebuild the provider.
        ...(switchCell
          ? {
              switchSurface: {
                cell: switchCell,
                rebuildProvider: (model: ModelRef) =>
                  turnProviderResolver.buildProviderForModel(model),
                ...(decoded.model ? { initialModel: decoded.model } : {}),
              },
            }
          : {}),
      }).pipe(Effect.provide(EmitLive)),
    );
    fiber.addObserver((exit) => {
      // The fiber is no longer running this turn: clear the active marker so a reconnect reconcile treats
      // a lingering in-flight entry for it as an orphan (its terminal completion may have been lost).
      activeRun.clear(runId);
      // publishTurn handles provider failures internally, so a non-interrupt failure here
      // is an unexpected defect worth surfacing.
      const result = interpretFiberExit(exit);
      if (result.tag === "failed") {
        warn("host", "turn died", { run: runId.slice(0, 8), cause: result.cause });
      }
      scheduler.settle(runId);
    });
    return {
      runId,
      cancel: () => {
        log("host", "cancel: interrupting run", { run: runId.slice(0, 8) });
        interruptFiber(fiber);
      },
    };
  }

  return { startTurn };
}

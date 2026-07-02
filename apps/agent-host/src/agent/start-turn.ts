import type { InternetMonitor } from "@host/connectivity/probe";
import { hooksRuntime } from "@host/hooks/host-runtime";
import { buildSourceProvider } from "@host/providers/catalog";
import { type ChatMessage, type ProviderRegistry, pickProvider } from "@host/providers/index";
import type { HostResidency } from "@host/residency/host";
import type { Lease } from "@host/session/lease";
import { discoverAgents } from "@host/subagents/discovery";
import { CLIPBOARD_TOOL_NAMES } from "@host/tools/clip";
import { log, warn } from "@host/transport/log";
import type { Emit } from "@host/transport/services";
import {
  decodeTrevorEvent,
  type ModelRef,
  resolveUserTurnModel,
  type SessionEvent,
  type SessionTransport,
} from "@trevor/session";
import type { TelemetrySink } from "@trevor/session/telemetry";
import type { ProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import { Cause, Effect, Exit, Fiber, type Layer } from "effect";
import type { CompactionController } from "./compaction-controller";
import {
  type BackgroundChildInfo,
  type BackgroundDelegator,
  buildDelegateCapability,
  MAX_BACKGROUND_CHILDREN_PER_SESSION,
  runDelegatedChild,
} from "./delegate";
import { type ActiveSwitchRef, createSwitchCell, type SwitchCell } from "./switch-cell";
import { publishTurn } from "./turn";
import { type ActiveTurn, isAnswerablePrompt, type TurnScheduler } from "./turn-scheduler";

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
  /** The clip control producer id: such a prompt runs a restricted clipboard-only turn. */
  readonly clipProducerId: string;
  /** The durable-log transport, handed to the delegation context for child sessions. */
  readonly transport: SessionTransport;
  /** The registered providers the legacy provider-string path picks from. */
  readonly providers: ProviderRegistry;
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
  /** The run this host is ACTIVELY executing, or null (main.ts's mutable `runningRunId`). */
  getRunningRunId(): string | null;
  /** Mark/clear the actively-executing run. */
  setRunningRunId(runId: string | null): void;
  /** The active turn's mid-turn-switch cell, or null (main.ts's mutable `activeSwitch`). */
  getActiveSwitch(): ActiveSwitchRef;
  /** Register/clear the active turn's switch cell. */
  setActiveSwitch(next: ActiveSwitchRef): void;
}

/** Builds the turn fork over the host's live state; main.ts wires it once. */
export function makeStartTurn(deps: StartTurnDeps) {
  const {
    sessionId: SESSION_ID,
    producerId: PRODUCER_ID,
    clipProducerId: CLIP_PRODUCER_ID,
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
    getRunningRunId,
    setRunningRunId,
    getActiveSwitch,
    setActiveSwitch,
  } = deps;

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
    if (!isAnswerablePrompt(event.producerId, PRODUCER_ID) || !lease.isLeader()) {
      return null;
    }
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type !== "user.message") {
      return null;
    }
    const runId = crypto.randomUUID();
    // Resolve the turn's source + reasoning through the migration bridge (D-065): a new event's
    // `model` ModelRef wins (its sourceId is the provider key, its reasoning is authoritative), else
    // the legacy provider/reasoning strings. pickProvider defaults an unknown/undefined source.
    const turnModel = resolveUserTurnModel(decoded);
    // Resolve the turn's provider (D-065): a ModelRef into a known catalog SOURCE builds a provider for
    // that exact model (so any catalog model runs, not just the ~6 registered keys); otherwise fall back
    // to the legacy registered providers keyed by the provider string. pickProvider defaults an unknown.
    const provider =
      (decoded.model ? buildSourceProvider(decoded.model.sourceId, decoded.model.modelId) : null) ??
      pickProvider(providers, turnModel.sourceId);
    // Remember the turn's provider so a between-turn fold summarizes with the same model (D-043).
    compactionController.noteProvider(provider);
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
    const restricted = event.producerId === CLIP_PRODUCER_ID;
    const delegate = restricted
      ? undefined
      : buildDelegateCapability(delegationCtx, {
          provider,
          parentRunId: runId,
          agents: discoverAgents(),
          mintRunId: () => crypto.randomUUID(),
          background,
        });
    setRunningRunId(runId);
    // The per-turn mid-turn-switch cell (09.1): a `/clip` turn is not switchable (restricted surface), an
    // ordinary turn is. Registered so `handleEvent` can route a `model.switch.requested` for this run into
    // it; the loop reads it at the next step boundary.
    const switchCell = restricted ? undefined : createSwitchCell();
    setActiveSwitch(switchCell ? { runId, cell: switchCell } : null);
    // Carry the prior turn's measured context forward (03.1 D-002): when compaction has floored out and
    // the turn legitimately starts at/above the fraction, this lets the context-pressure gate synthesize
    // at step 0 instead of opening one doomed tool round. Absent on a session's first turn.
    const seedUsage = compactionController.usageSeed();
    const fiber = Effect.runFork(
      publishTurn(provider, turnHistory, {
        runId,
        reasoning: decoded.reasoning,
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
        ...(switchCell ? { switch: switchCell } : {}),
        // Resolve a mid-turn model switch to a fresh provider (09.1 M4): same source builder used to build
        // the turn's initial provider, so any catalog model can be swapped to mid-flight.
        ...(switchCell
          ? {
              rebuildProvider: (model: ModelRef) =>
                buildSourceProvider(model.sourceId, model.modelId),
            }
          : {}),
        // The turn's starting ref (when it carried one) seeds the same-model check, so a reasoning-only
        // re-send of the unchanged model does not pointlessly rebuild the provider.
        ...(switchCell && decoded.model ? { initialModel: decoded.model } : {}),
      }).pipe(Effect.provide(EmitLive)),
    );
    fiber.addObserver((exit) => {
      // The fiber is no longer running this turn: clear the active marker so a reconnect reconcile treats
      // a lingering in-flight entry for it as an orphan (its terminal completion may have been lost).
      if (getRunningRunId() === runId) {
        setRunningRunId(null);
      }
      // Drop the switch cell for this run so a late switch request can't write into a dead turn.
      if (getActiveSwitch()?.runId === runId) {
        setActiveSwitch(null);
      }
      // publishTurn handles provider failures internally, so a non-interrupt failure here
      // is an unexpected defect worth surfacing.
      if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
        warn("host", "turn died", { run: runId.slice(0, 8), cause: Cause.pretty(exit.cause) });
      }
      scheduler.settle(runId);
    });
    return {
      runId,
      cancel: () => {
        log("host", "cancel: interrupting run", { run: runId.slice(0, 8) });
        Effect.runFork(Fiber.interrupt(fiber));
      },
    };
  }

  return { startTurn };
}

import { ActiveRun } from "@host/agent/active-run";
import { CompactionController } from "@host/agent/compaction-controller";
import { ConversationLog } from "@host/agent/conversation-log";
import type { BackgroundChildInfo } from "@host/agent/delegate";
import { makeRunLifecycle } from "@host/agent/run-lifecycle";
import { makeStartTurn } from "@host/agent/start-turn";
import { TurnMachine } from "@host/agent/turn-machine";
import { TurnScheduler } from "@host/agent/turn-scheduler";
import type { InternetMonitor } from "@host/connectivity/probe";
import { DEFAULT_PROVIDER, type ProviderRegistry } from "@host/providers/index";
import type { HostResidency } from "@host/residency/host";
import type { Lease } from "@host/session/lease";
import { log } from "@host/transport/log";
import { emitLiveLayer } from "@host/transport/services";
import {
  decodeTrevorEvent,
  hostIdentity,
  inputEstimateTokens,
  isAnswerableProducer,
  pendingFollowUps,
  type SessionConnection,
  type SessionEvent,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";
import type { TelemetrySink } from "@trevor/session/telemetry";
import type { ProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";

/**
 * Responsible for: the parent host ADOPTING the tangent sessions branched off it (plan 37 takeover),
 * so a tangent's `user.message` is answered by the SAME process that serves its parent - without the
 * tangent ever becoming a fork. The parent host discovers its tangents through the inventory read
 * model ({@link tangentsOf}); main.ts hands the discovered id list to {@link reconcile}, which keeps
 * one isolated {@link SessionWorker} per tangent.
 *
 * Each worker mirrors main.ts's single-session composition against ONE tangent id: its own
 * ConversationLog fed ONLY from the tangent's own stream, its own TurnMachine/ActiveRun/
 * CompactionController/TurnScheduler, an Emit that publishes to the TANGENT id, and
 * `makeStartTurn({ sessionId: tangentId })` so every seam (the delegation `parentSessionId`, the
 * turn's `hooks.identity.sessionId`, the EmitLive publish target) resolves to the tangent - never the
 * parent. Because the prompt is `buildHistory` folded over that single tangent log, the isolation
 * invariant (tangent-isolation.ts) holds by construction: no parent event is ever fed in.
 *
 * Not for: the turn program (agent/turn.ts), when a turn runs (agent/turn-scheduler.ts), or how a
 * tangent is CREATED (packages/session/src/tangent.ts - the web writes the `session.tangentOf` marker
 * onto the tangent; this host only discovers + answers).
 *
 * FIRST-CUT SCOPE: a tangent turn runs WITHOUT compaction (the scheduler is wired with no compaction
 * gate, so a fold never fires) and WITHOUT delegation/subagents (each worker gets its own empty
 * `backgroundChildren` map, and `makeStartTurn` reads that map for the parent-turn cap, so a tangent
 * can start no background child in this cut). Only the PARENT leader adopts: the scheduler + every
 * `startTurn` gate on the parent `lease.isLeader()`, so workers answer only while the parent is the
 * leader and are torn down when leadership lapses (main.ts calls {@link teardownAll} on loss).
 */

/** The shared, session-agnostic host deps every per-tangent worker is built over (mirrors the slices
 *  main.ts hands {@link makeStartTurn}). None of these carries a session id - the worker binds the
 *  tangent id itself, so one manager serves every tangent off the parent. */
export interface TangentAdoptionDeps {
  /** The PARENT session id: what tangents are discovered against, and the leak-check baseline. */
  readonly parentSessionId: string;
  /** The host's shared producer id: the self-echo gate + turn attribution (same as the main session). */
  readonly producerId: string;
  /** This host instance's id, stamped on each worker's stream identity. */
  readonly instanceId: string;
  /** The durable-log transport: every worker subscribes to + publishes on the tangent through it. */
  readonly transport: SessionTransport;
  /** The registered providers a tangent turn resolves its model from (same registry as the main session). */
  readonly providers: ProviderRegistry;
  /** The host's local-model residency, reconciled to each tangent turn's provider (plan 11.1). */
  readonly residency: Pick<HostResidency, "onActiveModelChanged">;
  /** The internet monitor (D-060): a cloud tangent turn refreshes a stale advisory, fire-and-forget. */
  readonly internet: Pick<InternetMonitor, "refreshIfStale">;
  /** The PARENT lease: only the leader answers tangents, so workers migrate with leadership. */
  readonly lease: Pick<Lease, "isLeader">;
  /** The host telemetry sink threaded into every tangent turn (plan 13 M5). */
  readonly hostTelemetry: TelemetrySink;
  /** The opt-in provider-attempt trace writer (plan 13 M6). */
  readonly providerTrace: ProviderTraceWriter;
}

/** The manager main.ts drives: converge the live worker set to the discovered tangent ids. */
export interface TangentAdoption {
  /**
   * Converge the adopted-worker set to `tangentIds` (the parent's live, non-deleted tangents).
   * Idempotent: a tangent already adopted is left running; a newly-seen id spins up one worker; an
   * id no longer present (soft-deleted/archived out of {@link tangentsOf}) has its worker torn down.
   */
  readonly reconcile: (tangentIds: readonly string[]) => void;
  /** Disconnect + drop every worker (leadership loss, or shutdown). Idempotent. */
  readonly teardownAll: () => void;
  /** How many tangent workers are currently adopted (for /doctor + tests). */
  readonly adoptedCount: () => number;
}

/** One adopted tangent: the live stream handle plus the teardown that stops its reconnect loop. */
interface SessionWorker {
  readonly tangentId: string;
  readonly close: () => void;
}

/** Builds the tangent-adoption manager over the host's shared, session-agnostic deps. */
export function makeTangentAdoption(deps: TangentAdoptionDeps): TangentAdoption {
  const {
    parentSessionId,
    producerId,
    instanceId,
    transport,
    providers,
    residency,
    internet,
    lease,
    hostTelemetry,
    providerTrace,
  } = deps;

  const workers = new Map<string, SessionWorker>();

  /**
   * Spins up an isolated worker for one tangent id: the per-tangent cluster (its OWN ConversationLog,
   * TurnMachine, ActiveRun, CompactionController, TurnScheduler, and `startTurn` bound to the tangent
   * id) plus a replay-then-tail subscription whose minimal `handleEvent` records the tangent's own
   * events and answers its `user.message`s. Every piece is fresh per worker, so two tangents never
   * share a log and the parent's log is never touched.
   */
  function makeSessionWorker(tangentId: string): SessionWorker {
    // The per-tangent prompt log: fed ONLY from this tangent's stream. This is the whole isolation
    // guarantee - the turn prompt is `buildHistory` over these events, so a parent event can never
    // reach the model as long as nothing here admits one.
    const conversationLog = new ConversationLog({ selfProducerId: producerId });
    const turnMachine = new TurnMachine();
    const activeRun = new ActiveRun();
    const compactionController = new CompactionController(providers[DEFAULT_PROVIDER]);
    // FIRST CUT: a fresh, always-empty registry so a tangent turn starts NO background child (the
    // delegation cap `makeStartTurn` reads is `backgroundChildren.size`, which stays 0 here). The
    // parent's own subagent registry is never shared into a tangent.
    const backgroundChildren = new Map<string, BackgroundChildInfo>();

    // Replay gate + reconnect control (mirrors main.ts's `live` + connect() reconnect). A turn is
    // forked only once the tangent's replay has completed; teardown flips `closed` so a socket-close
    // reconnect stops.
    let live = false;
    let closed = false;
    let connection: SessionConnection | null = null;

    /** Publishes one event to the TANGENT's durable log, attaching this host's producerId. */
    const emit = (event: TrevorEventInput): Promise<void> =>
      transport.publishEvent(tangentId, { ...event, producerId });

    // The live Emit layer for this tangent's turns: the same shared dedup discipline main.ts uses,
    // publishing to the tangent id.
    const emitLive = emitLiveLayer(emit, (runId) => turnMachine.markCompleted(runId));

    // The tangent's turn scheduler: gated on the PARENT lease so only the leader answers, and wired
    // with NO compaction gate (first cut) so a fold never fires. `start` admits the prompt into the
    // tangent's own log, then forks its turn only when live - the same shape as main.ts's scheduler.
    const scheduler = new TurnScheduler({
      isLeader: () => lease.isLeader(),
      start: (event) => {
        conversationLog.admit(event);
        return live ? startTurn(event, conversationLog.historySnapshot()) : null;
      },
    });

    // The turn fork bound to THIS tangent id: `sessionId: tangentId` makes the delegation
    // `parentSessionId`, the turn's `hooks.identity.sessionId`, and the EmitLive publish target all
    // resolve to the tangent - never the parent. Resolved lazily by the scheduler's `start` closure
    // above, so the scheduler-first order is TDZ-safe (matching main.ts).
    const { startTurn } = makeStartTurn({
      sessionId: tangentId,
      producerId,
      transport,
      providers,
      compactionController,
      residency,
      internet,
      lease,
      hostTelemetry,
      providerTrace,
      emitLive,
      scheduler,
      backgroundChildren,
      activeRun,
    });

    // The hard-cancel teardown (ESC in a tangent): `abortRuns` publishes the in-flight run's cancelled
    // completion (clients free instantly) AND interrupts its fiber via `scheduler.cancel` (tears the model
    // request down), then frees the scheduler. Wired over THIS tangent's machinery, with compaction +
    // subagents disabled (no manual fold, no background children) to match the first-cut scope. Identical
    // discipline to main.ts's user.cancel arm, so a tangent ESC cancels the same way the main chat does.
    const { abortRuns } = makeRunLifecycle({
      turnMachine,
      scheduler,
      emit,
      runningRunId: () => activeRun.runId(),
      manualCompactFiber: () => null,
      parentLog: () => conversationLog.events(),
      activeChildSessionIds: () => new Set<string>(),
    });

    /**
     * The MINIMAL per-tangent event handler: the subset of main.ts's handleEvent a tangent needs.
     * A `user.message` from an answerable producer schedules a turn; every turn-lifecycle event is
     * folded into the tangent's OWN log so the next turn's prompt is complete. No commands, shell,
     * handoff, compaction, or lease traffic - those are main-session concerns, out of this cut.
     */
    function handleEvent(message: SessionEvent): void {
      const decoded = decodeTrevorEvent(message);
      if (!decoded) {
        return;
      }
      if (decoded.type === "user.message" && isAnswerableProducer(message.producerId, producerId)) {
        // The turn arm: the scheduler's `start` admits it to this tangent's log and (live leader only)
        // forks its turn.
        scheduler.noteTurn(message);
      } else if (decoded.type === "user.cancel" && live && lease.isLeader()) {
        // Hard cancel (ESC in the tangent takeover): abort the in-flight tangent run - its cancelled
        // completion frees every client and its fiber is interrupted. LIVE LEADER only: a cancel is an
        // ACTION whose completion is already durable, so replay never re-emits it (mirrors main.ts).
        abortRuns(decoded.runId);
      } else if (decoded.type === "assistant.started") {
        // Track the run as in flight, and note the attempt so catch-up never re-runs an answered prompt.
        turnMachine.start(decoded.runId);
        scheduler.noteTurn(message);
      } else if (decoded.type === "assistant.progress") {
        // Carry the live prompt size so the compaction controller's usage seed stays current.
        if (decoded.usage) {
          const assembledEstimate = decoded.breakdown ? inputEstimateTokens(decoded.breakdown) : 0;
          compactionController.noteUsage(
            decoded.usage.input,
            decoded.usage.contextWindow,
            assembledEstimate,
          );
          turnMachine.progress(decoded.runId, decoded.usage, decoded.breakdown);
        }
      } else if (decoded.type === "assistant.completed") {
        turnMachine.complete(decoded);
        // Admit the reply so the NEXT turn's prompt already includes it (the paired-history invariant),
        // then free the slot + drain whatever queued while it ran.
        conversationLog.admit(message);
        if (decoded.usage) {
          const assembledEstimate = decoded.breakdown ? inputEstimateTokens(decoded.breakdown) : 0;
          compactionController.noteTurnCompleted(decoded.usage, assembledEstimate);
        } else {
          compactionController.noteTurnCompleted();
        }
        scheduler.processCompletion(decoded.runId, message.seq);
      } else if (
        decoded.type === "tool.started" ||
        decoded.type === "tool.completed" ||
        decoded.type === "tasks.current"
      ) {
        // Recorded WITHOUT a rebuild: tool activity + task snapshots only matter at the next turn
        // boundary, so the next admit (a completion) folds them in - the same discipline as main.ts.
        conversationLog.record(message);
      }
    }

    /** Connects to the tangent stream (replay-then-tail) with the same simple reconnect as main.ts. */
    function connect(): void {
      live = false;
      conversationLog.reset();
      scheduler.resetForReconnect();
      connection = transport.connectSession({
        sessionId: tangentId,
        // A host identity so the tangent shows this process as a live host serving it; the participant
        // id is per-session, so reusing the host's short id across tangents is safe.
        identity: hostIdentity({
          instanceId,
          participantId: `${producerId}:${instanceId.slice(0, 8)}`,
        }),
        onEvent: handleEvent,
        onReplayComplete: () => {
          live = true;
          // Catch up the prompt(s) already pending when this worker subscribed: replay `noteTurn`ed them
          // while off-live, so `start` returned null and nothing forked. Re-derive every unanswered,
          // not-superseded prompt from the tangent's own log and re-note them now that we're live, so the
          // first runs and the rest defer behind it - the SAME go-live catch-up main.ts's onBecomeLeader
          // does. Leader-gated + idle-guarded so a re-adopt/reconnect never re-runs a live turn.
          if (lease.isLeader() && !scheduler.isBusy()) {
            for (const prompt of pendingFollowUps(conversationLog.events(), producerId)) {
              scheduler.noteTurn(prompt);
            }
          }
        },
        onStatus: (status) => {
          if (status === "closed" && !closed) {
            // Re-check `closed` when the timer fires, not just now: a teardown (leadership loss) landing
            // inside this 1s window must stop the reconnect, else it resurrects a worker that has left the
            // manager's map - a leaked stream that double-answers the tangent once leadership returns.
            setTimeout(() => {
              if (!closed) {
                connect();
              }
            }, 1000);
          }
        },
      });
    }

    connect();

    return {
      tangentId,
      close: () => {
        closed = true;
        connection?.close();
      },
    };
  }

  return {
    reconcile: (tangentIds) => {
      const desired = new Set(tangentIds);
      for (const id of desired) {
        if (!workers.has(id)) {
          workers.set(id, makeSessionWorker(id));
          log("host", "tangent adopted", { parent: parentSessionId, tangent: id });
        }
      }
      // Drop workers for tangents that fell out of the discovered set (soft-deleted / archived away).
      for (const [id, worker] of workers) {
        if (!desired.has(id)) {
          worker.close();
          workers.delete(id);
          log("host", "tangent released", { parent: parentSessionId, tangent: id });
        }
      }
    },
    teardownAll: () => {
      for (const worker of workers.values()) {
        worker.close();
      }
      workers.clear();
    },
    adoptedCount: () => workers.size,
  };
}

import type { InternetMonitor } from "@host/connectivity/probe";
import type { ProviderRegistry } from "@host/providers/index";
import type { HostResidency } from "@host/residency/host";
import type { Lease } from "@host/session/lease";
import { makeSessionWorker, type SessionWorker } from "@host/session/session-worker";
import { log } from "@host/transport/log";
import { pendingFollowUps, type SessionTransport } from "@trevor/session";
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

  const startTangentWorker = (tangentId: string): SessionWorker =>
    makeSessionWorker({
      sessionId: tangentId,
      producerId,
      instanceId,
      transport,
      providers,
      residency,
      internet,
      lease,
      hostTelemetry,
      providerTrace,
      onReplayComplete: (worker) => {
        // Catch up prompts already pending when this worker subscribed. Replay records them while
        // off-live; re-note unanswered prompts after go-live so the first runs and later ones queue.
        if (lease.isLeader() && !worker.scheduler.isBusy()) {
          for (const prompt of pendingFollowUps(worker.conversationLog.events(), producerId)) {
            worker.scheduler.noteTurn(prompt);
          }
        }
      },
    });

  return {
    reconcile: (tangentIds) => {
      const desired = new Set(tangentIds);
      for (const id of desired) {
        if (!workers.has(id)) {
          workers.set(id, startTangentWorker(id));
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

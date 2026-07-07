import { ActiveRun } from "@host/agent/active-run";
import { CompactionController } from "@host/agent/compaction-controller";
import { ConversationLog } from "@host/agent/conversation-log";
import type { BackgroundChildInfo } from "@host/agent/delegate";
import { makeRunLifecycle } from "@host/agent/run-lifecycle";
import { makeStartTurn } from "@host/agent/start-turn";
import { TurnMachine } from "@host/agent/turn-machine";
import { TurnScheduler, type TurnSchedulerDeps } from "@host/agent/turn-scheduler";
import type { InternetMonitor } from "@host/connectivity/probe";
import { DEFAULT_PROVIDER, type ProviderRegistry } from "@host/providers/index";
import { createTurnProviderResolver } from "@host/providers/turn-provider-resolver";
import type { HostResidency } from "@host/residency/host";
import type { Lease } from "@host/session/lease";
import { log } from "@host/transport/log";
import { emitLiveLayer } from "@host/transport/services";
import {
  type ConnectionStatus,
  decodeTrevorEvent,
  hostIdentity,
  inputEstimateTokens,
  isAnswerableProducer,
  type SessionConnection,
  type SessionEvent,
  type SessionTransport,
  type TrevorEventInput,
  toPublishInput,
} from "@trevor/session";
import type { TelemetrySink } from "@trevor/session/telemetry";
import type { ProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";

/**
 * A per-session host worker owns one session's replay/live stream, prompt log, scheduler,
 * active-run state, cancellation, and turn-start composition.
 *
 * Responsible for: the shared turn lifecycle for one host-served session.
 * Not for: discovering which sessions to serve, command dispatch, or main-session-only side effects.
 */

export interface SessionWorkerDeps {
  readonly sessionId: string;
  readonly producerId: string;
  readonly instanceId: string;
  readonly transport: SessionTransport;
  readonly providers: ProviderRegistry;
  readonly residency: Pick<HostResidency, "onActiveModelChanged">;
  readonly internet: Pick<InternetMonitor, "refreshIfStale">;
  readonly lease: Pick<Lease, "isLeader">;
  readonly hostTelemetry: TelemetrySink;
  readonly providerTrace: ProviderTraceWriter;
  readonly backgroundChildren?: Map<string, BackgroundChildInfo>;
  readonly compaction?: TurnSchedulerDeps["compaction"];
  readonly manualCompactFiber?: Parameters<typeof makeRunLifecycle>[0]["manualCompactFiber"];
  readonly activeChildSessionIds?: () => ReadonlySet<string>;
  readonly pendingQuestionIds?: () => ReadonlySet<string>;
  readonly onEvent?: (message: SessionEvent, worker: SessionWorker) => void;
  readonly onReplayComplete?: (worker: SessionWorker) => void;
  readonly onStatus?: (status: ConnectionStatus, worker: SessionWorker) => void;
  readonly autoConnect?: boolean;
}

export interface SessionWorkerDebugInfo {
  readonly sessionId: string;
  readonly live: boolean;
  readonly closed: boolean;
  readonly historyLength: number;
  readonly eventCount: number;
  readonly scheduler: ReturnType<TurnScheduler["debug"]>;
}

export interface SessionWorker {
  readonly sessionId: string;
  readonly conversationLog: ConversationLog;
  readonly turnMachine: TurnMachine;
  readonly activeRun: ActiveRun;
  readonly compactionController: CompactionController;
  readonly scheduler: TurnScheduler;
  readonly emit: (event: TrevorEventInput) => Promise<void>;
  readonly abortRuns: (runId: string, kind?: "cancelled" | "steered") => void;
  readonly reapOrphans: () => void;
  readonly reapOrphanSubagents: () => void;
  readonly reapOrphanQuestions: () => void;
  readonly observePromptProvider: (message: SessionEvent) => void;
  readonly handleEvent: (message: SessionEvent) => void;
  readonly connect: () => void;
  readonly close: () => void;
  readonly isLive: () => boolean;
  readonly debugInfo: () => SessionWorkerDebugInfo;
}

function noopManualCompactFiber(): null {
  return null;
}

/** Builds one session worker. Callers decide which session ids should have workers. */
export function makeSessionWorker(deps: SessionWorkerDeps): SessionWorker {
  const {
    sessionId,
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

  const conversationLog = new ConversationLog({ selfProducerId: producerId });
  const turnMachine = new TurnMachine();
  const activeRun = new ActiveRun();
  const compactionController = new CompactionController(providers[DEFAULT_PROVIDER]);
  const turnProviderResolver = createTurnProviderResolver({
    providers,
    defaultProviderKey: DEFAULT_PROVIDER,
  });
  const backgroundChildren = deps.backgroundChildren ?? new Map<string, BackgroundChildInfo>();

  let live = false;
  let closed = false;
  let connection: SessionConnection | null = null;

  const emit = (event: TrevorEventInput): Promise<void> =>
    transport.publishEvent(sessionId, toPublishInput(event, producerId));

  const emitLive = emitLiveLayer(emit, (runId) => turnMachine.markCompleted(runId));

  const scheduler = new TurnScheduler({
    isLeader: () => lease.isLeader(),
    start: (event) => {
      conversationLog.admit(event);
      return live ? startTurn(event, conversationLog.historySnapshot()) : null;
    },
    ...(deps.compaction ? { compaction: deps.compaction } : {}),
  });

  const { startTurn } = makeStartTurn({
    sessionId,
    producerId,
    transport,
    providers,
    turnProviderResolver,
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

  const { abortRuns, reapOrphans, reapOrphanSubagents, reapOrphanQuestions } = makeRunLifecycle({
    turnMachine,
    scheduler,
    emit,
    runningRunId: () => activeRun.runId(),
    manualCompactFiber: deps.manualCompactFiber ?? noopManualCompactFiber,
    parentLog: () => conversationLog.events(),
    activeChildSessionIds: deps.activeChildSessionIds ?? (() => new Set<string>()),
    pendingQuestionIds: deps.pendingQuestionIds ?? (() => new Set<string>()),
  });

  function observePromptProvider(message: SessionEvent): void {
    if (!isAnswerableProducer(message.producerId, producerId)) {
      return;
    }
    const resolved = turnProviderResolver.resolveUserMessage(message);
    if (resolved) {
      compactionController.noteProvider(resolved.provider, resolved.budgetWindow);
    }
  }

  function handleEvent(message: SessionEvent): void {
    const decoded = decodeTrevorEvent(message);
    if (!decoded) {
      return;
    }
    if (decoded.type === "user.message" && isAnswerableProducer(message.producerId, producerId)) {
      observePromptProvider(message);
      scheduler.noteTurn(message);
    } else if (decoded.type === "user.cancel" && live && lease.isLeader()) {
      abortRuns(decoded.runId, decoded.steered ? "steered" : "cancelled");
    } else if (decoded.type === "assistant.started") {
      turnMachine.start(decoded.runId);
      scheduler.noteTurn(message);
    } else if (decoded.type === "assistant.progress") {
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
      conversationLog.admit(message);
      if (decoded.usage) {
        const assembledEstimate = decoded.breakdown ? inputEstimateTokens(decoded.breakdown) : 0;
        compactionController.noteTurnCompleted(decoded.usage, assembledEstimate);
      } else {
        compactionController.noteTurnCompleted();
      }
      scheduler.processCompletion(decoded.runId, message.seq);
    } else if (decoded.type === "context.compacted") {
      conversationLog.admit(message);
      compactionController.noteCompacted({
        throughSeq: decoded.throughSeq,
        tokensBefore: decoded.tokensBefore,
        tokensAfter: decoded.tokensAfter,
      });
      scheduler.finishCompaction();
    } else if (
      decoded.type === "tool.started" ||
      decoded.type === "tool.completed" ||
      decoded.type === "tasks.current"
    ) {
      conversationLog.record(message);
    }
  }

  const worker: SessionWorker = {
    sessionId,
    conversationLog,
    turnMachine,
    activeRun,
    compactionController,
    scheduler,
    emit,
    abortRuns,
    reapOrphans,
    reapOrphanSubagents,
    reapOrphanQuestions,
    observePromptProvider,
    handleEvent,
    connect,
    close,
    isLive: () => live,
    debugInfo: () => ({
      sessionId,
      live,
      closed,
      historyLength: conversationLog.history().length,
      eventCount: conversationLog.events().length,
      scheduler: scheduler.debug(),
    }),
  };

  function connect(): void {
    live = false;
    conversationLog.reset();
    compactionController.resetForReplay();
    scheduler.resetForReconnect();
    connection = transport.connectSession({
      sessionId,
      identity: hostIdentity({
        instanceId,
        participantId: `${producerId}:${instanceId.slice(0, 8)}`,
      }),
      onEvent: (message) => {
        if (deps.onEvent) {
          deps.onEvent(message, worker);
        } else {
          handleEvent(message);
        }
      },
      onReplayComplete: () => {
        live = true;
        deps.onReplayComplete?.(worker);
      },
      onStatus: (status) => {
        deps.onStatus?.(status, worker);
        if (status === "closed" && !closed) {
          setTimeout(() => {
            if (!closed) {
              log("host", "session worker reconnecting", { session: sessionId, ms: 1000 });
              connect();
            }
          }, 1000);
        }
      },
    });
  }

  function close(): void {
    closed = true;
    connection?.close();
  }

  if (deps.autoConnect !== false) {
    connect();
  }

  return worker;
}

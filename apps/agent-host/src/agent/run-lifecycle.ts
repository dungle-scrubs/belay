import { log } from "@host/transport/log";
import type { EmitEvent } from "@host/transport/services";
import type { SessionEvent } from "@trevor/session";
import { interruptFiber } from "../effect/fiber-exit";
import type { CompactionCommandsApi } from "./compaction-commands";
import { orphanedSubagentReaps } from "./delegate";
import { orphanedQuestionReaps } from "./provider-questions";
import type { TurnMachine } from "./turn-machine";
import type { TurnScheduler } from "./turn-scheduler";

/**
 * The run close/abort/reap lifecycle, extracted from main.ts (plan 22.3): main.ts constructs
 * {@link makeRunLifecycle} once over its live turn machine + scheduler and keeps dispatching from
 * handleEvent's user.cancel arm, the lifecycle commands, and the leadership reconciles under the
 * same local names.
 *
 * Responsible for: publishing the terminal completion for a run closed without one - the user
 * cancel/stop teardown (abortRuns) and the orphan reap a new/reconnecting leader runs (reapOrphans).
 * Not for: deciding WHEN to reap (boot/leadership.ts and main.ts's goLive wiring own that), or the
 * close-event dedup itself (agent/turn-machine.ts owns completedRuns).
 */

/** The live main.ts state the run lifecycle reads - the turn machine/scheduler seams. */
export interface RunLifecycleDeps {
  /** The turn machine: owns the in-flight set and the terminal-completion dedup. */
  readonly turnMachine: Pick<TurnMachine, "close" | "inFlightIds" | "reapExcept">;
  /** The turn scheduler: a cancel frees its active slot + deferred queue. */
  readonly scheduler: Pick<TurnScheduler, "cancel">;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The run this host is ACTIVELY executing, or null (main.ts's mutable `runningRunId`). */
  runningRunId(): string | null;
  /** The in-flight MANUAL /compact fold, or null (abortRuns interrupts it). */
  manualCompactFiber: CompactionCommandsApi["manualCompactFiber"];
  /** The replayed PARENT session log, for the subagent orphan scan (main.ts's conversationLog.events). */
  parentLog(): readonly SessionEvent[];
  /** The child sessions THIS host is actively running in the background, excluded from the reap the
   *  way `runningRunId` excludes the live turn (main.ts's backgroundChildren registry). */
  activeChildSessionIds(): ReadonlySet<string>;
  /** The question ids THIS host is actively blocking on (the provider-question runtime's live
   *  waiters), excluded from the question reap the way `runningRunId` excludes the live turn. */
  pendingQuestionIds(): ReadonlySet<string>;
}

/** Builds the run-lifecycle teardown over the host's live turn state; main.ts wires it once. */
export function makeRunLifecycle(deps: RunLifecycleDeps) {
  const {
    turnMachine,
    scheduler,
    emit,
    runningRunId,
    manualCompactFiber,
    parentLog,
    activeChildSessionIds,
    pendingQuestionIds,
  } = deps;

  /**
   * Publishes the terminal completion for a run being closed WITHOUT a completion of its own - a user
   * cancel (ESC) or a host reap of an orphan. Dedups via `completedRuns` (the fiber's own onExit is
   * dropped, so the run closes exactly once) and carries the run's last-known usage, since the tokens
   * it consumed don't vanish on a cancel. `cancelled` = the user pressed ESC; `interrupted` = the host
   * closed it (restart/crash mid-turn), rendered as a muted "host restarted" note rather than an ESC.
   */
  function closeRun(runId: string, kind: "cancelled" | "interrupted"): void {
    const event = turnMachine.close(runId, kind);
    if (event) {
      emit(event).catch(() => {});
    }
  }

  /**
   * Tears down the active work for a cancel/stop: interrupt a running MANUAL /compact (the user asked,
   * so they can take it back; automatic folds aren't tracked here and run to completion), close every
   * targeted run as `cancelled`, and cancel the scheduler. An empty `runId` means "whatever is active" -
   * every in-flight run - and matches `scheduler.cancel("")`. Shared by the live-leader user.cancel
   * handler and the graceful-stop path, so /stop + SIGTERM tear down the same things ESC does.
   */
  function abortRuns(runId: string): void {
    const compactFiber = manualCompactFiber();
    if (compactFiber) {
      interruptFiber(compactFiber);
    }
    const targets = runId ? [runId] : turnMachine.inFlightIds();
    for (const target of targets) {
      closeRun(target, "cancelled");
    }
    scheduler.cancel(runId);
  }

  /**
   * Closes runs left dangling by a previous leader (crashed or hot-reloaded mid-turn): an
   * assistant.started with no completion. Called on TAKING leadership, when this host has no turn of
   * its own running, so every in-flight run is a dead orphan. Closes each as `interrupted`, which
   * unfreezes the send queue and makes ESC meaningful again on the next real turn. Idempotent: each
   * emitted completion echoes back and the set is cleared.
   */
  function reapOrphans(): void {
    for (const event of turnMachine.reapExcept(runningRunId())) {
      const runId = typeof event.payload.runId === "string" ? event.payload.runId : "";
      log("host", "reaping orphaned run", { run: runId.slice(0, 8) });
      // Emit directly (not via closeRun's dedup gate): a turn whose completion was lost to a store outage
      // already tripped that gate, so going through it again would silently drop the reconciling event.
      emit(event).catch(() => {});
    }
  }

  /**
   * Closes background SUBAGENTS a previous leader left dangling (plan 52 / D-001): a
   * `delegated.to{running}` link on the parent log with no terminal link, whose owning host vanished
   * before it could fold back. The subagent analogue of {@link reapOrphans}: a background child OUTLIVES
   * its spawning turn, so it is keyed by `childSessionId` (not `runId`) and derived from the replayed
   * PARENT log, excluding children THIS host is itself running (`activeChildSessionIds`) exactly as the
   * turn reap excludes the live run. Emits a terminal `interrupted` link per orphan (distinct from a real
   * `failed`); idempotent by key, so a second takeover after the link is already terminal emits nothing.
   * Best-effort - it never throws, so it cannot crash the leadership transition.
   */
  function reapOrphanSubagents(): void {
    for (const event of orphanedSubagentReaps(parentLog(), activeChildSessionIds())) {
      const child =
        typeof event.payload.childSessionId === "string" ? event.payload.childSessionId : "";
      log("host", "reaping orphaned subagent", { child: child.slice(-8) });
      emit(event).catch(() => {});
    }
  }

  /**
   * Closes ask_user QUESTIONS a previous leader left dangling: a `provider.question.requested` on the
   * log with no `provider.question.resolved`, whose in-memory waiter died with the host that asked it.
   * Without this, the browser shows a permanently un-submittable question panel (every Submit is an
   * AQ001 no-op) with the composer unmounted behind it - the session is wedged until someone hand-writes
   * the resolution. Runs at the same takeover triggers as {@link reapOrphanSubagents}; NOT gated on
   * `hasInFlight`, because the question outlives its run's reap (an earlier takeover may have closed the
   * run as interrupted while leaving the question pending). Questions THIS host is actively blocking on
   * (`pendingQuestionIds`) are excluded, so a live question is never cancelled out from under its waiter.
   * Idempotent: each emitted resolution echoes back into the log. Best-effort - it never throws.
   */
  function reapOrphanQuestions(): void {
    for (const event of orphanedQuestionReaps(parentLog(), pendingQuestionIds())) {
      const questionId =
        typeof event.payload.questionId === "string" ? event.payload.questionId : "";
      log("host", "reaping orphaned question", { question: questionId.slice(0, 8) });
      emit(event).catch(() => {});
    }
  }

  return { abortRuns, reapOrphans, reapOrphanSubagents, reapOrphanQuestions };
}

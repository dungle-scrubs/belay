import type { ProviderError } from "@host/providers/index";
import { log } from "@host/transport/log";
import type { EmitEvent } from "@host/transport/services";
import type { TrevorEventInput } from "@trevor/session";
import { Effect, Fiber } from "effect";
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
  manualCompactFiber(): Fiber.RuntimeFiber<TrevorEventInput | null, ProviderError> | null;
}

/** Builds the run-lifecycle teardown over the host's live turn state; main.ts wires it once. */
export function makeRunLifecycle(deps: RunLifecycleDeps) {
  const { turnMachine, scheduler, emit, runningRunId, manualCompactFiber } = deps;

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
      Effect.runFork(Fiber.interrupt(compactFiber));
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

  return { abortRuns, reapOrphans };
}

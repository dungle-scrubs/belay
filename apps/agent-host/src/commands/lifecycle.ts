import type { TurnScheduler } from "@host/agent/turn-scheduler";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { supervisor } from "@host/processes/processes";
import type { HostResidency } from "@host/residency/host";
import { type StopOutcome, stopSession } from "@host/session/session-lifecycle";
import type { SessionSwitchApi } from "@host/session/session-switch";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import { events } from "@trevor/session";
import { isStopConfirmed } from "./debug-commands";

/**
 * The debug lifecycle commands (/debug, /restart, /archive, /unarchive, /stop) and the graceful
 * stop (D-094), extracted from main.ts (plan 22.2 M2): main.ts constructs
 * {@link makeLifecycleCommands} once over its live switch mechanics + teardown seams and keeps
 * dispatching from its command lane (and the SIGTERM handler, which shares performGracefulStop)
 * under the same local names. The runtime debug flag stays main.ts state - announceOnline and the
 * replacement-host env read it there - threaded through as {getDebug, setDebug}.
 *
 * Responsible for: the /debug toggle, the /restart in-place re-exec, the /archive|/unarchive
 * durable flag flips, the /stop confirm flow, and the graceful session teardown they share with
 * SIGTERM.
 * Not for: which commands are debug-gated or the /stop confirm grammar (debug-commands.ts), the
 * teardown ordering contract (session/session-lifecycle.ts), or spawning/retiring the host itself
 * (session/session-switch.ts - main.ts wires those in as deps).
 */

/** The live main.ts state and teardown seams the lifecycle commands run through. */
export interface LifecycleCommandsDeps {
  /** The current session's id (main.ts's SESSION_ID, computed from env). */
  readonly sessionId: string;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** Re-announce host.online so every client's command set (and slash menu) reflects the new surface. */
  announceOnline(): void;
  /** Read the runtime debug flag (main.ts's mutable `debugMode`). */
  getDebug(): boolean;
  /** Flip the runtime debug flag. */
  setDebug(on: boolean): void;
  /** Spawn the replacement host (session/session-switch, wired through main.ts). */
  readonly spawnReplacementHost: SessionSwitchApi["spawnReplacementHost"];
  /** Retire this host once the replacement spawns (session/session-switch, wired through main.ts). */
  readonly retireAfterSessionSwitch: SessionSwitchApi["retireAfterSessionSwitch"];
  /** Free the cwd advisory lock for the next owner (main.ts's releaseWorkspaceCwdLock). */
  releaseWorkspaceCwdLock(): void;
  /** The host's local-model residency: its claim is released on a graceful stop. */
  readonly residency: Pick<HostResidency, "shutdown">;
  /** Tear down the active work for a stop (main.ts's abortRuns; "" = whatever is active). */
  abortRuns(runId: string): void;
  /** The turn scheduler: the stop clears its queue and reports its busy/queued state. */
  readonly scheduler: Pick<TurnScheduler, "clearPending" | "isBusy" | "debug">;
}

/** Builds the lifecycle commands over the host's live teardown seams; main.ts wires it once. */
export function makeLifecycleCommands(deps: LifecycleCommandsDeps) {
  const {
    sessionId: SESSION_ID,
    emit,
    announceOnline,
    getDebug,
    setDebug,
    spawnReplacementHost,
    retireAfterSessionSwitch,
    releaseWorkspaceCwdLock,
    residency,
    abortRuns,
    scheduler,
  } = deps;

  /** Toggles debug-command mode and re-announces, so the slash menu reveals/hides the debug set. */
  function toggleDebug(): void {
    const debugMode = !getDebug();
    setDebug(debugMode);
    log("host", "debug mode", { on: debugMode });
    emit(
      events.commandResult({
        command: "/debug",
        text: debugMode
          ? "✓ debug mode ON — extra commands available (try /restart)"
          : "debug mode OFF",
        ok: true,
      }),
    ).catch(() => {});
    // Re-announce so every client's command set (and slash menu) reflects the new surface.
    announceOnline();
  }

  /**
   * Restarts the host IN PLACE (debug-only): spawns a replacement on the SAME session/cwd and retires
   * this process, so a fresh `tsx main.ts` picks up code changes on demand. Unlike `/cd`/`/clear` it
   * keeps the session, so the browser stays put and just reconnects; an in-flight turn is orphaned and
   * the new leader reaps it. The headline reason debug mode exists: a stable (non-watch) host plus an
   * explicit "pick up my changes" instead of an auto-watch restart that silently breaks a live turn.
   */
  async function restartHost(args: string): Promise<void> {
    // The typed `/restart` stays debug-gated (so a normal session can't be restarted by a stray
    // keystroke), but the sidebar's explicit "restart" button sends `force` to bypass the gate - a
    // deliberate click is its own confirmation and shouldn't require toggling debug first.
    const forced = args.trim() === "force";
    if (!getDebug() && !forced) {
      await emit(
        events.commandResult({
          command: "/restart",
          text: "Run /debug first — /restart is a debug-mode command.",
          ok: false,
        }),
      );
      return;
    }
    try {
      const spawned = spawnReplacementHost({
        cwd: process.cwd(),
        sessionId: SESSION_ID,
        workspace: WORKSPACE_ROOT,
      });
      await emit(
        events.commandResult({
          command: "/restart",
          text: `✓ restarting host (pid ${spawned.pid}) — reconnecting with fresh code…`,
          ok: true,
        }),
      );
      log("host", "restart: replacement spawned", { pid: spawned.pid, session: SESSION_ID });
      retireAfterSessionSwitch();
    } catch (error) {
      warn("host", "restart failed", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/restart",
          text: `Failed to restart host: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  /**
   * Runs the graceful session teardown (D-094): abort active work (a clean cancelled completion where
   * the turn can still flush), clear the deferred queue so no successor answers stale prompts, and tear
   * down background jobs - in that order. Shared by the SIGTERM path (`trevor stop`) and the debug
   * `/stop` command; the CALLER exits the process afterward (which lapses the lease). The durable log is
   * never touched - nothing here can reach it.
   */
  function performGracefulStop(): StopOutcome {
    // Free the cwd advisory lock for the next owner before we tear the session down (plan 01).
    releaseWorkspaceCwdLock();
    // Release this instance's local-model residency claim so a peer can reclaim/evict promptly instead of
    // waiting out the TTL (plan 11.1). The claim release flushes synchronously on the uncontended store
    // fast path; the follow-on unload sweep is best-effort and may be cut short by the imminent exit -
    // that's fine, a peer sweeps it. Fire-and-forget so teardown ordering is unchanged.
    void residency.shutdown();
    return stopSession({
      abortActive: () => abortRuns(""),
      clearQueue: () => scheduler.clearPending(),
      killJobs: () => supervisor.killAll(),
      isBusy: () => scheduler.isBusy(),
      queuedCount: () => scheduler.debug().queued,
    });
  }

  /**
   * The debug `/archive` and `/unarchive` commands (D-094 M4): flip the durable `session.archived` flag
   * for the CURRENT session. Archiving hides it from the sidebar and `/resume` (the open browser then
   * gates behind its unarchive notice); it never deletes history, and `/unarchive` is the exact inverse.
   * Debug-gated like `/restart` (the handler re-checks even though the spec is only announced in debug).
   */
  async function setArchived(archived: boolean): Promise<void> {
    const command = archived ? "/archive" : "/unarchive";
    if (!getDebug()) {
      await emit(
        events.commandResult({
          command,
          text: `Run /debug first — ${command} is a debug-mode command.`,
          ok: false,
        }),
      );
      return;
    }
    await emit(events.sessionArchived({ archived }));
    await emit(
      events.commandResult({
        command,
        text: archived
          ? "✓ archived — hidden from the sidebar and /resume (history preserved; /unarchive to restore)."
          : "✓ unarchived — restored to the sidebar and /resume.",
        ok: true,
      }),
    );
  }

  /**
   * The debug `/stop` command (D-094 M4): graceful session shutdown, gated behind debug mode AND an
   * explicit confirm because it ends the session. Bare `/stop` only describes the effect; `/stop
   * confirm` runs the same teardown as `trevor stop` (SIGTERM), reports what it tore down, then exits so
   * the lease lapses and the launcher reaps the ownership record. History is preserved throughout.
   */
  async function stopCurrentSession(args: string): Promise<void> {
    if (!getDebug()) {
      await emit(
        events.commandResult({
          command: "/stop",
          text: "Run /debug first — /stop is a debug-mode command.",
          ok: false,
        }),
      );
      return;
    }
    if (!isStopConfirmed(args)) {
      await emit(
        events.commandResult({
          command: "/stop",
          text: "Stop ends this session: it cancels the active turn, clears the queue, tears down background jobs, and shuts the host down. History is preserved. Run `/stop confirm` to proceed.",
          ok: true,
        }),
      );
      return;
    }
    let outcome: StopOutcome;
    try {
      outcome = performGracefulStop();
    } catch (error) {
      warn("host", "graceful stop failed; tearing down anyway", { error: msg(error) });
      supervisor.killAll();
      await emit(
        events.commandResult({
          command: "/stop",
          text: `Stopped (forced): ${msg(error)}`,
          ok: false,
        }),
      );
      process.exit(0);
    }
    log("host", "stopping (/stop)", {
      cancelledActive: outcome.cancelledActive,
      clearedQueued: outcome.clearedQueued,
    });
    await emit(
      events.commandResult({
        command: "/stop",
        text: `✓ stopped — ${outcome.cancelledActive ? "cancelled the active turn" : "no active turn"}, cleared ${outcome.clearedQueued} queued. Shutting down; history is preserved.`,
        ok: true,
      }),
    );
    process.exit(0);
  }

  return { toggleDebug, restartHost, performGracefulStop, setArchived, stopCurrentSession };
}

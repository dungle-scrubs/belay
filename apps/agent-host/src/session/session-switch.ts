import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BackgroundChildInfo } from "@host/agent/delegate";
import type { TurnMachine } from "@host/agent/turn-machine";
import type { TurnScheduler } from "@host/agent/turn-scheduler";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { supervisor } from "@host/processes/processes";
import { contextRegistry } from "@host/project-context/registry";
import type { ProviderError } from "@host/providers/index";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import {
  events,
  freshSessionId,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";
import type { Fiber } from "effect";
import { resolveCdTarget } from "./workspace-switch";

/**
 * The session-switch mechanics (/clear, /cd, and the shared workspace-switch gate + mechanic),
 * extracted from main.ts (plan 22.2 M2): main.ts constructs {@link makeSessionSwitch} once over
 * its live scheduler/turn state and keeps dispatching from its command lane under the same local
 * names; the handoff orchestrator, worktree commands, and lifecycle commands receive these
 * functions through main.ts's wiring rather than importing them here.
 *
 * Responsible for: spawning the replacement host, retiring this one after a session.switch, the
 * /clear and /cd fresh-session flows, and the shared workspace-switch blocker + mechanic.
 * Not for: resolving the /cd target (workspace-switch.ts), the /worktree-* handlers
 * (worktrees/commands.ts), or the /handoff orchestration (handoff/orchestrator.ts) - main.ts
 * wires these mechanics into those as deps.
 */

/** The replacement host's destination: the directory, session, and workspace root it starts on. */
export type WorkspaceTarget = {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspace: string;
};

/** The live main.ts state the switch mechanics read - the scheduler/turn seams. */
export interface SessionSwitchDeps {
  /** The current session's id (main.ts's SESSION_ID, computed from env). */
  readonly sessionId: string;
  /** The durable-log transport: the target session is ensured before the switch. */
  readonly transport: Pick<SessionTransport, "ensureSession">;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The turn scheduler: the switch blocker reads its busy/queue state; a switch drops its queue. */
  readonly scheduler: Pick<TurnScheduler, "isBusy" | "debug" | "clearPending">;
  /** The turn machine: a switch is blocked while a prior run is still being reconciled. */
  readonly turnMachine: Pick<TurnMachine, "hasInFlight">;
  /** The in-flight MANUAL /compact fold, or null (main.ts's mutable `manualCompactFiber`). */
  manualCompactFiber(): Fiber.RuntimeFiber<TrevorEventInput | null, ProviderError> | null;
  /** Background subagents currently running across the session (main.ts's registry). */
  readonly backgroundChildren: ReadonlyMap<string, BackgroundChildInfo>;
  /** The runtime debug flag (main.ts's mutable `debugMode`), carried across a re-exec. */
  debugMode(): boolean;
}

/** Builds the session-switch mechanics over the host's live state; main.ts wires it once. */
export function makeSessionSwitch(deps: SessionSwitchDeps) {
  const {
    sessionId: SESSION_ID,
    transport,
    emit,
    scheduler,
    turnMachine,
    manualCompactFiber,
    backgroundChildren,
    debugMode,
  } = deps;

  function spawnReplacementHost(opts: WorkspaceTarget): { readonly pid: number } {
    // Re-exec with the SAME node invocation that started THIS process. Under the dev/start lanes the
    // host runs via tsx, which installs its TypeScript loader through process.execArgv (--require
    // preflight, --import loader) - NOT argv. Dropping execArgv respawns a bare `node src/main.ts`, which
    // dies instantly on the first extensionless `.ts` import (ERR_MODULE_NOT_FOUND); with stdio:"ignore"
    // that death is silent, so /cd, /clear, and /restart would leave the new session hostless ("starting
    // host…" forever). Carrying execArgv through reproduces the full launch; it's empty under a compiled
    // binary, so this is a no-op there.
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SESSION_ID: opts.sessionId,
        TREVOR_WORKSPACE: opts.workspace,
        TREVOR_MANAGED_HOST: "1",
        // tsx resolves tsconfig `paths` from the child's cwd, and the replacement's cwd is the TARGET
        // project - which has no @host/* mapping - so without this pointer the re-exec dies on its
        // first @host import (silently: stdio is "ignore"). Self-anchored so it also covers hosts
        // whose launcher didn't set it.
        TSX_TSCONFIG_PATH:
          process.env.TSX_TSCONFIG_PATH ?? join(import.meta.dirname, "..", "..", "tsconfig.json"),
        // Carry the CURRENT debug flag (which may have been toggled at runtime via /debug, so it
        // isn't in process.env) across the re-exec, so a debug session stays in debug after /restart.
        ...(debugMode() ? { TREVOR_DEBUG: "1" } : {}),
      },
    });
    child.unref();
    if (!child.pid) {
      throw new Error("replacement host did not report a pid");
    }
    return { pid: child.pid };
  }

  function retireAfterSessionSwitch(): void {
    const timer = setTimeout(() => {
      supervisor.killAll();
      if (process.env.TREVOR_MANAGED_HOST === "1") {
        process.exit(0);
      }
    }, 750);
    timer.unref();
  }

  async function clearToFreshSession(): Promise<void> {
    const nextSessionId = freshSessionId();
    try {
      await transport.ensureSession(nextSessionId);
      const spawned = spawnReplacementHost({
        cwd: process.cwd(),
        sessionId: nextSessionId,
        workspace: WORKSPACE_ROOT,
      });
      await emit(
        events.commandResult({
          command: "/clear",
          text: `✓ started fresh session ${nextSessionId}`,
          ok: true,
        }),
      );
      await emit(events.sessionSwitch({ sessionId: nextSessionId, reason: "clear" }));
      log("host", "clear: switched session", {
        from: SESSION_ID,
        to: nextSessionId,
        pid: spawned.pid,
      });
      retireAfterSessionSwitch();
    } catch (error) {
      warn("host", "clear: failed to switch session", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/clear",
          text: `Failed to start a fresh session: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  function workspaceSwitchBlocker(): string | null {
    const turns = scheduler.debug();
    if (scheduler.isBusy() || turns.queued > 0) {
      return "a turn is running or queued";
    }
    if (turns.compacting || manualCompactFiber()) {
      return "compaction is running";
    }
    if (turnMachine.hasInFlight) {
      return "a prior run is still being reconciled";
    }
    if (backgroundChildren.size > 0) {
      return "background subagents are running";
    }
    const jobs = supervisor.list().filter((job) => job.status === "running");
    if (jobs.length > 0) {
      return `background jobs are running (${jobs.map((job) => job.id).join(", ")})`;
    }
    return null;
  }

  /**
   * The workspace-switch precondition the /cd, /handoff, and /worktree-* handlers all share: if a turn,
   * compaction, background subagent, or shell job is in flight, emit the command's bail result
   * ("Cannot <verb> while <blocker>.") and return true so the handler stops; otherwise false. One guard,
   * so a new switch command can't forget the blocker or word the bail differently.
   */
  async function blockedFromWorkspaceSwitch(command: string, verb: string): Promise<boolean> {
    const blocker = workspaceSwitchBlocker();
    if (!blocker) {
      return false;
    }
    await emit(
      events.commandResult({ command, text: `Cannot ${verb} while ${blocker}.`, ok: false }),
    );
    return true;
  }

  async function cdToFreshSession(args: string): Promise<void> {
    if (await blockedFromWorkspaceSwitch("/cd", "switch directories")) {
      return;
    }

    const target = resolveCdTarget(args, { cwd: process.cwd() });
    if (!target.ok) {
      await emit(events.commandResult({ command: "/cd", text: target.error, ok: false }));
      return;
    }

    try {
      await transport.ensureSession(target.value.sessionId);
      const spawned = spawnReplacementHost(target.value);
      await emit(
        events.commandResult({
          command: "/cd",
          text: `✓ switched to ${target.value.cwd}`,
          ok: true,
        }),
      );
      await emit(events.sessionSwitch({ sessionId: target.value.sessionId, reason: "cd" }));
      log("host", "cd: switched session", {
        cwd: target.value.cwd,
        from: SESSION_ID,
        pid: spawned.pid,
        to: target.value.sessionId,
        workspace: target.value.workspace,
      });
      scheduler.clearPending();
      contextRegistry.reset();
      retireAfterSessionSwitch();
    } catch (error) {
      warn("host", "cd: failed to switch session", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/cd",
          text: `Failed to switch directories: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  /**
   * The shared workspace-switch mechanic (D-091): ensure the target session, spawn the replacement
   * host at the new cwd/workspace/session, publish the session.switch the browser follows, reset the
   * scheduler + lazy context, and retire this host. Used by worktree create/switch; `/cd` keeps its
   * own copy with its bespoke result text.
   */
  async function switchToWorkspace(
    opts: WorkspaceTarget & { readonly reason: "cd" | "worktree" },
  ): Promise<void> {
    await transport.ensureSession(opts.sessionId);
    const spawned = spawnReplacementHost({
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      workspace: opts.workspace,
    });
    await emit(events.sessionSwitch({ sessionId: opts.sessionId, reason: opts.reason }));
    log("host", `${opts.reason}: switched session`, {
      cwd: opts.cwd,
      from: SESSION_ID,
      pid: spawned.pid,
      to: opts.sessionId,
    });
    scheduler.clearPending();
    contextRegistry.reset();
    retireAfterSessionSwitch();
  }

  return {
    spawnReplacementHost,
    retireAfterSessionSwitch,
    clearToFreshSession,
    blockedFromWorkspaceSwitch,
    cdToFreshSession,
    switchToWorkspace,
  };
}

/** The wired switch mechanics' shape - consumer deps derive member types from this (e.g.
 *  `SessionSwitchApi["switchToWorkspace"]`) instead of re-declaring the signatures. */
export type SessionSwitchApi = ReturnType<typeof makeSessionSwitch>;

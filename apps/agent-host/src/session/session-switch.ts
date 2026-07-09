import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompactionCommandsApi } from "@host/agent/compaction-commands";
import type { BackgroundChildInfo } from "@host/agent/delegate";
import type { TurnMachine } from "@host/agent/turn-machine";
import type { TurnScheduler } from "@host/agent/turn-scheduler";
import { TREVOR_STATE_HOME, WORKSPACE_ROOT } from "@host/boot/paths";
import { commandReplier } from "@host/commands/command-replier";
import { supervisor } from "@host/processes/processes";
import { contextRegistry } from "@host/project-context/registry";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import {
  events,
  freshSessionId,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { resolveCdTarget } from "./workspace-switch";

/**
 * The session-switch mechanics (/clear, /cd, and the shared workspace-switch gate + mechanic),
 * extracted from main.ts (plan 22.2 M2): main.ts constructs {@link makeSessionSwitch} once over
 * its live scheduler/turn state and keeps dispatching from its command lane under the same local
 * names; the handoff orchestrator, worktree commands, and lifecycle commands receive these
 * functions through main.ts's wiring rather than importing them here.
 *
 * Responsible for: spawning the replacement host, retiring this one after a session.switch, the
 * /clear and /cd fresh-session flows, the shared workspace-switch blocker + mechanic, and (plan 58.2)
 * stamping `session.project` on a worktree target before the replacement host starts.
 * Not for: resolving the /cd target (workspace-switch.ts), the /worktree-* handlers
 * (worktrees/commands.ts), or the /handoff orchestration (handoff/orchestrator.ts) - main.ts
 * wires these mechanics into those as deps. Base-repo resolution stays on
 * `WorktreeManager.contextFor`; this module only consumes the injected `baseRepoFor` seam.
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
  manualCompactFiber: CompactionCommandsApi["manualCompactFiber"];
  /** Background subagents currently running across the session (main.ts's registry). */
  readonly backgroundChildren: ReadonlyMap<string, BackgroundChildInfo>;
  /** The runtime debug flag (main.ts's mutable `debugMode`), carried across a re-exec. */
  debugMode(): boolean;
  /**
   * Resolves the base-repo path for a worktree cwd (plan 58.2). Null when the cwd is not inside a
   * known worktree context. Wired from `WorktreeManager.contextFor` so base-repo resolution stays
   * centralized on the manager.
   */
  readonly baseRepoFor?: (cwd: string) => string | null;
  /**
   * Publishes an event on an ARBITRARY session (plan 58.2): used to stamp `session.project` on the
   * worktree TARGET before spawn. Do not use `emit` for this marker - `emit` writes the current
   * retiring session. Main.ts stamps the host producer id via `toPublishInput`.
   */
  readonly publishToSession?: (sessionId: string, event: TrevorEventInput) => Promise<void>;
  /**
   * Optional injectable spawn seam for tests (plan 58.2). When omitted, the real OS re-exec path
   * under {@link makeSessionSwitch} is used.
   */
  readonly spawnReplacementHost?: (opts: WorkspaceTarget) => { readonly pid: number };
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
    baseRepoFor,
    publishToSession,
  } = deps;
  const replyFor = commandReplier(emit);

  function defaultSpawnReplacementHost(opts: WorkspaceTarget): { readonly pid: number } {
    // Fail loud, not silent: if this host's own launch paths were removed out from under it (a managed
    // worktree pruned after its plan merged, a moved/deleted checkout), the re-exec below cannot boot -
    // it dies instantly with MODULE_NOT_FOUND. Detect that and throw a clear, surfaced error instead of
    // spawning a doomed child that leaves the target session hostless ("starting host…") forever. The
    // launch paths are the entry script (process.argv[1]) plus the tsx loader modules tsx installs via
    // execArgv (--require preflight / --import loader), which live in THIS host's (possibly-gone) checkout.
    const launchPaths = [
      ...(process.argv[1] ? [process.argv[1]] : []),
      ...process.execArgv.flatMap((arg) => {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
        if (value.startsWith("file://")) return [fileURLToPath(value)];
        return value.startsWith("/") ? [value] : [];
      }),
    ];
    const missing = launchPaths.find((path) => !existsSync(path));
    if (missing) {
      throw new Error(
        `this host's checkout is no longer on disk (${missing} missing) - restart it (e.g. \`trevor open ${SESSION_ID}\`) before switching`,
      );
    }
    // Capture the replacement's boot output to the target session's host log rather than discarding it
    // (mirrors the launcher's per-session log). A broken re-exec used to die under stdio:"ignore" with no
    // trace, which is exactly how a failed switch became an invisible "starting host…" hang; logging it
    // makes the failure diagnosable. Best-effort: fall back to discarding output if the log can't open.
    let out: number | "ignore" = "ignore";
    try {
      mkdirSync(join(TREVOR_STATE_HOME, "logs"), { recursive: true });
      out = openSync(join(TREVOR_STATE_HOME, "logs", `host-${opts.sessionId}.log`), "a");
    } catch {
      // keep "ignore"
    }
    // Re-exec with the SAME node invocation that started THIS process. Under the dev/start lanes the
    // host runs via tsx, which installs its TypeScript loader through process.execArgv (--require
    // preflight, --import loader) - NOT argv. Dropping execArgv respawns a bare `node src/main.ts`, which
    // dies instantly on the first extensionless `.ts` import (ERR_MODULE_NOT_FOUND). Carrying execArgv
    // through reproduces the full launch; it's empty under a compiled binary, so this is a no-op there.
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        SESSION_ID: opts.sessionId,
        TREVOR_WORKSPACE: opts.workspace,
        TREVOR_MANAGED_HOST: "1",
        // tsx resolves tsconfig `paths` from the child's cwd, and the replacement's cwd is the TARGET
        // project - which has no @host/* mapping - so without this pointer the re-exec dies on its
        // first @host import. Self-anchored so it also covers hosts whose launcher didn't set it.
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

  function spawnReplacementHost(opts: WorkspaceTarget): { readonly pid: number } {
    return (deps.spawnReplacementHost ?? defaultSpawnReplacementHost)(opts);
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

  function dropSessionLocalState(): void {
    scheduler.clearPending();
    contextRegistry.reset();
  }

  async function announceSwitchAndRetire(
    targetSessionId: string,
    reason: "clear" | "cd" | "worktree" | "handoff",
  ): Promise<void> {
    await emit(events.sessionSwitch({ sessionId: targetSessionId, reason }));
    dropSessionLocalState();
    retireAfterSessionSwitch();
  }

  async function clearToFreshSession(): Promise<void> {
    const reply = replyFor("/clear");
    const nextSessionId = freshSessionId();
    try {
      await transport.ensureSession(nextSessionId);
      const spawned = spawnReplacementHost({
        cwd: process.cwd(),
        sessionId: nextSessionId,
        workspace: WORKSPACE_ROOT,
      });
      await reply.ok(`✓ started fresh session ${nextSessionId}`);
      await announceSwitchAndRetire(nextSessionId, "clear");
      log("host", "clear: switched session", {
        from: SESSION_ID,
        to: nextSessionId,
        pid: spawned.pid,
      });
    } catch (error) {
      warn("host", "clear: failed to switch session", { error: msg(error) });
      await reply.failed(error, "start a fresh session");
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
    await replyFor(command).fail(`Cannot ${verb} while ${blocker}.`);
    return true;
  }

  async function cdToFreshSession(args: string): Promise<void> {
    const reply = replyFor("/cd");
    if (await blockedFromWorkspaceSwitch("/cd", "switch directories")) {
      return;
    }

    const target = resolveCdTarget(args, { cwd: process.cwd() });
    if (!target.ok) {
      await reply.fail(target.error);
      return;
    }

    try {
      await transport.ensureSession(target.value.sessionId);
      const spawned = spawnReplacementHost(target.value);
      await reply.ok(`✓ switched to ${target.value.cwd}`);
      await announceSwitchAndRetire(target.value.sessionId, "cd");
      log("host", "cd: switched session", {
        cwd: target.value.cwd,
        from: SESSION_ID,
        pid: spawned.pid,
        to: target.value.sessionId,
        workspace: target.value.workspace,
      });
    } catch (error) {
      warn("host", "cd: failed to switch session", { error: msg(error) });
      await reply.failed(error, "switch directories");
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
    // Plan 58.2: a worktree switch stamps the durable base-repo marker on the TARGET session
    // before the replacement host starts, so inventory groups under the base project from the
    // first events. Emit writes the retiring session, so this uses publishToSession instead.
    if (opts.reason === "worktree") {
      const baseRepo = baseRepoFor?.(opts.cwd) ?? null;
      if (!baseRepo) {
        throw new Error(
          `cannot resolve base repo for worktree switch at ${opts.cwd} - refusing to spawn a host without a durable project stamp`,
        );
      }
      if (!publishToSession) {
        throw new Error(
          "publishToSession is required for worktree switches so session.project can land on the target session",
        );
      }
      await publishToSession(opts.sessionId, events.sessionProject({ path: baseRepo }));
    }
    const spawned = spawnReplacementHost({
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      workspace: opts.workspace,
    });
    await announceSwitchAndRetire(opts.sessionId, opts.reason);
    log("host", `${opts.reason}: switched session`, {
      cwd: opts.cwd,
      from: SESSION_ID,
      pid: spawned.pid,
      to: opts.sessionId,
    });
  }

  return {
    spawnReplacementHost,
    retireAfterSessionSwitch,
    dropSessionLocalState,
    announceSwitchAndRetire,
    clearToFreshSession,
    blockedFromWorkspaceSwitch,
    cdToFreshSession,
    switchToWorkspace,
  };
}

/** The wired switch mechanics' shape - consumer deps derive member types from this (e.g.
 *  `SessionSwitchApi["switchToWorkspace"]`) instead of re-declaring the signatures. */
export type SessionSwitchApi = ReturnType<typeof makeSessionSwitch>;

import { abbrevHome } from "@host/boot/paths";
import { type CwdLockCaps, cwdSwitchConflict } from "@host/session/cwd-lock";
import type { SessionSwitchApi } from "@host/session/session-switch";
import { warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import { events } from "@trevor/session";
import type { WorktreeManager } from "./manager";

/**
 * The programmatic /worktree-* command handlers (D-091), extracted from main.ts (plan 22.2 M2):
 * sent by the web switcher rather than typed, so main.ts intercepts them in its command lane and
 * dispatches here. Each handler runs the manager operation, publishes its command.result, and
 * either switches workspaces (switch/new) or re-announces the refreshed rows (merge/delete/
 * reconcile) through the deps main.ts wires.
 *
 * Responsible for: the /worktree-switch|new|merge|delete|reconcile command handlers.
 * Not for: worktree lifecycle mechanics (manager.ts) or the shared workspace-switch gate and
 * mechanic themselves (main.ts wires those in as deps).
 */

/** The live main.ts effects the handlers run through - the manager plus the shared switch mechanics. */
export interface WorktreeCommandsDeps {
  readonly worktrees: WorktreeManager;
  readonly cwdLockCaps: CwdLockCaps;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The shared workspace-switch precondition: emits the bail result and returns true when blocked. */
  readonly blockedFromWorkspaceSwitch: SessionSwitchApi["blockedFromWorkspaceSwitch"];
  /** The shared workspace-switch mechanic (D-091): ensure session, spawn, session.switch, retire. */
  readonly switchToWorkspace: SessionSwitchApi["switchToWorkspace"];
  /** Re-announce host.online so every client's worktree rows refresh. */
  announceOnline(): void;
}

/** Builds the /worktree-* handlers over the host's live switch mechanics; main.ts wires it once. */
export function makeWorktreeCommands(deps: WorktreeCommandsDeps) {
  const {
    worktrees,
    cwdLockCaps,
    emit,
    blockedFromWorkspaceSwitch,
    switchToWorkspace,
    announceOnline,
  } = deps;

  /** Switches to a managed worktree (or the baseline checkout) by row id, gated like `/cd`. */
  async function worktreeSwitch(id: string): Promise<void> {
    if (await blockedFromWorkspaceSwitch("/worktree", "switch worktrees")) {
      return;
    }
    const target = worktrees.resolveSwitch(id, process.cwd());
    if (!target.ok) {
      await emit(events.commandResult({ command: "/worktree", text: target.error, ok: false }));
      return;
    }
    if (target.path === process.cwd()) {
      await emit(
        events.commandResult({ command: "/worktree", text: "Already on this worktree.", ok: true }),
      );
      return;
    }
    // Block the switch before spawning a host if a DIFFERENT live session already owns the target
    // directory (plan 01) - it would otherwise become a second mutating owner of the same path.
    const lockConflict = cwdSwitchConflict(target.path, target.sessionId, cwdLockCaps);
    if (lockConflict) {
      await emit(
        events.commandResult({
          command: "/worktree",
          text: `Cannot switch - ${lockConflict.message}`,
          ok: false,
        }),
      );
      return;
    }
    try {
      await emit(
        events.commandResult({
          command: "/worktree",
          text: `✓ switched to ${abbrevHome(target.path)}`,
          ok: true,
        }),
      );
      await switchToWorkspace({
        cwd: target.path,
        sessionId: target.sessionId,
        workspace: target.path,
        reason: "worktree",
      });
    } catch (error) {
      warn("host", "worktree: switch failed", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/worktree",
          text: `Failed to switch worktree: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  /** Creates a managed worktree on a new branch from HEAD, records it, and switches into it. */
  async function worktreeNew(branch: string): Promise<void> {
    if (await blockedFromWorkspaceSwitch("/worktree-new", "create a worktree")) {
      return;
    }
    const name = branch.trim();
    if (!name) {
      await emit(
        events.commandResult({
          command: "/worktree-new",
          text: "usage: /worktree-new <branch>",
          ok: false,
        }),
      );
      return;
    }
    const result = worktrees.createFromCwd({
      cwd: process.cwd(),
      branch: name,
      baseRef: "HEAD",
    });
    if (!result.ok) {
      await emit(events.commandResult({ command: "/worktree-new", text: result.error, ok: false }));
      return;
    }
    try {
      await emit(
        events.commandResult({
          command: "/worktree-new",
          text: `✓ created ${name} and switched in`,
          ok: true,
        }),
      );
      await switchToWorkspace({
        cwd: result.record.worktreePath,
        sessionId: result.record.sessionId,
        workspace: result.record.worktreePath,
        reason: "worktree",
      });
    } catch (error) {
      warn("host", "worktree: create-switch failed", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/worktree-new",
          text: `Failed to open worktree: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  /** Merges a worktree's branch back into the baseline checkout (M5), gated like a switch. */
  async function worktreeMerge(id: string): Promise<void> {
    if (await blockedFromWorkspaceSwitch("/worktree-merge", "merge")) {
      return;
    }
    const result = worktrees.mergeBack(id.trim(), process.cwd());
    await emit(
      events.commandResult({
        command: "/worktree-merge",
        text: result.ok ? "✓ merged worktree branch into baseline" : result.error,
        ok: result.ok,
      }),
    );
    if (result.ok) {
      announceOnline();
    }
  }

  /** Deletes a managed worktree (M5). `<id> [force]`; without force a dirty/unpushed tree is refused. */
  async function worktreeDelete(args: string): Promise<void> {
    const [id, ...rest] = args.trim().split(/\s+/);
    const force = rest.includes("force");
    if (!id) {
      await emit(
        events.commandResult({
          command: "/worktree-delete",
          text: "usage: /worktree-delete <id> [force]",
          ok: false,
        }),
      );
      return;
    }
    const result = worktrees.remove(id, process.cwd(), force);
    await emit(
      events.commandResult({
        command: "/worktree-delete",
        text: result.ok ? "✓ deleted worktree" : result.error,
        ok: result.ok,
      }),
    );
    if (result.ok) {
      announceOnline();
    }
  }

  /** Reconciles the registry against the filesystem, dropping worktrees whose path is gone (M5). */
  async function worktreeReconcile(): Promise<void> {
    const gone = worktrees.reconcile(process.cwd());
    await emit(
      events.commandResult({
        command: "/worktree-reconcile",
        text:
          gone.length > 0
            ? `✓ reconciled ${gone.length} stale worktree(s)`
            : "nothing to reconcile",
        ok: true,
      }),
    );
    if (gone.length > 0) {
      announceOnline();
    }
  }

  return { worktreeSwitch, worktreeNew, worktreeMerge, worktreeDelete, worktreeReconcile };
}

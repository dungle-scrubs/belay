import { TREVOR_STATE_HOME, WORKSPACE_ROOT } from "@host/boot/paths";
import { type DirectHandoffDeps, runDirectHandoff } from "@host/handoff/handoff-flow";
import type { SessionSwitchApi } from "@host/session/session-switch";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import type { WorktreeManager } from "@host/worktrees/manager";
import { events } from "@trevor/session";
import { disposeCurrentPlan, serialNext } from "./driver";
import { startSerialRun } from "./entry";
import { nodeLoadSerialRun, nodeSerialControllerCaps, nodeSerialRunStartDeps } from "./node";

/**
 * The /serial-implement, /serial-next, and /serial-dispose command handlers (plan 02), extracted
 * from main.ts (plan 22.2 M2): main.ts constructs {@link makeSerialRunCommands} once over the
 * shared workspace-switch gate + the handoff execution deps and keeps dispatching from its command
 * lane under the same local names.
 *
 * Responsible for: the serial-run command flow - starting a run (parse + record + handoff),
 * advancing to the next queued plan, and disposing the in-progress plan (merge or halt).
 * Not for: the serial-run mechanics themselves (entry.ts starts, driver.ts advances/disposes,
 * node.ts provides the caps) or the handoff execution (handoff/handoff-flow.ts - main.ts wires the
 * orchestrator's deps in).
 */

/** The live main.ts seams the serial-run commands run through. */
export interface SerialRunCommandsDeps {
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The shared workspace-switch precondition: emits the bail result and returns true when blocked. */
  readonly blockedFromWorkspaceSwitch: SessionSwitchApi["blockedFromWorkspaceSwitch"];
  /** The live /handoff execution deps (handoff/orchestrator's handoffDeps, wired through main.ts). */
  handoffDeps(): DirectHandoffDeps;
  /** The managed-worktree manager the serial controller creates/merges/deletes trees through. */
  readonly worktrees: WorktreeManager;
}

/** Builds the serial-run command handlers over the host's live seams; main.ts wires it once. */
export function makeSerialRunCommands(deps: SerialRunCommandsDeps) {
  const { emit, blockedFromWorkspaceSwitch, handoffDeps, worktrees } = deps;

  /**
   * `/serial-implement <plans>` (plan 02): parse an ordered plan queue, record a durable, re-openable
   * serial run, and hand off to a dedicated session that implements the plans strictly one managed
   * worktree at a time (merge + delete each green tree; halt on the first red/conflict). The launching
   * session is freed by the handoff; the create/implement/merge/delete lifecycle runs in the spawned run.
   */
  async function runSerialImplement(args: string): Promise<void> {
    if (await blockedFromWorkspaceSwitch("/serial-implement", "start a serial run")) {
      return;
    }
    try {
      const result = await startSerialRun(
        args,
        nodeSerialRunStartDeps({
          workspace: WORKSPACE_ROOT,
          stateHome: TREVOR_STATE_HOME,
          newRunId: () => crypto.randomUUID(),
          now: () => new Date().toISOString(),
          handoff: (prompt) =>
            runDirectHandoff(prompt, handoffDeps()).then((r) => ({
              ok: r.ok,
              ...(r.targetSessionId ? { targetSessionId: r.targetSessionId } : {}),
            })),
        }),
      );
      await emit(
        events.commandResult({ command: "/serial-implement", text: result.text, ok: result.ok }),
      );
      if (result.ok) {
        log("host", "serial run started", { runId: result.runId, to: result.targetSessionId });
      }
    } catch (error) {
      warn("host", "serial-implement failed", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/serial-implement",
          text: `Failed to start serial run: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  /** The host-driven controller caps for a serial run, rooted at the current cwd (resolves the base repo). */
  function serialControllerCaps() {
    return nodeSerialControllerCaps({
      manager: worktrees,
      cwd: process.cwd(),
      stateHome: TREVOR_STATE_HOME,
      now: () => new Date().toISOString(),
    });
  }

  /**
   * `/serial-next <runId>` (plan 02): the host-driven half of the serial loop. Create + enter the next
   * queued plan's managed worktree and advance the durable journal to `tree-created`, then tell the run's
   * agent which plan to implement. The agent implements in the tree and calls `/serial-dispose` to merge it.
   */
  async function runSerialNext(runId: string): Promise<void> {
    const id = runId.trim();
    const run = nodeLoadSerialRun(TREVOR_STATE_HOME, id);
    if (!run) {
      await emit(
        events.commandResult({
          command: "/serial-next",
          text: `unknown serial run: ${id}`,
          ok: false,
        }),
      );
      return;
    }
    const { plan } = await serialNext(run, serialControllerCaps());
    const text = !plan
      ? "serial run is complete or halted"
      : plan.phase === "merged"
        ? "all plans merged"
        : `next: implement ${plan.planId} in its worktree, then run /serial-dispose ${id}`;
    await emit(events.commandResult({ command: "/serial-next", text, ok: true }));
  }

  /**
   * `/serial-dispose <runId> [fail <reason>]` (plan 02): the host-driven disposition. After the agent
   * implemented the in-progress plan, run the single green gate (clean -> merge -> delete) on a green
   * report, or halt the run on `fail <reason>` - advancing the durable journal either way.
   */
  async function runSerialDispose(args: string): Promise<void> {
    const [id, verb, ...rest] = args.trim().split(/\s+/);
    if (!id) {
      await emit(
        events.commandResult({
          command: "/serial-dispose",
          text: "usage: /serial-dispose <runId> [fail <reason>]",
          ok: false,
        }),
      );
      return;
    }
    const run = nodeLoadSerialRun(TREVOR_STATE_HOME, id);
    if (!run) {
      await emit(
        events.commandResult({
          command: "/serial-dispose",
          text: `unknown serial run: ${id}`,
          ok: false,
        }),
      );
      return;
    }
    const outcome =
      verb === "fail"
        ? { green: false, detail: rest.join(" ") || "reported red" }
        : { green: true };
    const updated = await disposeCurrentPlan(run, serialControllerCaps(), outcome);
    const halted = updated.plans.find((p) => p.phase === "halted");
    const text =
      updated.status === "halted"
        ? `⚠ halted on ${halted?.planId}: ${halted?.haltReason} - tree left intact for inspection`
        : updated.status === "complete"
          ? "✓ all plans merged"
          : `✓ merged; run /serial-next ${id} for the next plan`;
    await emit(
      events.commandResult({ command: "/serial-dispose", text, ok: updated.status !== "halted" }),
    );
  }

  return { runSerialImplement, runSerialNext, runSerialDispose };
}

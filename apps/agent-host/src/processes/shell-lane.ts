import { events } from "@belay/session";
import { DEFAULT_PROMOTION_CONFIG } from "@host/tools/promote-policy";
import { promotedResultText, runPromotable } from "@host/tools/promote-runner";
import type { EmitEvent } from "@host/transport/services";
import { supervisor } from "./processes";

/**
 * The prompt-shell lane (D-082 + plan 09), extracted from main.ts (plan 22.3): main.ts constructs
 * {@link makeShellLane} once over its emit/announce seams and keeps dispatching from handleEvent's
 * user.shell arm under the same local name.
 *
 * Responsible for: running a `!command` through the promotable runner and publishing its one
 * shell.result (paired by requestId), then re-announcing the possibly-changed git state.
 * Not for: the promote decision/threshold (tools/promote-policy.ts + tools/promote-runner.ts), the
 * tracked-job registry (processes.ts), or gating WHO runs it (main.ts's live-leader arm).
 */

/** The live main.ts seams the shell lane publishes through. */
export interface ShellLaneDeps {
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** Re-announce host.online so the sidebar git line reflects a repo-mutating command. */
  announceOnline(): void;
}

/** Builds the prompt-shell lane over the host's live seams; main.ts wires it once. */
export function makeShellLane(deps: ShellLaneDeps) {
  const { emit, announceOnline } = deps;

  /**
   * Runs a prompt-shell-lane command (a leading `!`) through the shared protected `runCommand` path and
   * publishes one `shell.result` (paired by requestId). Like an immediate command this bypasses the
   * model and the turn queue and runs even while a turn streams - but unlike a command its output never
   * enters the model context (D-082). A refusal (safety floor) or non-zero/timeout maps to `ok: false`.
   */
  async function runShellCommand(requestId: string, command: string): Promise<void> {
    // The prompt-shell lane shares the promotable runner (plan 09): a long `!command` promotes to a tracked
    // background job rather than timing out. The shell.result output stays out of the model context (D-082);
    // a promoted result names its `pN` and is `ok` (it is running, not failed).
    const result = await runPromotable(supervisor, command, process.cwd(), {
      enabled: DEFAULT_PROMOTION_CONFIG.enabled,
      thresholdMs: DEFAULT_PROMOTION_CONFIG.thresholdMs,
      origin: { source: "shell", requestId },
    });
    const output =
      result.decision === "promote"
        ? promotedResultText(result.jobId ?? "?", result.output)
        : result.output;
    await emit(events.shellResult({ requestId, command, output, ok: result.ok }));
    // A shell command can change repository state (checkout, commit, stage); re-announce
    // so the sidebar git line reflects it without polling. Latching + idempotent.
    announceOnline();
  }

  return { runShellCommand };
}

import type { JobOrigin, ProcessRegistry } from "../process-registry";
import { classifyAlwaysPreventedBashCommand } from "./bash-safety";
import { type CommandOutcome, decidePromotion, type PromotionSource } from "./promote-policy";
import { cap } from "./shared";

/**
 * The promotable shell runner (plan 09 M3). It runs a command through the {@link ProcessRegistry} - so
 * its stdout/stderr are captured in the supervisor ring buffer FROM THE START - and races the command's
 * exit against the promotion threshold. A command that finishes first is a normal foreground result and
 * is removed (it leaves no `pN`); one still running at the threshold is PROMOTED into a tracked
 * background job, preserving everything it has already printed. The four-way decision itself is the
 * shared pure {@link decidePromotion} policy; this runner only owns spawning, the threshold race, and
 * the output capture - safety, cwd, env, output cap, and spawn-error handling all come from the same
 * registry/bash code the foreground path uses.
 */

export interface PromotableOptions {
  readonly source: PromotionSource;
  /** Whether background-job promotion is enabled; off means a long command times out (fail) as before. */
  readonly enabled: boolean;
  /** Threshold in ms past which a still-running command is promoted instead of timed out. */
  readonly thresholdMs: number;
  /** Where this command came from, stamped onto the promoted job's metadata. */
  readonly origin: JobOrigin;
}

export interface PromotableResult {
  readonly decision: "refuse" | "complete" | "fail" | "promote";
  /** The captured output (foreground result, or everything printed before promotion), capped. */
  readonly output: string;
  readonly ok: boolean;
  /** The tracked job id, present only when the command was promoted. */
  readonly jobId?: string;
  readonly reason: string;
}

export async function runPromotable(
  registry: ProcessRegistry,
  command: string,
  cwd: string,
  opts: PromotableOptions,
): Promise<PromotableResult> {
  // Safety floor up front - a refused command never spawns (same classifier as bash/process).
  const blocked = classifyAlwaysPreventedBashCommand(command, { workspaceRoot: cwd });
  if (blocked) {
    return { decision: "refuse", output: `refused: ${blocked}`, ok: false, reason: blocked };
  }

  const { id } = registry.start(command, cwd, { origin: opts.origin, cwd });
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    registry.awaitExit(id),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, opts.thresholdMs);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }

  const poll = registry.poll(id, 0, 0);
  const output = cap(
    [poll.stdout, poll.stderr]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n") || "(no output)",
  );
  const outcome: CommandOutcome = timedOut
    ? "running-at-threshold"
    : poll.exitCode === 0
      ? "completed"
      : "failed";
  const { decision, reason } = decidePromotion({
    command,
    cwd,
    source: opts.source,
    enabled: opts.enabled,
    thresholdMs: opts.thresholdMs,
    outcome,
  });

  if (decision === "promote") {
    registry.markPromoted(id);
    return { decision, output, ok: true, jobId: id, reason };
  }
  // complete / fail: it was a foreground command, not a background job - drop it (kills if still running).
  registry.remove(id);
  return { decision, output, ok: decision === "complete", reason };
}

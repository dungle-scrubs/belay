import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Shared child-process hygiene for host-owned runtimes. It owns the boring but security-critical
 * invariants every child spawner needs: stdio pipe errors never crash the host, and a graceful reap
 * escalates from the requested signal to SIGKILL after the grace window. Protocol-specific modules
 * still own their frame parsing, error taxonomy, stderr redaction, and environment policy.
 *
 * Responsible for: no-shell child spawning, pipe guards, and graceful reap escalation.
 * Not for: child-specific environment policy, protocol parsing, or stderr/result redaction.
 */

export interface HardenedChildOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStdinError?: () => void;
  readonly stdio?: "pipe";
}

export type HardenedChild = ChildProcess & {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
};

export function spawnHardenedChild(options: HardenedChildOptions): HardenedChild {
  const child = spawn(options.command, [...(options.args ?? [])], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: options.stdio ?? "pipe",
  }) as HardenedChild;
  guardChildPipes(child, options.onStdinError);
  return child;
}

export function guardChildPipes(child: ChildProcess, onStdinError?: () => void): void {
  child.stdin?.on("error", () => onStdinError?.());
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}

export async function reap(
  child: ChildProcess,
  options: { readonly graceMs: number; readonly signal?: NodeJS.Signals } = { graceMs: 2_000 },
): Promise<boolean> {
  if (await waitForChildExit(child, 0)) {
    return true;
  }
  child.kill(options.signal ?? "SIGTERM");
  if (await waitForChildExit(child, options.graceMs)) {
    return true;
  }
  child.kill("SIGKILL");
  return waitForChildExit(child, options.graceMs);
}

export function reapAfterGrace(child: ChildProcess, graceMs: number): void {
  void waitForChildExit(child, graceMs).then((exited) => {
    if (!exited) {
      child.kill("SIGKILL");
    }
  });
}

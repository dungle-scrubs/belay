import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ManagedChild } from "./host-manager";
import { createLineReader, decodeRunnerToHost, encodeMessage, type RunnerToHost } from "./protocol";

/**
 * Spawns the `tool_script` child runner and adapts it to the {@link ManagedChild} the host manager drives
 * (plan 16, M3). Mirrors `search-process.ts`: an ARGV spawn (no shell), a minimal env, and stdio pipes.
 * The runtime command is INJECTABLE - so M4 can prefix it with `sandbox-exec -p <profile>` and tests can
 * pin the runtime - while this module owns only the process<->protocol wiring: stdout is line-split +
 * decoded, stdout/stderr are byte-capped (a spam-happy child never floods the host), and exit/kill are
 * surfaced to the manager.
 */

const MAX_LINE_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 64 * 1024;

export interface RunnerSpawnConfig {
  /** The full command+args that run the entry (e.g. `["node","--import","tsx", entry]`), so M4 can wrap it
   *  in an OS-sandbox launcher and tests can pin the runtime. */
  readonly command: readonly string[];
  readonly cwd: string;
  /** A minimal, explicit environment (deny-first: no inherited secrets). Defaults to an empty PATH-only env. */
  readonly env?: Record<string, string>;
}

/** The absolute path to the child-runner entry module. */
export function runnerEntryPath(): string {
  return fileURLToPath(new URL("./runner-entry.ts", import.meta.url));
}

/** The default runtime command: this Node with the tsx loader running the TS entry. */
export function defaultRunnerCommand(): string[] {
  return [process.execPath, "--import", "tsx", runnerEntryPath()];
}

/** Spawns the runner and returns a {@link ManagedChild}. */
export function spawnRunner(config: RunnerSpawnConfig): ManagedChild {
  const [cmd, ...args] = config.command;
  if (!cmd) {
    throw new Error("spawnRunner: empty command");
  }
  const child: ChildProcess = spawn(cmd, args, {
    cwd: config.cwd,
    // Deny-first env: only what is explicitly provided (plus a PATH so the runtime resolves).
    env: config.env ?? { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const reader = createLineReader({ maxLineBytes: MAX_LINE_BYTES });
  let onMessageCb: ((message: RunnerToHost) => void) | null = null;
  let onExitCb: (() => void) | null = null;
  let stderrBytes = 0;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of reader.push(chunk)) {
      const message = decodeRunnerToHost(line);
      if (message && onMessageCb) {
        onMessageCb(message);
      }
    }
  });
  // Drain stderr but cap it - a child that spews to stderr cannot balloon host memory.
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) {
      child.stderr?.destroy();
    }
  });
  child.on("exit", () => onExitCb?.());
  child.on("error", () => onExitCb?.());

  return {
    send(message) {
      child.stdin?.write(encodeMessage(message));
    },
    onMessage(cb) {
      onMessageCb = cb;
    },
    onExit(cb) {
      onExitCb = cb;
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

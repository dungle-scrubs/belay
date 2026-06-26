import { type ChildProcess, spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import { invariant } from "./log";
import { msg } from "./messages";
import { classifyAlwaysPreventedBashCommand } from "./tools/bash-safety";
import { ProcessError, ToolExecutionError, ToolInputError } from "./tools/errors";
import { cap } from "./tools/shared";
import type { Tool } from "./tools/types";

/**
 * Background process supervisor (the V2 port of the old host's ProcessSupervisor,
 * plan H-023/H-035). Long-lived commands - dev servers, watchers - run here
 * instead of through the always-blocking bash tool.
 *
 * Each process is a real child of the host (spawned with a pipe, NOT detached), so
 * starting one is non-blocking and it dies with the host rather than orphaning. The
 * model drives it through the `process` tool (start -> poll -> kill); output is
 * poll-only, kept in a bounded ring buffer with a logical cursor so the model can
 * tail incrementally and never sees a gap even after the buffer trims.
 */

const RING_LIMIT = 64 * 1024;

type ProcessStatus = "running" | "exited" | "killed";

/**
 * A bounded output buffer with a logical cursor. `total` counts every char ever
 * appended; `start` is the logical offset of the retained window's first char, so a
 * cursor older than the window resumes at the oldest retained char (no gap error).
 */
class Ring {
  private buffer = "";
  private start = 0;
  total = 0;

  append(text: string): void {
    this.buffer += text;
    this.total += text.length;
    if (this.buffer.length > RING_LIMIT) {
      const dropped = this.buffer.length - RING_LIMIT;
      this.buffer = this.buffer.slice(dropped);
      this.start += dropped;
    }
    // The window is the most recent RING_LIMIT chars of a `total`-long stream: its first
    // retained char can't precede the stream and the buffer can't exceed the cap. If
    // either breaks the cursor math below would silently hand out wrong slices.
    invariant(
      this.start >= 0 && this.start <= this.total && this.buffer.length <= RING_LIMIT,
      `Ring corrupt: start=${this.start} total=${this.total} len=${this.buffer.length}`,
    );
  }

  /** Returns output from `cursor` onward and the new cursor (the logical end). */
  read(cursor: number): { text: string; cursor: number } {
    const from = Math.max(cursor, this.start);
    return { text: this.buffer.slice(from - this.start), cursor: this.total };
  }
}

interface ManagedProcess {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
  readonly child: ChildProcess;
  readonly stdout: Ring;
  readonly stderr: Ring;
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** A snapshot of one job for /jobs and the process tool's list action. */
export interface JobInfo {
  readonly id: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly ageMs: number;
}

const ProcessParams = Schema.Struct({
  action: Schema.Literal("start", "poll", "kill", "list"),
  command: Schema.optional(Schema.String).annotations({
    description: "Shell command to start (action=start)",
  }),
  id: Schema.optional(Schema.String).annotations({
    description: "Process id (action=poll or kill)",
  }),
  stdoutCursor: Schema.optionalWith(Schema.Number, { default: () => 0 }).annotations({
    description: "Last stdout cursor from poll",
  }),
  stderrCursor: Schema.optionalWith(Schema.Number, { default: () => 0 }).annotations({
    description: "Last stderr cursor from poll",
  }),
});

export class ProcessSupervisor {
  private readonly processes = new Map<string, ManagedProcess>();
  private seq = 0;

  /**
   * Spawns a command as a tracked background child (safety floor applies). Throws a
   * typed ToolError - ToolInputError for a safety-floor refusal, ToolExecutionError for a
   * spawn failure - which the process tool catches into the Effect `E` channel.
   */
  start(command: string, cwd: string): { id: string; status: ProcessStatus } {
    const blocked = classifyAlwaysPreventedBashCommand(command, { workspaceRoot: process.cwd() });
    if (blocked) {
      throw new ToolInputError({ tool: "process", detail: `refused: ${blocked}` });
    }
    this.seq += 1;
    const id = `p${this.seq}`;
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        env: process.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new ToolExecutionError({ tool: "process", detail: msg(error), cause: error });
    }
    const proc: ManagedProcess = {
      id,
      command,
      startedAt: Date.now(),
      child,
      stdout: new Ring(),
      stderr: new Ring(),
      status: "running",
      exitCode: null,
      signal: null,
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => proc.stdout.append(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => proc.stderr.append(chunk));
    child.on("exit", (code, signal) => {
      if (proc.status === "running") {
        proc.status = "exited";
      }
      proc.exitCode = code;
      proc.signal = signal;
    });
    child.on("error", (error) => {
      proc.stderr.append(`\n[spawn error] ${error.message}\n`);
      if (proc.status === "running") {
        proc.status = "exited";
      }
    });
    this.processes.set(id, proc);
    return { id, status: "running" };
  }

  /** Reads new output for a process since the given cursors. Throws ProcessError if no
   *  such id; the process tool catches it into the `E` channel. */
  poll(
    id: string,
    stdoutCursor: number,
    stderrCursor: number,
  ): {
    id: string;
    status: ProcessStatus;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cursor: { stdout: number; stderr: number };
  } {
    const proc = this.processes.get(id);
    if (!proc) {
      throw new ProcessError({ detail: `no such process "${id}"` });
    }
    const out = proc.stdout.read(stdoutCursor);
    const err = proc.stderr.read(stderrCursor);
    return {
      id,
      status: proc.status,
      exitCode: proc.exitCode,
      stdout: out.text,
      stderr: err.text,
      cursor: { stdout: out.cursor, stderr: err.cursor },
    };
  }

  /** Sends SIGTERM to a running process and marks it killed. Throws ProcessError if no
   *  such id (caught into the `E` channel by the process tool, or by /jobs-stop's edge). */
  kill(id: string): { id: string; status: ProcessStatus } {
    const proc = this.processes.get(id);
    if (!proc) {
      throw new ProcessError({ detail: `no such process "${id}"` });
    }
    if (proc.status === "running") {
      proc.status = "killed";
      try {
        proc.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    return { id, status: proc.status };
  }

  /** A snapshot of every tracked process, newest last. */
  list(): JobInfo[] {
    const now = Date.now();
    return [...this.processes.values()].map((proc) => ({
      id: proc.id,
      command: proc.command,
      status: proc.status,
      exitCode: proc.exitCode,
      ageMs: now - proc.startedAt,
    }));
  }

  /** Best-effort SIGTERM to all still-running processes (host shutdown). */
  killAll(): void {
    for (const proc of this.processes.values()) {
      if (proc.status === "running") {
        proc.status = "killed";
        try {
          proc.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  }

  /**
   * The model-facing tool: start/poll/kill/list over THIS supervisor. The supervisor owns
   * its own tool definition so the class is self-describing (D-035); the registry just calls
   * `supervisor.buildTool()`. It is intentionally not `readOnly` - starting/killing a process
   * mutates host state, so the loop runs it as a serial barrier.
   */
  buildTool(): Tool<typeof ProcessParams.Type> {
    return {
      name: "process",
      description:
        "Run and manage long-lived background processes (dev servers, watchers, builds). The bash tool blocks until a command finishes; use this for anything meant to keep running. Actions: start {command} -> begins it, returns an id; poll {id, stdoutCursor?, stderrCursor?} -> new output since the cursor plus an updated cursor; kill {id} -> SIGTERM; list -> all jobs.",
      params: ProcessParams,
      execute: (args) =>
        // The supervisor methods throw a typed ToolError on bad input / not-found; Effect.try
        // catches those into the `E` channel, where the executor renders them to one
        // `error: …` line. The empty-command case is also a typed ToolInputError.
        Effect.try({
          try: () => {
            switch (args.action) {
              case "start": {
                const command = (args.command ?? "").trim();
                if (!command) {
                  throw new ToolInputError({
                    tool: "process",
                    detail: "command required for start",
                  });
                }
                return JSON.stringify(this.start(command, process.cwd()));
              }
              case "poll":
                return cap(
                  JSON.stringify(this.poll(args.id ?? "", args.stdoutCursor, args.stderrCursor)),
                );
              case "kill":
                return JSON.stringify(this.kill(args.id ?? ""));
              case "list":
                return JSON.stringify(this.list());
            }
          },
          catch: (error) => error as ProcessError | ToolInputError | ToolExecutionError,
        }),
    };
  }
}

/** Host-wide supervisor: one registry shared by the process tool and /jobs. */
export const supervisor = new ProcessSupervisor();

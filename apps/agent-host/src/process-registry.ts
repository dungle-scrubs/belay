import { type ChildProcess, spawn } from "node:child_process";
import { invariant } from "./log";
import { msg } from "./messages";
import { classifyAlwaysPreventedBashCommand } from "./tools/bash-safety";
import { ProcessError, ToolExecutionError, ToolInputError } from "./tools/errors";

const RING_LIMIT = 64 * 1024;

export type ProcessStatus = "running" | "exited" | "killed";

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
    invariant(
      this.start >= 0 && this.start <= this.total && this.buffer.length <= RING_LIMIT,
      `Ring corrupt: start=${this.start} total=${this.total} len=${this.buffer.length}`,
    );
  }

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

export interface JobInfo {
  readonly id: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly ageMs: number;
}

export class ProcessRegistry {
  private readonly processes = new Map<string, ManagedProcess>();
  private seq = 0;

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
}

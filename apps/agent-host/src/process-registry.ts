import { type ChildProcess, spawn } from "node:child_process";
import { invariant } from "./log";
import { msg } from "./messages";
import { classifyAlwaysPreventedBashCommand } from "./tools/bash-safety";
import { ProcessError, ToolExecutionError, ToolInputError } from "./tools/errors";

const RING_LIMIT = 64 * 1024;

export type ProcessStatus = "running" | "exited" | "killed";

/** How a tracked job came to exist: a direct `process` tool start, or a promoted bash / prompt-shell
 *  command that crossed the promotion threshold (plan 09). */
export type JobSource = "process" | "bash" | "shell";

/** Where a job originated, so the support panel + detail can trace it back to its run/tool/request. */
export interface JobOrigin {
  readonly source: JobSource;
  /** The run that owned the originating bash/shell call (absent for a direct `process` start). */
  readonly runId?: string;
  /** The bash tool call id, when promoted from a `bash` call. */
  readonly callId?: string;
  /** The prompt-shell request id, when promoted from the `!` shell lane. */
  readonly requestId?: string;
}

/** The metadata a caller attaches when registering a job (origin + cwd + promotion timestamp). */
export interface JobMeta {
  readonly origin: JobOrigin;
  readonly cwd: string;
  /** When a foreground command was promoted into this job; absent for a directly-started process. */
  readonly promotedAt?: number;
}

/**
 * The structured, session-visible snapshot of one background job (plan 09 M2): the UI read model, richer
 * than the capped, model-facing {@link JobInfo}. It carries the original command, source + originating
 * ids, cwd, start/promote timestamps, lifecycle status/exit, and the output cursors (total chars), so the
 * support panel + detail takeover render without re-deriving from model-facing output.
 */
export interface JobSnapshot {
  readonly id: string;
  readonly command: string;
  readonly source: JobSource;
  readonly runId?: string;
  readonly callId?: string;
  readonly requestId?: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly promotedAt?: number;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  /** Total chars ever written to each stream (the poll cursor ceiling), for truncation indicators. */
  readonly stdoutTotal: number;
  readonly stderrTotal: number;
}

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
  readonly origin: JobOrigin;
  readonly cwd: string;
  promotedAt: number | undefined;
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

  start(command: string, cwd: string, meta?: JobMeta): { id: string; status: ProcessStatus } {
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
      // A direct `process` start has no run/tool origin; a promoted job passes its origin + promotedAt.
      origin: meta?.origin ?? { source: "process" },
      cwd: meta?.cwd ?? cwd,
      promotedAt: meta?.promotedAt,
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

  /** Marks a tracked job as promoted now (a foreground command that crossed the threshold, plan 09 M3).
   *  No-op if the id is unknown or it was already promoted. */
  markPromoted(id: string, at: number = Date.now()): void {
    const proc = this.processes.get(id);
    if (proc && proc.promotedAt === undefined) {
      proc.promotedAt = at;
    }
  }

  /** The structured, session-visible {@link JobSnapshot} read model for every job (plan 09 M2) - richer
   *  than the model-facing {@link JobInfo} list, for the support panel + detail takeover. */
  snapshots(): JobSnapshot[] {
    return [...this.processes.values()].map((proc) => ({
      id: proc.id,
      command: proc.command,
      source: proc.origin.source,
      ...(proc.origin.runId !== undefined ? { runId: proc.origin.runId } : {}),
      ...(proc.origin.callId !== undefined ? { callId: proc.origin.callId } : {}),
      ...(proc.origin.requestId !== undefined ? { requestId: proc.origin.requestId } : {}),
      cwd: proc.cwd,
      startedAt: proc.startedAt,
      ...(proc.promotedAt !== undefined ? { promotedAt: proc.promotedAt } : {}),
      status: proc.status,
      exitCode: proc.exitCode,
      stdoutTotal: proc.stdout.total,
      stderrTotal: proc.stderr.total,
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

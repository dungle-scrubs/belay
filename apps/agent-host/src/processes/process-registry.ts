/**
 * Responsible for: the background job registry and its per-job output rings and snapshots.
 * Not for: the `process` tool wrapper (processes.ts) or pid liveness (process-liveness.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { classifyAlwaysPreventedBashCommand } from "@host/tools/bash-safety";
import { ProcessError, ToolExecutionError, ToolInputError } from "@host/tools/errors";
import { combineStreams } from "@host/tools/shared";
import { invariant } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { JobLifecycle, JobSource } from "@trevor/session";

const RING_LIMIT = 64 * 1024;
/** How much combined output tail a job snapshot carries for the detail takeover (host.online is announced
 *  often, so this is bounded well below the full ring). */
const JOB_TAIL_LIMIT = 4 * 1024;

// The lifecycle + source unions are the wire contract (@trevor/session), reused here so the host's
// snapshot can never drift from what it announces.
export type { JobSource } from "@trevor/session";
export type ProcessStatus = JobLifecycle;

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
  /** A bounded tail of the combined output (last few KB), for the detail takeover. */
  readonly tail: string;
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

  /** The last `limit` retained chars - slices the tail directly, never copying the whole ring. */
  tail(limit: number): string {
    return this.buffer.length > limit ? this.buffer.slice(-limit) : this.buffer;
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
  /** Resolves once the child has exited or errored - the promotable runner races this against the
   *  promotion threshold (plan 09 M3). */
  readonly whenDone: Promise<void>;
}

export interface JobInfo {
  readonly id: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly ageMs: number;
}

export interface ClearCompletedResult {
  readonly dismissed: number;
}

export interface DismissResult {
  readonly id: string;
  readonly status: "dismissed";
}

export class ProcessRegistry {
  static readonly SUCCESS_AUTO_PRUNE_MS = 30_000;

  private readonly processes = new Map<string, ManagedProcess>();
  private readonly pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  /** Called after a *visible* job changes (a `process` start or a promoted command: start / exit / kill /
   *  promote / remove), so the host re-announces its job snapshots and the support panel updates live
   *  (plan 09 M7). A foreground bash/shell command that never promotes is invisible, so its
   *  start+exit+remove churn fires nothing - no announce storm for ordinary commands. */
  onChange: (() => void) | undefined;

  private changed(proc: ManagedProcess): void {
    if (isVisible(proc)) {
      this.onChange?.();
    }
  }

  private changedVisible(): void {
    this.onChange?.();
  }

  private dropProcess(proc: ManagedProcess): boolean {
    this.clearAutoPrune(proc.id);
    this.processes.delete(proc.id);
    return isVisible(proc);
  }

  private clearAutoPrune(id: string): void {
    const timer = this.pruneTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pruneTimers.delete(id);
    }
  }

  private scheduleAutoPrune(proc: ManagedProcess): void {
    this.clearAutoPrune(proc.id);
    if (!isSuccessfulExit(proc)) {
      return;
    }
    const timer = setTimeout(() => {
      this.pruneTimers.delete(proc.id);
      const current = this.processes.get(proc.id);
      if (!current || !isSuccessfulExit(current)) {
        return;
      }
      if (this.dropProcess(current)) {
        this.changedVisible();
      }
    }, ProcessRegistry.SUCCESS_AUTO_PRUNE_MS);
    timer.unref?.();
    this.pruneTimers.set(proc.id, timer);
  }

  start(command: string, cwd: string, origin?: JobOrigin): { id: string; status: ProcessStatus } {
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
    let markDone: () => void = () => undefined;
    const proc: ManagedProcess = {
      id,
      command,
      startedAt: Date.now(),
      // A direct `process` start has no run/tool origin; a promoted command passes its bash/shell origin.
      origin: origin ?? { source: "process" },
      cwd,
      promotedAt: undefined,
      child,
      stdout: new Ring(),
      stderr: new Ring(),
      status: "running",
      exitCode: null,
      signal: null,
      whenDone: new Promise<void>((resolve) => {
        markDone = resolve;
      }),
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
      markDone();
      if (this.processes.get(proc.id) !== proc) {
        return;
      }
      this.scheduleAutoPrune(proc);
      this.changed(proc);
    });
    child.on("error", (error) => {
      proc.stderr.append(`\n[spawn error] ${error.message}\n`);
      if (proc.status === "running") {
        proc.status = "exited";
      }
      markDone();
      if (this.processes.get(proc.id) !== proc) {
        return;
      }
      this.changed(proc);
    });
    this.processes.set(id, proc);
    this.changed(proc);
    return { id, status: "running" };
  }

  /** Resolves when a tracked job has exited or errored (or immediately if it is already done / unknown),
   *  so the promotable runner can race it against the promotion threshold. */
  async awaitExit(id: string): Promise<void> {
    const proc = this.processes.get(id);
    if (proc) {
      await proc.whenDone;
    }
  }

  /** Drops a job from tracking, killing it if still running. Used when a foreground command finished
   *  before the promotion threshold - it was never a background job, so it leaves no `pN` behind. */
  remove(id: string): void {
    const proc = this.processes.get(id);
    if (proc?.status === "running") {
      try {
        proc.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    this.clearAutoPrune(id);
    this.processes.delete(id);
    if (proc) {
      this.changed(proc);
    }
  }

  dismiss(id: string): DismissResult {
    const proc = this.processes.get(id);
    if (!proc) {
      throw new ProcessError({ detail: `no such process "${id}"` });
    }
    if (!isTerminal(proc)) {
      throw new ProcessError({ detail: `cannot dismiss running process "${id}"; stop it first` });
    }
    if (this.dropProcess(proc)) {
      this.changedVisible();
    }
    return { id, status: "dismissed" };
  }

  clearCompleted(): ClearCompletedResult {
    let dismissed = 0;
    let changed = false;
    for (const proc of this.processes.values()) {
      if (isTerminal(proc)) {
        dismissed += 1;
        const visible = this.dropProcess(proc);
        changed ||= visible;
      }
    }
    if (changed) {
      this.changedVisible();
    }
    return { dismissed };
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
      this.clearAutoPrune(id);
      try {
        proc.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      this.changed(proc);
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
      this.changed(proc);
    }
  }

  /** The structured, session-visible {@link JobSnapshot} read model (plan 09 M2) - richer than the
   *  model-facing {@link JobInfo} list, for the support panel + detail takeover. Only *visible* jobs
   *  appear: direct `process` starts and promoted commands. A foreground bash/shell command in its
   *  pre-promotion race window is omitted, so ordinary commands never flash a `pN` row. */
  snapshots(): JobSnapshot[] {
    return [...this.processes.values()].filter(isVisible).map((proc) => ({
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
      tail: jobTail(proc),
    }));
  }

  killAll(): void {
    for (const proc of this.processes.values()) {
      this.clearAutoPrune(proc.id);
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

/** A job is session-visible once it is a direct `process` start or has been promoted - the panel and the
 *  re-announce hook both key off this, so a foreground command that never promotes stays hidden. */
function isVisible(proc: ManagedProcess): boolean {
  return proc.origin.source === "process" || proc.promotedAt !== undefined;
}

function isTerminal(proc: ManagedProcess): boolean {
  return proc.status !== "running";
}

function isSuccessfulExit(proc: ManagedProcess): boolean {
  return proc.status === "exited" && proc.exitCode === 0;
}

/** The bounded combined-output tail a snapshot carries: stdout then stderr, capped to the last few KB. */
function jobTail(proc: ManagedProcess): string {
  return combineStreams(proc.stdout.tail(JOB_TAIL_LIMIT), proc.stderr.tail(JOB_TAIL_LIMIT)).slice(
    -JOB_TAIL_LIMIT,
  );
}

import { terminationReason } from "@host/session/session-lifecycle";
import {
  type DecodedEvent,
  events,
  type TrevorEventInput,
  type Usage,
  type UsageBreakdown,
} from "@trevor/session";

type CompletedEvent = Extract<ReturnType<typeof events.assistantCompleted>, { type: string }>;
type DecodedCompleted = Extract<DecodedEvent, { type: "assistant.completed" }>;

export type CloseRunKind = "cancelled" | "interrupted";

export class TurnMachine {
  private readonly completedRuns = new Set<string>();
  private readonly inFlightRuns = new Set<string>();
  private readonly lastUsageByRun = new Map<
    string,
    { usage?: Usage; breakdown?: UsageBreakdown }
  >();
  private readonly overflowedRuns = new Set<string>();
  private lastTerminationValue: string | null = null;

  get lastTermination(): string | null {
    return this.lastTerminationValue;
  }

  get hasInFlight(): boolean {
    return this.inFlightRuns.size > 0;
  }

  inFlightIds(): string[] {
    return [...this.inFlightRuns];
  }

  markCompleted(runId: string): boolean {
    if (this.completedRuns.has(runId)) {
      return false;
    }
    this.completedRuns.add(runId);
    return true;
  }

  start(runId: string): void {
    this.inFlightRuns.add(runId);
  }

  progress(runId: string, usage?: Usage, breakdown?: UsageBreakdown): void {
    if (usage) {
      this.lastUsageByRun.set(runId, { usage, breakdown });
    }
  }

  complete(decoded: DecodedCompleted): string | null {
    this.inFlightRuns.delete(decoded.runId);
    this.lastUsageByRun.delete(decoded.runId);
    this.lastTerminationValue = terminationReason(decoded, this.overflowedRuns.has(decoded.runId));
    this.overflowedRuns.delete(decoded.runId);
    return this.lastTerminationValue;
  }

  overflow(runId: string): void {
    this.overflowedRuns.add(runId);
  }

  /**
   * The terminal `assistant.completed` for a run closed WITHOUT a completion of its own, reading and
   * dropping its last-known usage so the consumed tokens ride out and the per-run record is freed.
   * `cancelled` (ESC) and `interrupted` (host reap) differ only in the flag the UI renders.
   */
  private terminalCompletion(runId: string, kind: CloseRunKind): TrevorEventInput {
    const last = this.lastUsageByRun.get(runId);
    this.lastUsageByRun.delete(runId);
    return events.assistantCompleted({
      runId,
      text: "",
      ...(kind === "cancelled" ? { cancelled: true } : { interrupted: true }),
      ...(last?.usage ? { usage: last.usage } : {}),
      ...(last?.breakdown ? { breakdown: last.breakdown } : {}),
    }) satisfies CompletedEvent;
  }

  close(runId: string, kind: CloseRunKind): TrevorEventInput | null {
    if (!this.markCompleted(runId)) {
      return null;
    }
    return this.terminalCompletion(runId, kind);
  }

  /**
   * Reconcile after a (re)connect: close every in-flight run EXCEPT `activeRunId` (a turn this host is
   * genuinely still running), returning their terminal `interrupted` completions to emit. This is the
   * durable safety net for a completion lost while the store was unreachable - the run sits
   * started-with-no-completion in the log, so the host re-emits it once the stream is back and the UI
   * stops reading it as forever-"Working". It is driven by the IN-FLIGHT set (the log truth), not the
   * emit-dedup set, so a `markCompleted` that ran before a failed emit cannot suppress the re-emit.
   */
  reapExcept(activeRunId: string | null): TrevorEventInput[] {
    const out: TrevorEventInput[] = [];
    for (const runId of [...this.inFlightRuns]) {
      if (runId === activeRunId) {
        continue;
      }
      this.inFlightRuns.delete(runId);
      this.completedRuns.add(runId);
      out.push(this.terminalCompletion(runId, "interrupted"));
    }
    return out;
  }
}

import {
  type DecodedEvent,
  events,
  type TrevorEventInput,
  type Usage,
  type UsageBreakdown,
} from "@trevor/session";
import { terminationReason } from "../session-lifecycle";

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

  close(runId: string, kind: CloseRunKind): TrevorEventInput | null {
    if (!this.markCompleted(runId)) {
      return null;
    }
    const last = this.lastUsageByRun.get(runId);
    return events.assistantCompleted({
      runId,
      text: "",
      ...(kind === "cancelled" ? { cancelled: true } : { interrupted: true }),
      ...(last?.usage ? { usage: last.usage } : {}),
      ...(last?.breakdown ? { breakdown: last.breakdown } : {}),
    }) satisfies CompletedEvent;
  }

  reap(): string[] {
    const runIds = this.inFlightIds();
    this.inFlightRuns.clear();
    return runIds;
  }
}

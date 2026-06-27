import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TurnStop } from "@trevor/session";
import { TREVOR_STATE_HOME } from "../paths";

export interface TurnStopMetric {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly stop: TurnStop;
  readonly at: string;
}

export function turnStopMetricsPath(): string {
  return join(TREVOR_STATE_HOME, "turn-stops.jsonl");
}

export async function recordTurnStopMetric(metric: TurnStopMetric): Promise<void> {
  try {
    const path = turnStopMetricsPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(metric)}\n`, "utf8");
  } catch {
    // Debug metrics must never affect a user's turn.
  }
}

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TurnStop } from "@trevor/session";
import { log } from "../log";
import { TREVOR_STATE_HOME } from "../paths";

export interface TurnStopRecord {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly stop: TurnStop;
  readonly at: string;
}

export function turnStopMetricsPath(): string {
  return join(TREVOR_STATE_HOME, "turn-stops.jsonl");
}

/** Appends one turn-stop record to the durable jsonl metric file (best-effort). */
async function appendTurnStopMetric(record: TurnStopRecord): Promise<void> {
  try {
    const path = turnStopMetricsPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Debug metrics must never affect a user's turn.
  }
}

/**
 * The single sink for "a turn stopped": appends the durable jsonl metric AND emits the structured
 * boundary log, unpacking `stop.context` once. Both observations move together here, so the caller's
 * stop branch is one call instead of re-projecting the same stop into a metric and a log line.
 */
export async function recordTurnStop(record: TurnStopRecord): Promise<void> {
  const { runId, provider, model, stop } = record;
  log("turn", "stop", {
    runId,
    provider,
    model,
    cause: stop.cause,
    action: stop.action,
    steps: stop.steps,
    inputTokens: stop.context?.inputTokens,
    contextWindow: stop.context?.contextWindow,
    pressure: stop.context?.pressure,
  });
  await appendTurnStopMetric(record);
}

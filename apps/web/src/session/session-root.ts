import type { SessionSummary } from "@belay/session";

/**
 * Resolves a session's project path (plan 58 M3): the durable `projectPath` marker wins, then
 * `workspace`, then `cwd`, then null for ungrouped sessions.
 */
export function sessionProjectPath(summary: SessionSummary): string | null {
  return summary.projectPath ?? summary.workspace ?? summary.cwd ?? null;
}

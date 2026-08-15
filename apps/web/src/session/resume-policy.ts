import type { SessionSummary } from "@belay/session";
import { sessionProjectPath } from "./session-root";

export type CalendarDayStatus = "today" | "older";

export type ResumeAction =
  | { readonly kind: "hidden"; readonly reason: "live" }
  | { readonly kind: "auto-start"; readonly root: string; readonly sessionId: string }
  | {
      readonly kind: "manual";
      readonly root: string;
      readonly sessionId: string;
      readonly updatedAt: string;
    }
  | { readonly kind: "unlaunchable"; readonly sessionId: string; readonly updatedAt: string };

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function calendarDayStatus(updatedAt: string, nowMs: number): CalendarDayStatus {
  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.getTime())) {
    return "older";
  }
  return localDayKey(updated) === localDayKey(new Date(nowMs)) ? "today" : "older";
}

export function launchRootForSession(summary: SessionSummary): string | null {
  const root = sessionProjectPath(summary);
  return root && root.trim().length > 0 ? root : null;
}

export function resumeActionForSession(summary: SessionSummary, nowMs: number): ResumeAction {
  if (summary.host === "live") {
    return { kind: "hidden", reason: "live" };
  }

  const root = launchRootForSession(summary);
  if (root === null) {
    return {
      kind: "unlaunchable",
      sessionId: summary.sessionId,
      updatedAt: summary.updatedAt,
    };
  }

  if (calendarDayStatus(summary.updatedAt, nowMs) === "today") {
    return { kind: "auto-start", root, sessionId: summary.sessionId };
  }

  return {
    kind: "manual",
    root,
    sessionId: summary.sessionId,
    updatedAt: summary.updatedAt,
  };
}

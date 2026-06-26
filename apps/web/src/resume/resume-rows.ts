import { relativeTime, type SessionSummary } from "@trevor/session";
import type { CommandRow, RowTone } from "@/components/command-modal";

/** The current project / session context the resume rows are projected against. */
export interface ResumeContext {
  /** The session the browser is currently viewing (its own row is non-resumable). */
  readonly currentSessionId: string | null;
  /** The current working directory's base-repo name; the chooser is scoped to it. */
  readonly currentProject: string | null;
  /** Whether the current session has a turn in flight (switching is blocked while busy). */
  readonly busy: boolean;
  /** Wall clock for relative-time labels. */
  readonly nowMs: number;
}

/** The right-aligned status text + tone for one session, from host presence + activity. */
function statusFor(s: SessionSummary): { status: string; tone: RowTone } {
  if (s.activity === "running") {
    return { status: "running", tone: "active" };
  }
  if (s.host === "live") {
    return { status: "host ready", tone: "success" };
  }
  if (s.host === "stale") {
    return { status: "stale host", tone: "danger" };
  }
  return { status: "no host", tone: "muted" };
}

/**
 * Projects the session inventory into command-modal rows for the resume chooser (D-090),
 * scoped to the CURRENT working directory: only sessions whose base repo matches
 * `currentProject` are shown (when it's known), ordered by most-recent activity - sessions for
 * other projects are not offered. The viewing session's own row and - while the current session
 * is busy - every other row are disabled with a reason, enforcing the switch-blocked safety
 * rule. Pure: the modal layers search/keyboard/selection on top, and the source summaries are
 * untouched.
 */
export function buildResumeRows(
  sessions: readonly SessionSummary[],
  ctx: ResumeContext,
): CommandRow[] {
  // Scope to the current working directory's project; with no known project (e.g. the default
  // shared session) we can't identify a cwd to scope to, so fall back to the full list.
  const scoped =
    ctx.currentProject != null
      ? sessions.filter((s) => s.project === ctx.currentProject)
      : sessions;
  const sorted = [...scoped].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return sorted.map((s) => {
    const { status, tone } = statusFor(s);
    const location = s.cwd ?? s.workspace ?? "(no repo)";
    const metadata = [
      location,
      s.branch ?? undefined,
      `${s.eventCount} events`,
      relativeTime(s.updatedAt, ctx.nowMs),
    ]
      .filter(Boolean)
      .join(" · ");

    const isCurrent = s.sessionId === ctx.currentSessionId;
    const disabledReason = isCurrent
      ? "current session"
      : ctx.busy
        ? "finish the current run first"
        : undefined;

    return {
      id: s.sessionId,
      label: s.title,
      metadata,
      status,
      statusTone: tone,
      current: isCurrent,
      disabledReason,
      keywords: [s.branch ?? "", s.host, s.sessionId].filter(Boolean),
    };
  });
}

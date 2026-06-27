import { relativeTime, type SessionActivity, type SessionSummary } from "@trevor/session";
import { GitBranch, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The session navigation sidebar (D-093): the everyday left-hand surface for switching among the
 * CURRENT project's sessions. It reuses the D-090 inventory read model - no second data path - and
 * excludes archived sessions (D-094). `/resume` stays the keyboard/search entry point over the same
 * inventory; this is the always-visible visual list. Built Storybook-first: presentational over the
 * injected summaries + selection, with the live navigation wired later.
 *
 * Row heights, icon slots, and labels are fixed so live status changes (a turn starting, a session
 * settling) never resize the sidebar.
 */

/**
 * The sessions shown in the sidebar: the current project's NON-archived sessions, newest activity
 * first. Pure, so the scope + recency rules are unit-tested. A null project (e.g. the default shared
 * session, no resolvable cwd) shows all non-archived sessions rather than nothing.
 */
export function visibleSessions(
  sessions: readonly SessionSummary[],
  project: string | null,
): SessionSummary[] {
  const active = sessions.filter((s) => !s.archived);
  const scoped = project != null ? active.filter((s) => s.project === project) : active;
  return [...scoped].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface SessionSidebarProps {
  readonly sessions: readonly SessionSummary[];
  readonly currentSessionId: string;
  readonly currentProject: string | null;
  readonly onSelect: (sessionId: string) => void;
  /**
   * Live run state per session (D-093 M3), layered over each row's durable activity: the owner of the
   * live send-queue (the browser for the viewed session, the host for others) supplies `queued` /
   * `running` here so a row reflects work-in-flight or work-waiting that the durable log can't yet
   * show. A row not present here falls back to its durable `summary.activity`. This is what keeps a
   * session's activity visible while the user is viewing a DIFFERENT session.
   */
  readonly liveActivity?: ReadonlyMap<string, SessionActivity>;
  readonly nowMs?: number;
  readonly className?: string;
}

/** The activity a row renders: the live override (queued/running from the send-queue owner) when
 *  present, else the durable activity projected from the log. Pure, so the precedence is unit-tested. */
export function effectiveActivity(
  summary: SessionSummary,
  liveActivity?: ReadonlyMap<string, SessionActivity>,
): SessionActivity {
  return liveActivity?.get(summary.sessionId) ?? summary.activity;
}

/** A fixed-size activity dot: green pulse running, amber pulse queued, a muted dot when settled, a
 *  faint dot when never-run / no live host. The size never changes, so live transitions don't reflow. */
function ActivityDot({
  activity,
  host,
}: {
  activity: SessionActivity;
  host: SessionSummary["host"];
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        activity === "running"
          ? "animate-pulse bg-smui-green"
          : activity === "queued"
            ? "animate-pulse bg-amber-400"
            : activity === "settled" || host === "live"
              ? "bg-muted-foreground/60"
              : "bg-muted-foreground/25",
      )}
    />
  );
}

/** The right-aligned label: a live status word for running/queued, else the settled relative time. */
function activityLabel(activity: SessionActivity, updatedAt: string, nowMs: number): string {
  if (activity === "running") {
    return "running";
  }
  if (activity === "queued") {
    return "queued";
  }
  return relativeTime(updatedAt, nowMs);
}

function SessionRow({
  summary,
  activity,
  selected,
  onSelect,
  nowMs,
}: {
  summary: SessionSummary;
  activity: SessionActivity;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  nowMs: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(summary.sessionId)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
        selected
          ? "bg-card text-foreground"
          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      <ActivityDot activity={activity} host={summary.host} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm leading-tight">{summary.title}</span>
        {summary.branch ? (
          <span className="inline-flex items-center gap-1 truncate text-label tracking-wider text-muted-foreground/70">
            <GitBranch className="size-2.5 shrink-0" />
            <span className="truncate">{summary.branch}</span>
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-label tracking-wider text-muted-foreground/60">
        {activityLabel(activity, summary.updatedAt, nowMs)}
      </span>
    </button>
  );
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  currentProject,
  onSelect,
  liveActivity,
  nowMs = Date.now(),
  className,
}: SessionSidebarProps) {
  const rows = visibleSessions(sessions, currentProject);

  return (
    <nav
      aria-label="sessions"
      className={cn("flex flex-col border-r border-border bg-smui-surface-sunken", className)}
    >
      <header className="flex items-center gap-1.5 px-2.5 py-2 text-label tracking-wider text-muted-foreground">
        <LayoutDashboard className="size-3.5 shrink-0" />
        <span>Sessions</span>
        <span className="ml-auto text-muted-foreground/50">{rows.length}</span>
      </header>

      {rows.length === 0 ? (
        <p className="px-2.5 py-3 text-label tracking-wider text-muted-foreground/60">
          No sessions{currentProject ? ` for ${currentProject}` : ""} yet.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {rows.map((summary) => (
            <li key={summary.sessionId}>
              <SessionRow
                summary={summary}
                activity={effectiveActivity(summary, liveActivity)}
                selected={summary.sessionId === currentSessionId}
                onSelect={onSelect}
                nowMs={nowMs}
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

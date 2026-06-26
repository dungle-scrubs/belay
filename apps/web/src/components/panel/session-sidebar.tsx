import { relativeTime, type SessionSummary } from "@trevor/session";
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
  readonly nowMs?: number;
  readonly className?: string;
}

/** A small activity dot: green pulse while a turn runs, a muted dot when settled. */
function ActivityDot({ summary }: { summary: SessionSummary }) {
  const running = summary.activity === "running";
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        running
          ? "animate-pulse bg-smui-green"
          : summary.host === "live"
            ? "bg-muted-foreground/60"
            : "bg-muted-foreground/25",
      )}
    />
  );
}

function SessionRow({
  summary,
  selected,
  onSelect,
  nowMs,
}: {
  summary: SessionSummary;
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
      <ActivityDot summary={summary} />
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
        {summary.activity === "running" ? "running" : relativeTime(summary.updatedAt, nowMs)}
      </span>
    </button>
  );
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  currentProject,
  onSelect,
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

import { relativeTime, type SessionActivity, type SessionSummary } from "@trevor/session";
import { ChevronDown, ChevronRight, Inbox, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProjectLabel } from "./project-label";
import { type ProjectGroup, SESSION_CAP } from "./project-sidebar-model";

/**
 * The project sidebar (plan 58 M5): the project-first left-hand navigation surface. Renders the
 * grouped read model ({@link ProjectGroup}[]) - project rows that expand/collapse, session rows
 * nested under expanded projects, "Show more" past {@link SESSION_CAP}, and an archive-only empty
 * state. Built Storybook-first: presentational over the injected groups + callbacks, with NO live
 * wiring (that's M6). The live owner passes the already-grouped, already-filtered model in.
 *
 * Row heights and icon slots are fixed so activity transitions never resize the sidebar.
 */

export interface ProjectSidebarProps {
  /** The grouped read model (registry records joined with active sessions). */
  readonly groups: readonly ProjectGroup[];
  /** Toggle a project's collapsed state (persisted by the live owner). */
  readonly onToggleProject: (key: string) => void;
  /** Select (navigate to) a session. */
  readonly onSelectSession: (sessionId: string) => void;
  /** Reveal more sessions under a project (past {@link SESSION_CAP}). */
  readonly onShowMore: (key: string) => void;
  /** The active search query (echoed into the search field; drives filtering the owner does). */
  readonly searchQuery: string;
  /** When provided, renders a search input the live owner wires to set the query. */
  readonly onSearchChange?: (query: string) => void;
  /**
   * View an archive-only project's archived sessions (plan 58 M7). When provided, the empty state of a
   * project with only archived sessions renders an "archive" link that opens the archive browser
   * filtered to that project's path. Absent => the empty state is non-interactive.
   */
  readonly onViewArchive?: (projectKey: string) => void;
  /** Live run state per session, layered over each row's durable activity (D-093 M3). */
  readonly liveActivity?: ReadonlyMap<string, SessionActivity>;
  /** The currently selected session id (for highlight). */
  readonly currentSessionId?: string;
  readonly nowMs?: number;
  readonly className?: string;
}

export type { ProjectGroup, ProjectSidebarRecord } from "./project-sidebar-model";
/**
 * Builds the project sidebar read model from registry records + session summaries. A thin re-export of
 * {@link buildProjectSidebar} so the live owner imports grouping + presentation from one module path.
 * Presentational components never call this; the live owner does, then passes the result in.
 */
export { buildProjectSidebar } from "./project-sidebar-model";

/** The activity a row renders: the live override when present, else the durable activity. Pure. */
function effectiveActivity(
  summary: SessionSummary,
  liveActivity?: ReadonlyMap<string, SessionActivity>,
): SessionActivity {
  return liveActivity?.get(summary.sessionId) ?? summary.activity;
}

/** A session row: title, branch, and an activity indicator (running dots, queued, or relative time). */
function SessionRow({
  summary,
  activity,
  selected,
  nowMs,
  onSelect,
}: {
  summary: SessionSummary;
  activity: SessionActivity;
  selected: boolean;
  nowMs: number;
  onSelect: (sessionId: string) => void;
}) {
  const active = activity === "running" || activity === "queued";
  return (
    <button
      type="button"
      onClick={() => onSelect(summary.sessionId)}
      className={cn(
        "group relative flex w-full items-center gap-2 py-1.5 pl-7 pr-2.5 text-left text-ui",
        selected
          ? "bg-card text-foreground"
          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      {/* Activity bar pinned to the row's left edge (D-093): green when work is in flight. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1.5 left-5 w-0.5 rounded-full",
          active
            ? "bg-smui-green"
            : activity === "settled" || summary.host === "live"
              ? "bg-muted-foreground/50"
              : "bg-muted-foreground/20",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{summary.title}</span>
      <span className="shrink-0 text-label tracking-wider text-muted-foreground/60">
        {activity === "running" ? (
          <span className="inline-flex items-center gap-[3px]" role="status" aria-label="running">
            {[0, 200, 400].map((delay) => (
              <span
                key={delay}
                className="size-1 animate-pulse rounded-full bg-current"
                style={{ animationDelay: `${delay}ms`, animationDuration: "1s" }}
              />
            ))}
          </span>
        ) : activity === "queued" ? (
          "queued"
        ) : (
          relativeTime(summary.updatedAt, nowMs)
        )}
      </span>
    </button>
  );
}

/** A project row: expand/collapse chevron, name (with disambiguating path), session count, active dot. */
function ProjectRow({ group, onToggle }: { group: ProjectGroup; onToggle: (key: string) => void }) {
  const hasActive = group.sessions.some((s) => s.activity === "running" || s.activity === "queued");
  return (
    <button
      type="button"
      onClick={() => onToggle(group.key)}
      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-card/40"
      aria-expanded={!group.collapsed}
    >
      {group.collapsed ? (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          hasActive ? "bg-smui-green" : "bg-muted-foreground/30",
        )}
      />
      <ProjectLabel
        displayName={group.displayName}
        displayPath={group.displayPath}
        className="flex-1 text-ui text-foreground"
        pathClassName="text-muted-foreground/50"
      />
      <span className="shrink-0 text-label tracking-wider text-muted-foreground/60">
        {group.activeCount > 0 ? group.activeCount : ""}
      </span>
    </button>
  );
}

/** The empty state for a project with only archived sessions: an archive link affordance (plan 58 M7).
 *  When {@link onViewArchive} is provided, the state is a clickable link that opens the archive browser
 *  filtered to this project's path; otherwise it is a static label. */
function EmptyProjectState({
  projectKey,
  onViewArchive,
}: {
  projectKey: string;
  onViewArchive?: (projectKey: string) => void;
}) {
  if (onViewArchive) {
    return (
      <button
        type="button"
        onClick={() => onViewArchive(projectKey)}
        className="flex w-full items-center gap-1.5 py-1.5 pl-7 pr-2.5 text-left text-label tracking-wider text-muted-foreground/50 hover:text-foreground"
      >
        <Inbox className="size-3" />
        <span>View archive</span>
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 py-1.5 pl-7 pr-2.5 text-label tracking-wider text-muted-foreground/50">
      <Inbox className="size-3" />
      <span>No active sessions</span>
    </div>
  );
}

export function ProjectSidebar({
  groups,
  onToggleProject,
  onSelectSession,
  onShowMore,
  searchQuery,
  onSearchChange,
  onViewArchive,
  liveActivity,
  currentSessionId,
  nowMs = Date.now(),
  className,
}: ProjectSidebarProps) {
  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* Header: the "Projects" title + optional search. */}
      <header className="flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-label tracking-wider text-muted-foreground">
        <span className="flex-1">Projects</span>
      </header>

      {onSearchChange ? (
        <div className="shrink-0 px-2.5 pb-1.5">
          <div className="flex items-center gap-1.5 rounded bg-card/40 px-2 py-1">
            <Search className="size-3 text-muted-foreground/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search projects and sessions"
              className="w-full bg-transparent text-ui text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      {/* Scrollable project + session list. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-2.5 py-3 text-label tracking-wider text-muted-foreground/60">
            {searchQuery ? "No matches." : "No projects yet."}
          </p>
        ) : (
          <div className="pb-2">
            {groups.map((group) => {
              const visible = group.collapsed ? [] : group.sessions.slice(0, SESSION_CAP);
              const hidden = group.collapsed ? 0 : Math.max(0, group.sessions.length - SESSION_CAP);
              return (
                <div key={group.key}>
                  <ProjectRow group={group} onToggle={onToggleProject} />
                  {!group.collapsed ? (
                    <div>
                      {group.sessions.length === 0 ? (
                        <EmptyProjectState projectKey={group.key} onViewArchive={onViewArchive} />
                      ) : (
                        visible.map((summary) => (
                          <SessionRow
                            key={summary.sessionId}
                            summary={summary}
                            activity={effectiveActivity(summary, liveActivity)}
                            selected={summary.sessionId === currentSessionId}
                            nowMs={nowMs}
                            onSelect={onSelectSession}
                          />
                        ))
                      )}
                      {hidden > 0 ? (
                        <button
                          type="button"
                          onClick={() => onShowMore(group.key)}
                          className="w-full py-1 pl-7 pr-2.5 text-left text-label tracking-wider text-muted-foreground/60 hover:text-foreground"
                        >
                          Show {hidden} more
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

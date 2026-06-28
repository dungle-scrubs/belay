import { relativeTime, type SessionActivity, type SessionSummary } from "@trevor/session";
import { GitBranch, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { DrawerToggle, SideDrawer } from "./side-drawer";

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
  /** Durably rename a session (editable session titles). When omitted, rows show no edit affordance. */
  readonly onRename?: (sessionId: string, title: string) => void;
  /**
   * Live run state per session (D-093 M3), layered over each row's durable activity: the owner of the
   * live send-queue (the browser for the viewed session, the host for others) supplies `queued` /
   * `running` here so a row reflects work-in-flight or work-waiting that the durable log can't yet
   * show. A row not present here falls back to its durable `summary.activity`. This is what keeps a
   * session's activity visible while the user is viewing a DIFFERENT session.
   */
  readonly liveActivity?: ReadonlyMap<string, SessionActivity>;
  /** When provided, the header's dashboard icon becomes a collapse button (the open↔closed toggle the
   *  app owns). Omitted in Storybook/standalone use, where the sidebar is always visible. */
  readonly onToggle?: () => void;
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

/**
 * A thin vertical activity bar pinned to the row's left edge - green when there is active work
 * (running or queued), gray when the session has settled or has a live host, and faint when it has
 * never run / has no host. Replaces the old dot to save horizontal space; the fixed width means live
 * transitions never reflow the row.
 */
function ActivityBar({
  activity,
  host,
}: {
  activity: SessionActivity;
  host: SessionSummary["host"];
}) {
  const active = activity === "running" || activity === "queued";
  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-y-1.5 left-1 w-0.5 rounded-full",
        active
          ? "bg-smui-green"
          : activity === "settled" || host === "live"
            ? "bg-muted-foreground/50"
            : "bg-muted-foreground/20",
      )}
    />
  );
}

/**
 * An animated three-dot "…" that draws the eye with movement (D-093): the running label is motion,
 * not the static word "running". A staggered opacity wave reads as live work in progress; it inherits
 * the row's text color via `bg-current`, and carries `aria-label="running"` so it still announces.
 */
function RunningDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" role="status" aria-label="running">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          className="size-1 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${delay}ms`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}

/** The right-aligned label content: the animated running dots, a "queued" word, or the relative time. */
function ActivityLabel({
  activity,
  updatedAt,
  nowMs,
}: {
  activity: SessionActivity;
  updatedAt: string;
  nowMs: number;
}) {
  if (activity === "running") {
    return <RunningDots />;
  }
  if (activity === "queued") {
    return <>queued</>;
  }
  return <>{relativeTime(updatedAt, nowMs)}</>;
}

/** The fixed-height second line (branch + activity/time), shared by the view + edit states so the row
 *  never changes height when you start editing. */
function RowMeta({
  summary,
  activity,
  nowMs,
}: {
  summary: SessionSummary;
  activity: SessionActivity;
  nowMs: number;
}) {
  return (
    <span className="flex items-center justify-between gap-2 text-label tracking-wider text-muted-foreground/60">
      <span className="inline-flex min-w-0 items-center gap-1">
        {summary.branch ? (
          <>
            <GitBranch className="size-2.5 shrink-0" />
            <span className="truncate">{summary.branch}</span>
          </>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center">
        <ActivityLabel activity={activity} updatedAt={summary.updatedAt} nowMs={nowMs} />
      </span>
    </span>
  );
}

function SessionRow({
  summary,
  activity,
  selected,
  onSelect,
  onRename,
  nowMs,
}: {
  summary: SessionSummary;
  activity: SessionActivity;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string) => void;
  nowMs: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Optimistic title: show the just-typed name immediately, then drop it once the durable rename
  // round-trips into summary.title (so live updates from elsewhere still win after reconciliation).
  const [optimistic, setOptimistic] = useState<string | null>(null);
  useEffect(() => {
    if (optimistic !== null && summary.title === optimistic) {
      setOptimistic(null);
    }
  }, [summary.title, optimistic]);
  const title = optimistic ?? summary.title;

  // Focus the inline input when an edit opens (without `autoFocus`, which lint forbids, and without
  // re-focusing on every keystroke).
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = () => {
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    // An empty/whitespace title is rejected (the inventory falls back to the derived title anyway);
    // a no-op rename is skipped so it does not publish a redundant event.
    if (next && next !== summary.title) {
      setOptimistic(next);
      onRename?.(summary.sessionId, next);
    }
  };

  return (
    <div
      className={cn(
        "group relative flex w-full items-stretch",
        selected
          ? "bg-card text-foreground"
          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      <ActivityBar activity={activity} host={summary.host} />
      {editing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-2.5 pl-3">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            onBlur={() => setEditing(false)}
            aria-label="Session title"
            className="w-full rounded border border-input bg-background px-1 text-sm leading-tight outline-none"
          />
          <RowMeta summary={summary} activity={activity} nowMs={nowMs} />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onSelect(summary.sessionId)}
            aria-current={selected ? "true" : undefined}
            // Always selectable - switching is allowed even while a session is running (the turn keeps
            // running on the host; the row's activity bar shows it). Never blocked or disabled.
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 py-1.5 pr-2.5 pl-3 text-left"
          >
            {/* Top row: the title, truncating before it can widen the row. */}
            <span className="truncate text-sm leading-tight">{title}</span>
            <RowMeta summary={summary} activity={activity} nowMs={nowMs} />
          </button>
          {onRename ? (
            <button
              type="button"
              onClick={beginEdit}
              aria-label={`Rename ${title}`}
              className="absolute top-1 right-1 cursor-pointer rounded p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Pencil className="size-3" />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  currentProject,
  onSelect,
  onRename,
  liveActivity,
  onToggle,
  nowMs = Date.now(),
  className,
}: SessionSidebarProps) {
  const rows = visibleSessions(sessions, currentProject);

  return (
    <SideDrawer
      side="left"
      ariaLabel="sessions"
      widthClass=""
      toneClass="bg-card/40"
      className={className}
    >
      {/* Header is the same height as the main top bar so the collapse toggle lines up vertically with
        the top-bar toggles. The collapse glyph is the SAME PanelLeft icon used to open the drawer, on
        the inner (right) edge. Only the live app passes onToggle; Storybook stays a static header. */}
      <header className="flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-label tracking-wider text-muted-foreground">
        <span className="mr-auto">Sessions</span>
        {onToggle ? (
          <DrawerToggle side="left" onClick={onToggle} label="Collapse sessions sidebar" />
        ) : null}
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
                onRename={onRename}
                nowMs={nowMs}
              />
            </li>
          ))}
        </ul>
      )}
    </SideDrawer>
  );
}

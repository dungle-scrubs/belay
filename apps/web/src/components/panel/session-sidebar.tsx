import { relativeTime, type SessionActivity, type SessionSummary } from "@trevor/session";
import { Archive, GitBranch, Pencil, Trash2 } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const active = sessions.filter((s) => !s.archived && !s.deleted);
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
  /** Archive a session (right-click → Archive): hides it from the sidebar/resume. */
  readonly onArchive?: (sessionId: string) => void;
  /** Soft-delete a session (right-click → Delete, confirmed): hides it from every view. */
  readonly onDelete?: (sessionId: string) => void;
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
  editing,
  onEndEdit,
  onSelect,
  onRename,
  onContextMenu,
  nowMs,
}: {
  summary: SessionSummary;
  activity: SessionActivity;
  selected: boolean;
  /** Edit state is owned by the sidebar so the right-click Rename can open the inline input. */
  editing: boolean;
  onEndEdit: () => void;
  onSelect: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string) => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  nowMs: number;
}) {
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

  // Seed the draft + focus only on the false->true edit transition (a live title update mid-edit must
  // not overwrite what the user is typing), without `autoFocus` (lint forbids) or per-keystroke focus.
  const inputRef = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing && !wasEditing.current) {
      setDraft(summary.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    wasEditing.current = editing;
  }, [editing, summary.title]);

  const commit = () => {
    onEndEdit();
    const next = draft.trim();
    // An empty/whitespace title is rejected (the inventory falls back to the derived title anyway);
    // a no-op rename is skipped so it does not publish a redundant event.
    if (next && next !== summary.title) {
      setOptimistic(next);
      onRename?.(summary.sessionId, next);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row's controls are its button children; onContextMenu is a progressive right-click enhancement over the wrapper.
    <div
      onContextMenu={onContextMenu}
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
                onEndEdit();
              }
            }}
            onBlur={onEndEdit}
            aria-label="Session title"
            className="w-full rounded border border-input bg-background px-1 text-sm leading-tight outline-none"
          />
          <RowMeta summary={summary} activity={activity} nowMs={nowMs} />
        </div>
      ) : (
        // Rename is reached only via the right-click menu (no hover pencil) - the whole row is the
        // select target.
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
      )}
    </div>
  );
}

/** One entry in the row's right-click menu. `icon` is a lucide component (same shape as Pencil). */
interface RowMenuItem {
  readonly label: string;
  readonly icon: typeof Pencil;
  readonly onSelect: () => void;
  readonly danger?: boolean;
}

/**
 * A right-click context menu for a session row (D-094): Rename, Archive, Delete. Styled with the
 * shadcn popover tokens but with NO extra radix dependency - a portal'd menu positioned at the
 * cursor over a transparent full-screen layer that dismisses it on an outside click/right-click;
 * Escape dismisses it too.
 */
function RowContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: readonly RowMenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <button
      type="button"
      aria-label="Close menu"
      className="fixed inset-0 z-50 cursor-default"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the window level above. */}
      <div
        role="menu"
        style={{ position: "absolute", top: y, left: x }}
        className="min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                item.onSelect();
                onClose();
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                item.danger
                  ? "text-destructive hover:bg-destructive/10"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </div>
    </button>,
    document.body,
  );
}

/**
 * A strong-confirmation dialog for the destructive Delete. Delete is a SOFT delete (the session is
 * hidden from every view; its durable log is retained), so the copy is explicit that nothing is
 * purged. Portal'd over a dimmed backdrop; the backdrop and Escape both cancel.
 */
function ConfirmDelete({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <button
      type="button"
      aria-label="Cancel"
      className="fixed inset-0 z-50 flex cursor-default items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the window level above. */}
      <div
        role="alertdialog"
        aria-label="Delete session"
        className="w-80 rounded-lg border border-border bg-card p-4 text-left shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-medium text-sm">Delete session?</h3>
        <p className="mt-1 text-muted-foreground text-xs">
          "{title}" will be hidden from every view. Its durable history is retained (no hard purge).
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs hover:bg-card/70"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-destructive-foreground text-xs hover:bg-destructive/90"
          >
            Delete
          </button>
        </div>
      </div>
    </button>,
    document.body,
  );
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  currentProject,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  liveActivity,
  onToggle,
  nowMs = Date.now(),
  className,
}: SessionSidebarProps) {
  const rows = visibleSessions(sessions, currentProject);

  // Edit, right-click menu, and delete-confirm state all live here (not in the row) so the menu's
  // Rename can open the row's inline edit, and one menu/dialog shows at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    sessionId: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [confirm, setConfirm] = useState<{ sessionId: string; title: string } | null>(null);

  // Rows show the right-click menu only when the app wires at least one action (Storybook stays
  // presentational with no handlers).
  const hasMenu = Boolean(onRename || onArchive || onDelete);

  const menuItems: RowMenuItem[] = menu
    ? [
        ...(onRename
          ? [{ label: "Rename", icon: Pencil, onSelect: () => setEditingId(menu.sessionId) }]
          : []),
        ...(onArchive
          ? [{ label: "Archive", icon: Archive, onSelect: () => onArchive(menu.sessionId) }]
          : []),
        ...(onDelete
          ? [
              {
                label: "Delete",
                icon: Trash2,
                danger: true,
                onSelect: () => setConfirm({ sessionId: menu.sessionId, title: menu.title }),
              },
            ]
          : []),
      ]
    : [];

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
                editing={editingId === summary.sessionId}
                onEndEdit={() => setEditingId((id) => (id === summary.sessionId ? null : id))}
                onSelect={onSelect}
                onRename={onRename}
                onContextMenu={
                  hasMenu
                    ? (e) => {
                        e.preventDefault();
                        setMenu({
                          sessionId: summary.sessionId,
                          title: summary.title,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }
                    : undefined
                }
                nowMs={nowMs}
              />
            </li>
          ))}
        </ul>
      )}
      {menu ? (
        <RowContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
      {confirm ? (
        <ConfirmDelete
          title={confirm.title}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            onDelete?.(confirm.sessionId);
            setConfirm(null);
          }}
        />
      ) : null}
    </SideDrawer>
  );
}

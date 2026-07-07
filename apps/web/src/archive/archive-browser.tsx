import { relativeTime } from "@trevor/session";
import { AlertTriangle, ArchiveRestore, Loader2, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BackToChat } from "@/components/panel/back-to-chat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProjectLabel } from "@/sidebar/project-label";
import { type ArchivedSessionRow, isArchiveRowDeletable } from "./archive-rows";

/**
 * The archive browser (plan 04): a transcript-takeover surface for managing archived sessions, modeled
 * on the full model chooser (D-065) - it replaces the transcript + composer while the sidebars stay
 * visible, with a top-left back arrow to return to chat. It is unmistakably a management surface, not a
 * conversation: an explicit archived-area title, per-row metadata, and a destructive permanent-delete
 * that demands a typed confirmation (distinct from the soft-delete `session.deleted` marker the sidebar
 * uses).
 *
 * Presentational over injected `ArchivedSessionRow[]` + callbacks (like `ModelChooser` over its read
 * models): which row's delete is being confirmed is local UI state, but the rows and the
 * unarchive/delete actions come from props, so App owns the live inventory query and the
 * publish/transport mutations. Async per-row feedback rides `actionState`, keyed by sessionId, so
 * acting on one row never blanks the rest - and a surface-level load error never blanks rows in hand.
 */

/** The phrase a user must type to arm a permanent delete (strong confirmation). */
export const DELETE_CONFIRM_PHRASE = "delete";

/** Row-scoped async feedback for an in-flight action, owned by the App wiring. */
export type RowActionState =
  | { readonly kind: "unarchiving" }
  | { readonly kind: "deleting" }
  | { readonly kind: "error"; readonly message: string };

export interface ArchiveBrowserProps {
  readonly rows: readonly ArchivedSessionRow[];
  /** The archive inventory is still loading (no rows known yet). */
  readonly loading?: boolean;
  /** The archive inventory failed to load (surface-level, distinct from a per-row action error). */
  readonly error?: string | null;
  /** Wall clock for the relative-time recency labels (injected for deterministic stories/tests). */
  readonly nowMs?: number;
  readonly onUnarchive: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
  /** Returns to chat; renders the top-left back arrow when provided. */
  readonly onBack?: () => void;
  /**
   * When set, the browser filters its rows to archived sessions whose {@link ArchivedSessionRow.projectPath}
   * matches, and renders a project-filter banner with a clear affordance (plan 58 M7). Driven by the
   * sidebar's "view archive" entry on an archive-only project. Null = show all archived sessions.
   */
  readonly projectFilter?: string | null;
  /** Clears the {@link projectFilter} (renders the banner's close button when a filter is active). */
  readonly onClearProjectFilter?: () => void;
  /** Per-row async feedback keyed by sessionId, so one row's action never blanks the browser. */
  readonly actionState?: Readonly<Record<string, RowActionState>>;
  /** Seeds the row whose delete confirmation is initially open (stories/tests; mirrors a chooser default). */
  readonly defaultConfirmingId?: string;
  readonly className?: string;
}

/** Whether a typed confirmation value arms the delete (the stable phrase, trimmed + case-insensitive). */
export function isDeleteConfirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_CONFIRM_PHRASE;
}

export function ArchiveBrowser({
  rows,
  loading = false,
  error = null,
  nowMs = Date.now(),
  onUnarchive,
  onDelete,
  onBack,
  actionState,
  defaultConfirmingId,
  projectFilter = null,
  onClearProjectFilter,
  className,
}: ArchiveBrowserProps) {
  // Which row's permanent-delete is being confirmed (at most one). The typed phrase lives in the
  // confirmation panel itself, reset naturally when it mounts for a different row.
  const [confirmingId, setConfirmingId] = useState<string | null>(defaultConfirmingId ?? null);

  // Project-path filtering (plan 58 M7): when a projectFilter is set, keep only the archived sessions
  // whose projectPath matches it. A null projectFilter shows all archived sessions (the default).
  const filteredRows =
    projectFilter != null ? rows.filter((r) => r.projectPath === projectFilter) : rows;
  const hasRows = filteredRows.length > 0;

  return (
    <section
      aria-label="Archived sessions"
      className={cn("@container flex min-h-0 flex-col bg-background text-foreground", className)}
    >
      {onBack ? <BackToChat onBack={onBack} /> : null}

      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="text-base font-medium">Archived sessions</h2>
        <p className="text-xs text-muted-foreground">
          Sessions you've archived, hidden from the sidebar and resume views. Unarchive one to
          return it to normal navigation, or permanently delete it and its entire log - this cannot
          be undone.
        </p>
      </header>

      {projectFilter != null ? (
        <ProjectFilterBanner
          displayName={
            filteredRows[0]?.project ??
            projectFilter.split("/").filter(Boolean).pop() ??
            projectFilter
          }
          displayPath={projectFilter}
          onClear={onClearProjectFilter}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* A load error/spinner banners ABOVE the list when rows are in hand (so a transient refetch
          never blanks them), and stands alone only when there's nothing else to show. */}
        {error ? (
          <StatusLine
            icon={AlertTriangle}
            tone="destructive"
            className={hasRows ? "mb-2" : undefined}
          >
            {error}
          </StatusLine>
        ) : loading && !hasRows ? (
          <StatusLine icon={Loader2} tone="muted" spin>
            Loading archived sessions…
          </StatusLine>
        ) : null}

        {hasRows ? (
          <ul className="flex flex-col gap-2">
            {filteredRows.map((row) => (
              <ArchiveRow
                key={row.sessionId}
                row={row}
                nowMs={nowMs}
                confirming={confirmingId === row.sessionId}
                action={actionState?.[row.sessionId]}
                onUnarchive={() => onUnarchive(row.sessionId)}
                onOpenConfirm={() => setConfirmingId(row.sessionId)}
                onCancelConfirm={() => setConfirmingId(null)}
                onConfirmDelete={() => {
                  onDelete(row.sessionId);
                  setConfirmingId(null);
                }}
              />
            ))}
          </ul>
        ) : !error && !loading ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">No archived sessions</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Archive a session from its sidebar menu and it will appear here for management.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** A small icon + text status line (loading / error / per-row feedback), so the surface and the rows
 *  render those one-liners the same way. */
function StatusLine({
  icon: Icon,
  tone,
  spin = false,
  className,
  children,
}: {
  icon: typeof AlertTriangle;
  tone: "muted" | "destructive";
  spin?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-xs",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", spin && "animate-spin")} />
      {children}
    </p>
  );
}

/** The project-filter banner (plan 58 M7): shows which project the archive is scoped to, with a clear
 *  affordance so the user can return to the full archive list. Uses the shared {@link ProjectLabel}. */
function ProjectFilterBanner({
  displayName,
  displayPath,
  onClear,
}: {
  displayName: string;
  displayPath: string;
  onClear?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
      <span className="text-xs text-muted-foreground">Archive for</span>
      <ProjectLabel
        displayName={displayName}
        displayPath={displayPath}
        className="flex-1 text-xs"
      />
      {onClear ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClear}
          aria-label="Clear project filter"
          title="Show all archived sessions"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

/** One archived-session row: metadata, an unarchive action, and a gated permanent-delete. */
function ArchiveRow({
  row,
  nowMs,
  confirming,
  action,
  onUnarchive,
  onOpenConfirm,
  onCancelConfirm,
  onConfirmDelete,
}: {
  row: ArchivedSessionRow;
  nowMs: number;
  confirming: boolean;
  action: RowActionState | undefined;
  onUnarchive: () => void;
  onOpenConfirm: () => void;
  onCancelConfirm: () => void;
  onConfirmDelete: () => void;
}) {
  const deletable = isArchiveRowDeletable(row);
  const busy = action?.kind === "unarchiving" || action?.kind === "deleting";
  const metadata = [
    row.project,
    row.cwd,
    `${row.eventCount} events`,
    relativeTime(row.updatedAt, nowMs),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="rounded-md border border-border bg-card">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{row.title}</span>
          <span className="truncate text-xs text-muted-foreground">{metadata}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onUnarchive}
          disabled={busy}
          className="shrink-0"
        >
          <ArchiveRestore />
          Unarchive
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenConfirm}
          disabled={!deletable || busy || confirming}
          aria-label="Permanently delete"
          title={deletable ? "Permanently delete" : (row.protectedReason ?? undefined)}
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </div>

      {/* A protected row says WHY delete is blocked as visible text (not only the disabled button's
        tooltip), so it's discoverable without a mouse hover. */}
      {!deletable && row.protectedReason ? (
        <StatusLine icon={ShieldAlert} tone="muted" className="px-3 pb-2">
          {row.protectedReason}
        </StatusLine>
      ) : null}
      {action?.kind === "error" ? (
        <StatusLine icon={AlertTriangle} tone="destructive" className="px-3 pb-2">
          {action.message}
        </StatusLine>
      ) : action?.kind === "deleting" ? (
        <StatusLine icon={Loader2} tone="muted" spin className="px-3 pb-2">
          Deleting…
        </StatusLine>
      ) : null}

      {confirming ? (
        <DeleteConfirm title={row.title} onCancel={onCancelConfirm} onConfirm={onConfirmDelete} />
      ) : null}
    </li>
  );
}

/** The strong-confirmation panel: type the stable phrase to arm an irreversible delete. Owns the typed
 *  value (reset on mount/unmount) and the arming guard, so a parent only tracks which row is open. */
function DeleteConfirm({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = isDeleteConfirmed(typed);
  // Focus the confirmation input the instant the panel mounts (a deliberate destructive gesture), so
  // the typed phrase is captured here and can't leak to the chat composer behind the takeover.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const confirm = () => {
    if (armed) {
      onConfirm(); // a click/Enter can't confirm while the phrase is incomplete
    }
  };
  return (
    <fieldset
      aria-label={`Confirm permanent deletion of ${title}`}
      className="min-w-0 border-t border-destructive/30 bg-destructive/5 px-3 py-2.5"
    >
      <p className="text-xs text-foreground">
        Permanently delete <span className="font-medium">{title}</span> and its entire log. This
        cannot be undone. Type{" "}
        <span className="font-mono font-medium">{DELETE_CONFIRM_PHRASE}</span> to confirm.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          aria-label={`Type ${DELETE_CONFIRM_PHRASE} to confirm permanent deletion`}
          placeholder={DELETE_CONFIRM_PHRASE}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button variant="ghost" size="sm" onClick={onCancel} className="shrink-0">
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={confirm}
          disabled={!armed}
          className="shrink-0"
        >
          <Trash2 />
          Delete forever
        </Button>
      </div>
    </fieldset>
  );
}

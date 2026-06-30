import { relativeTime } from "@trevor/session";
import { AlertTriangle, ArchiveRestore, ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type ArchivedSessionRow, isArchiveRowDeletable } from "./archive-rows";

/**
 * The archive browser (plan 04, M2/M3/M5): a transcript-takeover surface for managing archived
 * sessions, modeled on the full model chooser (D-065) - it replaces the transcript + composer while
 * the sidebars stay visible, with a top-left back arrow to return to chat. It is unmistakably a
 * management surface, not a conversation: an explicit archived-area title, per-row metadata, and a
 * destructive permanent-delete that demands a typed confirmation (distinct from the soft-delete
 * `session.deleted` marker the sidebar uses).
 *
 * Presentational over injected `ArchivedSessionRow[]` + callbacks (like `ModelChooser` over its read
 * models): delete confirmation is local UI state, but the rows and the unarchive/delete actions come
 * from props, so App owns the live inventory query and the publish/transport mutations (M6/M7). Async
 * per-row feedback rides `actionState`, keyed by sessionId, so acting on one row never blanks the rest.
 */

/** The phrase a user must type to arm a permanent delete (M5 strong confirmation). */
export const DELETE_CONFIRM_PHRASE = "delete";

/** Row-scoped async feedback for an in-flight action, owned by the App wiring (M7). */
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
  className,
}: ArchiveBrowserProps) {
  // Which row's permanent-delete is being confirmed, and the typed phrase so far. Local UI state: the
  // confirmation is a deliberate gesture, reset whenever a different row is armed or the panel closes.
  const [confirmingId, setConfirmingId] = useState<string | null>(defaultConfirmingId ?? null);
  const [typed, setTyped] = useState("");

  const openConfirm = (sessionId: string) => {
    setConfirmingId(sessionId);
    setTyped("");
  };
  const closeConfirm = () => {
    setConfirmingId(null);
    setTyped("");
  };
  const submitDelete = (sessionId: string) => {
    if (!isDeleteConfirmed(typed)) {
      return; // Enter/click cannot confirm while the phrase is incomplete (M5).
    }
    onDelete(sessionId);
    closeConfirm();
  };

  return (
    <section
      aria-label="Archived sessions"
      className={cn("@container flex min-h-0 flex-col bg-background text-foreground", className)}
    >
      {onBack ? (
        <div className="flex shrink-0 items-center px-1 py-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to chat"
            className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-label tracking-wider uppercase text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back
          </button>
        </div>
      ) : null}

      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="text-base font-medium">Archived sessions</h2>
        <p className="text-xs text-muted-foreground">
          Sessions you've archived, hidden from the sidebar and resume views. Unarchive one to
          return it to normal navigation, or permanently delete it and its entire log - this cannot
          be undone.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && rows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading archived sessions…
          </p>
        ) : error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            {error}
          </p>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">No archived sessions</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Archive a session from its sidebar menu and it will appear here for management.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <ArchiveRow
                key={row.sessionId}
                row={row}
                nowMs={nowMs}
                confirming={confirmingId === row.sessionId}
                typed={typed}
                action={actionState?.[row.sessionId]}
                onUnarchive={() => onUnarchive(row.sessionId)}
                onOpenConfirm={() => openConfirm(row.sessionId)}
                onCancelConfirm={closeConfirm}
                onTyped={setTyped}
                onSubmitDelete={() => submitDelete(row.sessionId)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** One archived-session row: metadata, an unarchive action, and a gated permanent-delete. */
function ArchiveRow({
  row,
  nowMs,
  confirming,
  typed,
  action,
  onUnarchive,
  onOpenConfirm,
  onCancelConfirm,
  onTyped,
  onSubmitDelete,
}: {
  row: ArchivedSessionRow;
  nowMs: number;
  confirming: boolean;
  typed: string;
  action: RowActionState | undefined;
  onUnarchive: () => void;
  onOpenConfirm: () => void;
  onCancelConfirm: () => void;
  onTyped: (value: string) => void;
  onSubmitDelete: () => void;
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

      {action?.kind === "error" ? (
        <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          {action.message}
        </p>
      ) : null}
      {action?.kind === "deleting" ? (
        <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          Deleting…
        </p>
      ) : null}

      {confirming ? (
        <DeleteConfirm
          title={row.title}
          typed={typed}
          onTyped={onTyped}
          onCancel={onCancelConfirm}
          onConfirm={onSubmitDelete}
        />
      ) : null}
    </li>
  );
}

/** The strong-confirmation panel (M5): type the stable phrase to arm an irreversible delete. */
function DeleteConfirm({
  title,
  typed,
  onTyped,
  onCancel,
  onConfirm,
}: {
  title: string;
  typed: string;
  onTyped: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const armed = isDeleteConfirmed(typed);
  // Focus the confirmation input the instant the panel mounts (a deliberate destructive gesture), so
  // the typed phrase is captured here and can't leak to the chat composer behind the takeover.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
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
          onChange={(e) => onTyped(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
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
          onClick={onConfirm}
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

import { Archive } from "lucide-react";

/**
 * The archived-session gate (D-094 M2): when the open session is archived, the main UI replaces the
 * composer with this notice so normal use requires an explicit unarchive first. The transcript stays
 * readable above it; only sending is gated. Unarchive clears the durable flag and the composer returns.
 */
export function ArchivedNotice({ onUnarchive }: { onUnarchive: () => void }) {
  return (
    <div
      role="status"
      aria-label="session archived"
      className="flex items-center justify-between gap-3 border border-border bg-card px-4 py-3 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Archive className="size-4 shrink-0" />
        <span className="truncate">This session is archived. Unarchive it to send messages.</span>
      </span>
      <button
        type="button"
        onClick={onUnarchive}
        className="shrink-0 cursor-pointer rounded-md border border-border bg-background px-3 py-1.5 text-foreground hover:bg-card"
      >
        Unarchive
      </button>
    </div>
  );
}

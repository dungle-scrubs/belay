import type { SessionSummary } from "@trevor/session";
import { type RowChooserAdapter, RowChooserModal } from "@/components/command-modal";
import { buildResumeRows, type ResumeContext } from "./resume-rows";

/** The resume chooser's chrome + row projection (D-090); the structure lives in RowChooserModal. */
const RESUME_CHOOSER: RowChooserAdapter<readonly SessionSummary[], ResumeContext> = {
  title: "Resume session",
  placeholder: "Search sessions…",
  emptyLabel: "No sessions found",
  footerHints: [
    { keys: "↑↓", label: "navigate" },
    { keys: "↵", label: "resume" },
    { keys: "esc", label: "close" },
  ],
  buildRows: buildResumeRows,
};

export interface ResumeModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessions: readonly SessionSummary[];
  readonly loading?: boolean;
  readonly error?: string | null;
  /** Current-session context: drives ordering, current-row marking, and the busy switch-block. */
  readonly context: ResumeContext;
  /** Called with the chosen durable session id (an enabled row only). */
  readonly onResume: (sessionId: string) => void;
}

/**
 * The resume chooser (D-090): binds the resume adapter + session inventory to the shared
 * `RowChooserModal`. Presentational - App owns fetching (`useInventory`) and the actual session
 * switch (`onResume`). Selecting an enabled row resumes and closes; a disabled row (the current
 * session, or any row while the current session is busy) never fires.
 */
export function ResumeModal({
  open,
  onOpenChange,
  sessions,
  loading,
  error,
  context,
  onResume,
}: ResumeModalProps) {
  return (
    <RowChooserModal
      adapter={RESUME_CHOOSER}
      open={open}
      onOpenChange={onOpenChange}
      data={sessions}
      context={context}
      loading={loading}
      error={error}
      onSelect={onResume}
    />
  );
}

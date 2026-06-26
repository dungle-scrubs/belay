import type { SessionSummary } from "@trevor/session";
import { useMemo } from "react";
import { CommandModal, type FooterHint } from "@/components/command-modal";
import { buildResumeRows, type ResumeContext } from "./resume-rows";

const RESUME_HINTS: readonly FooterHint[] = [
  { keys: "↑↓", label: "navigate" },
  { keys: "↵", label: "resume" },
  { keys: "esc", label: "close" },
];

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
 * The resume chooser (D-090): the shared `CommandModal` fed by the resume-row adapter over
 * the session inventory. Presentational - App owns fetching (`useInventory`) and the actual
 * session switch (`onResume`). Selecting an enabled row resumes and closes; a disabled row
 * (the current session, or any row while the current session is busy) never fires.
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
  const rows = useMemo(() => buildResumeRows(sessions, context), [sessions, context]);
  return (
    <CommandModal
      open={open}
      onOpenChange={onOpenChange}
      title="Resume session"
      placeholder="Search sessions…"
      rows={rows}
      loading={loading}
      error={error ?? undefined}
      emptyLabel="No sessions found"
      footerHints={RESUME_HINTS}
      onSelect={(id) => {
        onResume(id);
        onOpenChange(false);
      }}
    />
  );
}

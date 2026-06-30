import { GitBranch, Loader2, PencilLine } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { PendingHandoff } from "@/derive";
import { cn } from "@/lib/utils";

/**
 * The generated-handoff approval surface (02.10): it replaces the composer while a `/handoff` draft is
 * pending, mirroring the ask_user QuestionSurface's place and card chrome. `generating` shows a spinner
 * while the model drafts; `generated` shows the draft (inert text, never interpreted as markup) with
 * Approve / Edit / Reject. Approve hands off as-is; Edit opens the full prompt editor seeded with the
 * draft (the parent wires `onEdit` to usePromptEditor); Reject keeps the user in this session. It owns
 * no transport - the parent publishes `handoff.approved` / `handoff.rejected` from these callbacks.
 */
export interface HandoffApprovalSurfaceProps {
  readonly handoff: PendingHandoff;
  /** Approve the draft unchanged - publishes `handoff.approved`. */
  readonly onApprove: () => void;
  /** Edit before approving - opens the prompt editor seeded with the draft text. */
  readonly onEdit: (prompt: string) => void;
  /** Reject the draft - publishes `handoff.rejected`; the source session stays active. */
  readonly onReject: () => void;
  readonly className?: string;
}

export function HandoffApprovalSurface({
  handoff,
  onApprove,
  onEdit,
  onReject,
  className,
}: HandoffApprovalSurfaceProps) {
  const approveRef = useRef<HTMLButtonElement>(null);

  // Move focus onto Approve as soon as the draft is ready, so Enter approves without a click first
  // (the surface replaces the composer, so nothing else competes for focus).
  useEffect(() => {
    if (handoff.status === "generated") {
      approveRef.current?.focus();
    }
  }, [handoff.status]);

  return (
    <section
      aria-label="Hand off to a fresh session"
      className={cn(
        "flex w-full flex-col gap-4 rounded-xl bg-card p-4 text-foreground shadow-sm",
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <GitBranch className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Hand off to a fresh session</h2>
      </header>

      {handoff.status === "generating" ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-smui-surface-2 px-3 py-2">
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Drafting a handoff prompt from this session…
          </p>
          {/* Cancel during drafting (publishes handoff.rejected). It clears the surface client-side even
              if the host died mid-draft - the previously-unescapable "stuck Drafting…" case. */}
          <Button type="button" variant="ghost" size="sm" onClick={onReject}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Review the prompt the new session will start with. Approve to switch, edit it first, or
            reject to stay here.
          </p>
          <pre className="max-h-64 overflow-auto rounded-md bg-smui-surface-sunken p-3 text-xs leading-relaxed whitespace-pre-wrap text-foreground">
            {handoff.prompt}
          </pre>
          <footer className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onReject}>
              Reject
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onEdit(handoff.prompt)}
            >
              <PencilLine className="size-3.5" />
              Edit
            </Button>
            <Button ref={approveRef} type="button" size="sm" onClick={onApprove}>
              Approve &amp; switch
            </Button>
          </footer>
        </>
      )}
    </section>
  );
}

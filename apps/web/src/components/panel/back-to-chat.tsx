import { ArrowLeft } from "lucide-react";

/**
 * The top-left "Back to chat" affordance shared by the transcript-takeover surfaces (the model chooser
 * and the archive browser): a back arrow that returns to the conversation without mutating session
 * state. Owning it here keeps the two takeovers from drifting on its markup, label, or aria.
 */
export function BackToChat({ onBack }: { onBack: () => void }) {
  return (
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
  );
}

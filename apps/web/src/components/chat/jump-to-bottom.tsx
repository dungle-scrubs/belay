import { ChevronDown } from "lucide-react";
import { memo, useSyncExternalStore } from "react";
import type { ScrollFollowUi } from "@/hooks/use-scroll-follow";
import { cn } from "@/lib/utils";
import type { ScrollFollowController } from "@/scroll-follow";

/**
 * The jump-to-bottom chevron as its own leaf (Tier 2.4): the ONLY surface that renders the pin +
 * unseen state, so it subscribes to the follow controller and the adapter's ui store directly (the
 * same `useSyncExternalStore` pattern VirtualTranscript uses for the pin bit) instead of having those
 * values lifted through App. A pin flip or an unseen-content change re-renders exactly this button;
 * every prop is identity-stable, so the memo skips it on all parent renders.
 *
 * Two visual states: plain away-from-edge, or a primary-colored border/icon when there is unseen
 * content below (no glow shadow - the border color alone signals it). Hidden entirely while pinned.
 */
function JumpToBottomImpl({
  controller,
  ui,
  onJump,
  className,
}: {
  readonly controller: ScrollFollowController;
  readonly ui: ScrollFollowUi;
  /** The adapter's `scrollToBottom`: re-pins and requests an explicit live-edge scroll. */
  readonly onJump: () => void;
  readonly className?: string;
}) {
  const atBottom = useSyncExternalStore(
    controller.subscribe,
    controller.isPinned,
    controller.isPinned,
  );
  const hasUnseen = useSyncExternalStore(ui.subscribe, ui.hasUnseen, ui.hasUnseen);
  if (atBottom) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={hasUnseen ? "Scroll to new content" : "Scroll to bottom"}
      data-unseen={hasUnseen ? "true" : undefined}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-md border bg-card shadow-sm transition-colors",
        hasUnseen
          ? "border-primary text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <ChevronDown className="size-4" />
    </button>
  );
}

export const JumpToBottom = memo(JumpToBottomImpl);

import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Message } from "@/transcript";
import { isDetailEligible } from "./detail-model";

/**
 * Wraps a transcript row with the "inspect" affordance that opens its tool detail takeover (plan 08 M5).
 * Only an eligible row (a tool call or the shell lane) gets the button, so non-eligible rows are never
 * cluttered; it sits top-right, revealed on row hover/focus, and never blocks the row's own selection or
 * links. When no `onOpenDetail` is wired (e.g. Storybook), the row renders exactly as before.
 */
export function WithInspect({
  message,
  onOpenDetail,
  className,
  children,
}: {
  readonly message: Message;
  readonly onOpenDetail?: (message: Message) => void;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (!onOpenDetail || !isDetailEligible(message)) {
    return <>{children}</>;
  }
  return (
    // The wrapper itself tints on hover (the queued-follow-ups tint), so a row that offers the
    // inspect takeover reads as hoverable, not just its top-right icon.
    <div
      className={cn(
        "group/inspect relative rounded-sm transition-colors hover:bg-muted/25",
        className,
      )}
    >
      {children}
      <button
        type="button"
        onClick={() => onOpenDetail(message)}
        aria-label="Inspect tool detail"
        title="Inspect"
        className="absolute top-0 right-1 flex h-6 cursor-pointer items-center rounded px-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/inspect:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </button>
    </div>
  );
}

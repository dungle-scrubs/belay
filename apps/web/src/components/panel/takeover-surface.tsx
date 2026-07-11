import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The shared shell for a conversation-replacing takeover (the model chooser, archive browser, and
 * tangent discovery): a focusable region that auto-focuses on mount - so Escape and scrolling work
 * immediately - and closes on Escape. The global Escape router is already suppressed while a takeover
 * is frontmost (escapeAction's `modalOpen` guard), so owning Escape here is what returns to the
 * conversation. This mirrors the hand-rolled behavior in the tool-detail / agent-detail takeovers.
 *
 * Render the BackToChat affordance and the takeover body as children.
 */
export function TakeoverSurface({
  onBack,
  label,
  className,
  children,
}: {
  /** Close the takeover (return to the conversation). Escape and the BackToChat arrow both call it. */
  readonly onBack?: () => void;
  /** Accessible name for the region. */
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  // Read onBack through a ref so a fresh inline handler each render doesn't retrigger the mount focus.
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onBackRef.current) {
          event.preventDefault();
          onBackRef.current();
        }
      }}
      className={cn("@container flex min-h-0 flex-col outline-none", className)}
    >
      {children}
    </section>
  );
}

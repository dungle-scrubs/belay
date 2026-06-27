import { PanelLeft, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The shared side-drawer chrome (D-093): ONE component for both the left session sidebar and the
 * right detail panel, parameterized by `side`. It owns the chrome only - the full-height column, the
 * side-appropriate border, and the slide-in-from-that-edge entry - so the two drawers stay visually
 * symmetric and a single place controls how a drawer enters. The content (rows / sections) is
 * injected, and width/tone are passed so each drawer keeps its own footprint.
 */
export interface SideDrawerProps {
  readonly side: "left" | "right";
  readonly ariaLabel: string;
  /** Width utility, e.g. "w-64" (left) / "w-80" (right). */
  readonly widthClass: string;
  /** Surface background utility, e.g. "bg-smui-surface-sunken" / "bg-card/40". */
  readonly toneClass: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function SideDrawer({
  side,
  ariaLabel,
  widthClass,
  toneClass,
  children,
  className,
}: SideDrawerProps) {
  return (
    <aside
      aria-label={ariaLabel}
      className={cn(
        // No enter/transition animation - the drawers appear/disappear instantly (user preference).
        "flex h-full shrink-0 flex-col border-border",
        side === "left" ? "border-r" : "border-l",
        widthClass,
        toneClass,
        className,
      )}
    >
      {children}
    </aside>
  );
}

/**
 * The drawer toggle glyph (D-093): the mirrored panel icon (`PanelLeft` / `PanelRight`), used for BOTH
 * opening (in the main header strip, when the drawer is collapsed) and closing (inside the drawer, on
 * its inner edge). The glyph never changes between the two - only its position and `onClick` do - so
 * the open/close affordance reads as one consistent control. Always visible (it lives in a dedicated
 * strip, never over the transcript).
 */
export function DrawerToggle({
  side,
  onClick,
  label,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="size-4.5" />
    </button>
  );
}

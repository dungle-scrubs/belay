import { PanelLeft, PanelRight } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
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
 * True while the pointer is within `radius` px of the referenced element - Euclidean distance to the
 * NEAREST point of the element's box (0 while the pointer is over it), a pointer-POSITION test that is
 * independent of what element the pointer is actually on top of. Used to reveal an otherwise-hidden
 * control only as the cursor nears it. A coarse pointer (touch: no hover) can't approach without
 * tapping, so the control is kept visible there. rAF-throttled; only listens while `enabled`.
 */
function usePointerWithin(
  ref: RefObject<HTMLElement | null>,
  radius: number,
  enabled: boolean,
): boolean {
  const [within, setWithin] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setWithin(false);
      return;
    }
    if (window.matchMedia?.("(hover: none)").matches) {
      setWithin(true);
      return;
    }
    let frame = 0;
    let x = 0;
    let y = 0;
    const measure = () => {
      frame = 0;
      const el = ref.current;
      if (!el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      // Distance from the pointer to the nearest point of the box: 0 on each axis while the pointer is
      // between the box's edges, else the gap past the nearer edge. So `within` is true anywhere inside
      // the button and out to `radius` beyond its border.
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      setWithin(dx * dx + dy * dy <= radius * radius);
    };
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [ref, radius, enabled]);
  return within;
}

/**
 * The drawer toggle glyph (D-093): the mirrored panel icon (`PanelLeft` / `PanelRight`), used for BOTH
 * opening (in the main header strip, when the drawer is collapsed) and closing (inside the drawer, on
 * its inner edge). The glyph never changes between the two - only its position and `onClick` do - so
 * the open/close affordance reads as one consistent control.
 *
 * With `proximityRadius` set (the header open-toggles), the glyph stays hidden until the pointer comes
 * within that many px of the button ITSELF - a position test, not element hover - and reveals on
 * keyboard focus so it stays reachable. Unset (the in-drawer collapse affordance), it is always
 * visible.
 */
export function DrawerToggle({
  side,
  onClick,
  label,
  proximityRadius,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
  readonly proximityRadius?: number;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  const ref = useRef<HTMLButtonElement>(null);
  const gated = proximityRadius != null && proximityRadius > 0;
  const near = usePointerWithin(ref, proximityRadius ?? 0, gated);
  const [focused, setFocused] = useState(false);
  const hidden = gated && !near && !focused;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cn(
        "cursor-pointer text-muted-foreground transition-[color,opacity] duration-150 hover:text-foreground",
        hidden && "pointer-events-none opacity-0",
      )}
    >
      <Icon className="size-4.5" />
    </button>
  );
}

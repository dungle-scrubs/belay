import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtTokens } from "@/derive";
import { useArmedAfterMount } from "@/hooks/use-armed-after-mount";
import { squarify, type TreemapLeaf } from "./treemap-layout";

const GAP = 3; // px gap drawn between cells, via per-cell padding
const MIN_CELL_FRACTION = 0.05; // floor so even ~1% categories stay visible
// Cells glide to their new spot/size when the live breakdown shifts, instead of
// snapping - so you can watch a category grow as a turn streams. Matches the ctx
// meter's 300ms ease-out. Only existing cells (stable key) animate; new/removed
// categories just appear/vanish.
const CELL_TRANSITION =
  "left 600ms ease-out, top 600ms ease-out, width 600ms ease-out, height 600ms ease-out";

/**
 * Renders weighted leaves as a squarified treemap. Measures its own width so the
 * layout runs in real pixels and the cells stay square (not stretched), and
 * re-lays out on resize. Hovering a cell shows a `label · tokens · %` tooltip
 * that follows the cursor and stays inside the viewport - useful where the
 * in-cell label is truncated or hidden.
 */
export function Treemap({
  leaves,
  total,
  totalTokens,
  height = 184,
  ready = true,
}: {
  leaves: readonly TreemapLeaf[];
  /** True call total, the denominator for tooltip/legend percentages. */
  total: number;
  /**
   * Call token total. When provided, each cell's tooltip also shows its token
   * count, apportioned from this total by the cell's share of `total`.
   */
  totalTokens?: number;
  height?: number;
  /** Session ready (initial replay done); cells don't animate until then. */
  ready?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only ever adopt a POSITIVE width. A transient 0 (the panel reflowing, or the tab briefly
    // hidden) would otherwise collapse every cell to nothing, and the cell transition would then
    // animate them all back up - reading as the whole treemap "scaling in" on each change. Keeping
    // the last good width means only the portions' sizes glide when the breakdown shifts.
    const adopt = (w: number) => {
      if (w > 0) {
        setWidth(w);
      }
    };
    adopt(el.clientWidth);
    const ro = new ResizeObserver((entries) => adopt(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placed = useMemo(
    () => (width > 0 ? squarify(leaves, width, height, { minFraction: MIN_CELL_FRACTION }) : []),
    [leaves, width, height],
  );

  // Don't animate the initial layout in or the replay settling; only glide on later
  // size changes. Armed once the session is ready and the first layout has painted.
  const armed = useArmedAfterMount(ready && width > 0);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: passive hover target; tooltip mirrors the always-visible legend below.
    <div
      ref={ref}
      className="relative w-full overflow-hidden"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
    >
      {placed.map((p) => {
        const showLabel = p.rect.w > 48 && p.rect.h > 22;
        const percent = total > 0 ? Math.round((p.value / total) * 100) : 0;
        const tokens =
          totalTokens != null && total > 0 ? Math.round((p.value / total) * totalTokens) : null;
        const text =
          tokens != null
            ? `${p.label} · ${fmtTokens(tokens)} · ${percent}%`
            : `${p.label} · ${percent}%`;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: passive hover target; tooltip mirrors the always-visible legend below.
          <div
            key={p.key}
            className="absolute"
            style={{
              left: p.rect.x,
              top: p.rect.y,
              width: p.rect.w,
              height: p.rect.h,
              padding: GAP / 2,
              transition: armed ? CELL_TRANSITION : undefined,
            }}
            onMouseMove={(e) => setHover({ text, x: e.clientX, y: e.clientY })}
          >
            <div
              className="flex h-full w-full flex-col justify-end overflow-hidden rounded-[3px] px-1.5 py-1 transition-[filter] hover:brightness-110"
              style={{ background: p.color }}
            >
              {showLabel ? (
                <span
                  className="truncate text-[11px] font-medium leading-tight"
                  style={{ color: "rgba(20,22,28,0.82)" }}
                >
                  {p.label}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {hover ? <FollowTooltip x={hover.x} y={hover.y} text={hover.text} /> : null}
    </div>
  );
}

const FOLLOW_OFFSET = 14; // px gap between the cursor and the tooltip box
const EDGE_PAD = 8; // px the tooltip keeps from the viewport edges

/**
 * A tooltip pinned near the cursor (`x`/`y` in viewport coordinates). It measures
 * itself and flips/clamps so it never spills past a viewport edge. Portaled to
 * `document.body` and click-through so it never interferes with hovering cells.
 */
function FollowTooltip({ x, y, text }: { x: number; y: number; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Prefer above-right of the cursor; flip when it would overflow, then clamp.
    let left = x + FOLLOW_OFFSET;
    if (left + w > vw - EDGE_PAD) left = x - w - FOLLOW_OFFSET;
    left = Math.min(Math.max(left, EDGE_PAD), Math.max(EDGE_PAD, vw - w - EDGE_PAD));

    let top = y - h - FOLLOW_OFFSET;
    if (top < EDGE_PAD) top = y + FOLLOW_OFFSET;
    top = Math.min(Math.max(top, EDGE_PAD), Math.max(EDGE_PAD, vh - h - EDGE_PAD));

    setPos({ left, top });
    // `text` is intentionally omitted: it only changes alongside x/y (a hover
    // move), and re-measuring on every position change already covers it.
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      className="pointer-events-none fixed z-50 w-fit whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md"
      style={{ left: pos.left, top: pos.top }}
    >
      {text}
    </div>,
    document.body,
  );
}

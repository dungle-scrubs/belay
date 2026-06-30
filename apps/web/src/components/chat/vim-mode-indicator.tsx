import { cn } from "@/lib/utils";
import type { VimMode } from "@/vim/mode";

/**
 * The Vim mode indicator (plan 06): a compact, stable-width pill in the composer bottom row next to the
 * `+` upload / shell glyph, showing INSERT / NORMAL / VISUAL when Vim mode is enabled. Fixed height +
 * `min-w` + a monospace label keep it from wrapping, resizing, or reflowing the composer as the mode
 * changes (all three labels are 6 chars). Presentational only - the controller owns the mode; this just
 * renders it (and an accessible name, no visible instructional copy).
 */

const MODE_STYLE: Record<VimMode, string> = {
  // insert: calm/neutral (you're just typing); normal: active command lane; visual: selection.
  insert: "border-border text-muted-foreground",
  normal: "border-smui-frost-3/40 text-smui-frost-3",
  visual: "border-smui-yellow/40 text-smui-yellow",
};

export function VimModeIndicator({ mode, className }: { mode: VimMode; className?: string }) {
  return (
    <span
      role="status"
      aria-label={`Vim mode: ${mode}`}
      className={cn(
        "inline-flex h-6 min-w-[3.5rem] shrink-0 items-center justify-center rounded border px-1.5 font-mono text-label tracking-wider uppercase tabular-nums select-none",
        MODE_STYLE[mode],
        className,
      )}
    >
      {mode}
    </span>
  );
}

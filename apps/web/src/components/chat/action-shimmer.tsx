/**
 * Responsible for: the active-status text indicator - a shimmering present-progress label
 * ("Working", "thinking", "reading apps/web/src/app.tsx") with optional elapsed-time and
 * interruptible meta, using the repo's `tw-shimmer` `shimmer` utility (the same overlay idiom as
 * the assistant-ui tool-group / reasoning triggers) and its `motion-reduce:animate-none` fallback.
 *
 * Not for: deciding what the label text should be. The label is projected upstream from structured
 * transcript/session events (see `action-label.ts`); this module only renders whatever string it is
 * handed. It never interprets events, never animates settled rows, and never invents a label.
 */

import { useInterval } from "ahooks";
import { useState } from "react";
import { formatElapsed } from "@/derive";
import { cn } from "@/lib/utils";

/**
 * The shimmer text treatment: a solid base label with an aria-hidden overlay that runs the
 * `tw-shimmer` band across it. The base text stays readable, so under `prefers-reduced-motion`
 * (`motion-reduce:animate-none`) the label simply stops animating rather than disappearing. The
 * `relative inline-block` wrapper is sized by the base text, so the absolutely-positioned overlay
 * never shifts layout width. Matches `tool-group.tsx` / `reasoning.tsx`.
 */
export function ShimmerText({ children }: { children: string }) {
  return (
    <span className="relative inline-block leading-none">
      <span>{children}</span>
      <span
        aria-hidden
        className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
      >
        {children}
      </span>
    </span>
  );
}

/** Live elapsed since `startedAt` (ms epoch), re-rendered each second; null when no start time. */
function useElapsedLabel(startedAt?: number): string | null {
  const [, tick] = useState(0);
  // An undefined delay pauses the interval, so the ticker only runs while a start time is set.
  useInterval(() => tick((n) => n + 1), startedAt === undefined ? undefined : 1000);
  return startedAt === undefined ? null : formatElapsed(Date.now() - startedAt, { hours: true });
}

/**
 * The active-status indicator. With `startedAt` (the turn's start, ms epoch) and/or `interruptible`
 * it renders the bold turn form - "Working (5m 29s · esc to interrupt)" - with a live elapsed timer;
 * otherwise a plain italic muted "label" (the connecting/thinking/tool-running placeholders). Either
 * way the label text shimmers. The label is always rendered as plain readable text (screen readers
 * announce the base span; the shimmer overlay is `aria-hidden`), so there is no duplicated
 * announcement and no motion for reduced-motion users.
 */
export function ActionShimmer({
  label = "Working",
  startedAt,
  interruptible = false,
  className,
}: {
  label?: string;
  startedAt?: number;
  interruptible?: boolean;
  className?: string;
}) {
  const elapsed = useElapsedLabel(startedAt);
  const meta = [elapsed, interruptible ? "esc to interrupt" : null].filter(Boolean).join(" · ");

  if (meta) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-sm text-foreground", className)}>
        <span className="font-semibold">
          <ShimmerText>{label}</ShimmerText>
        </span>
        <span className="text-muted-foreground">({meta})</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm italic text-muted-foreground",
        className,
      )}
    >
      <ShimmerText>{label}</ShimmerText>
    </span>
  );
}

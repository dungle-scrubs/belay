"use client";

import { useScrollLock } from "@assistant-ui/react";
import { useCallback, useRef, useState } from "react";

/** The shared open/close animation window for every assistant-ui disclosure (tool
 *  fallback, tool group, reasoning). Drives the scroll-lock duration and the
 *  `--animation-duration` CSS var the collapsible content reads. */
export const ANIMATION_DURATION = 200;

export interface CollapsibleDisclosure {
  /** Attach to the Collapsible Root - the scroll-lock anchor. */
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether `open` is externally controlled (the parent owns the state). */
  readonly isControlled: boolean;
  /** Pins scroll for one animation frame so a collapse doesn't yank the viewport. */
  readonly lockScroll: () => void;
}

/**
 * The controlled/uncontrolled disclosure state every assistant-ui collapsible Root
 * shares, with scroll-lock baked in: a `ref` for the lock anchor, the resolved `open`,
 * and an `onOpenChange` that locks scroll, updates the internal state when uncontrolled,
 * then forwards to the parent. Reasoning layers its streaming auto-open on top of the
 * same `lockScroll` / `isControlled` (it resolves `open` itself), so this hook stays the
 * single home for the base wiring.
 */
export function useCollapsibleDisclosure({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange: controlledOnOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}): CollapsibleDisclosure {
  const ref = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(ref, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const onOpenChange = useCallback(
    (next: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      controlledOnOpenChange?.(next);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return { ref, open, onOpenChange, isControlled, lockScroll };
}

/**
 * The transcript follow controller (plan 12.2). One authority owns "does the transcript follow the
 * live edge, and may this programmatic scroll write run" - replacing the pre-12.2 lagging derived pin
 * state that ~6 independent effects each consulted and fought over.
 *
 * Responsible for:
 *   - The pin state machine. Unpin is DIRECTION-BASED and SYNCHRONOUS: any upward user gesture unpins
 *     in the same call, with no `atBottomOf` precondition and no intent window; an unattributed
 *     scrollTop DECREASE (scrollbar drag, keyboard) also unpins. Re-pin happens only on a deliberate
 *     return to the bottom (a downward user scroll ending within the tolerance band), the jump button,
 *     or prompt submit - upward transit through the band never re-pins.
 *   - Write arbitration. While pinned, follow-class writes are allowed; while unpinned every
 *     follow-class write is denied and only anchor-compensation writes (which keep the viewport
 *     visually stationary) pass.
 *   - Self-write bookkeeping, so a scroll event caused by a write this controller approved is not
 *     misread as user movement.
 *   - A debug snapshot (pinned, last transition reason, last denied write) and a change subscription
 *     for the React adapter's jump-button render.
 *
 * Not for: the DOM, React, or the virtualizer (that is the adapter + `VirtualTranscript`), and not the
 * bottom-distance math - that stays in `scroll.ts` and is imported here (never re-derived).
 */

import { atBottomOf, type ScrollGeometry } from "./scroll";

/** Why the pin state last changed - surfaced in the debug snapshot and (as a data attribute) the DOM. */
export type PinReason =
  | "init"
  | "user-gesture-up"
  | "unattributed-scroll-up"
  | "user-return-to-bottom"
  | "jump"
  | "submit";

/**
 * The two kinds of programmatic scroll write the controller arbitrates:
 *   - `follow`: go to the live edge (append follow, streaming growth, the settle loop, the pinned rAF).
 *     Allowed only while pinned.
 *   - `anchor-compensation`: adjust scrollTop to keep the viewport VISUALLY STATIONARY while content
 *     above the fold re-measures. Allowed always - it never moves the user, it cancels a shift.
 */
export type WriteClass = "follow" | "anchor-compensation";

export interface DeniedWrite {
  readonly writeClass: WriteClass;
  /** A label for the writer that was denied, so a future tug names itself instead of being silent. */
  readonly writer: string;
}

export interface ScrollFollowSnapshot {
  readonly pinned: boolean;
  readonly lastReason: PinReason;
  readonly lastDeniedWrite: DeniedWrite | null;
}

export interface WriteDecision {
  readonly allowed: boolean;
  /** A short machine-readable reason, handy in the dev log and in tests. */
  readonly reason: string;
}

export interface RequestWriteOptions {
  /** Names the writer for the debug snapshot + dev log (e.g. "append", "settle-loop", "scroll-to-fn"). */
  readonly writer?: string;
  /** The scrollTop the element will hold after this write, if known, so the resulting scroll event is
   *  recognized as a self-write rather than reinterpreted as user movement. */
  readonly resultingOffset?: number;
}

export interface ScrollFollowController {
  /** Whether the transcript is currently following the live edge. */
  isPinned(): boolean;
  /** An inspectable snapshot: pin state, the last transition reason, and the last denied write. */
  snapshot(): ScrollFollowSnapshot;
  /** Subscribe to pin-state changes (for `useSyncExternalStore` in the adapter). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** A directional user gesture (wheel `deltaY` sign, touch-move delta). Upward unpins synchronously. */
  gesture(direction: "up" | "down"): void;
  /** A scroll event from the element, with its current geometry. Reconciles self-writes, unpins on an
   *  unattributed upward move, and re-pins on a deliberate return to the bottom. */
  scrolled(geo: ScrollGeometry): void;
  /** An explicit re-pin command: the jump-to-bottom affordance or a prompt submit. Re-pins from anywhere. */
  repin(reason: "jump" | "submit"): void;
  /** Ask whether a programmatic scroll write may run, and record it for self-write recognition. */
  requestWrite(writeClass: WriteClass, options?: RequestWriteOptions): WriteDecision;
}

/** Sub-pixel slack: scroll positions within this many px count as "the same place" (rounding, clamping). */
const EPSILON_PX = 1.5;

/** How many recent approved-write offsets to remember for self-write recognition (one follow can issue
 *  several writes in a frame; a scroll event matches the newest that lands). */
const SELF_OFFSET_HISTORY = 8;

/** Whether to emit the dev-only structured log for a denied write. Bundlers strip this in production. */
function isDev(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

export function createScrollFollowController(
  options: { readonly initialPinned?: boolean } = {},
): ScrollFollowController {
  let pinned = options.initialPinned ?? true;
  let lastReason: PinReason = "init";
  let lastDeniedWrite: DeniedWrite | null = null;

  // The last scrollTop the controller has seen, used to derive direction from a scroll event. `null`
  // until the first event: direction is undefined without a prior sample, so the first scroll only
  // establishes the baseline (the directional `gesture` path is the primary unpin trigger anyway).
  let lastScrollTop: number | null = null;
  // The resulting offsets of recently approved writes, matched against the next scroll event so our own
  // writes are not reinterpreted as user movement. A ring (not a single slot) because one follow can
  // issue several writes in a frame (virtualizer scrollToEnd + a direct scrollTo + a re-measure
  // correction) whose landing offset drifts, and the coalesced scroll event matches only one of them.
  const selfOffsets: number[] = [];
  // Whether the user is currently scrolling DOWNWARD by their own hand - set by a downward gesture,
  // cleared by an upward one or a re-pin. The scroll-event re-pin requires this: a bare downward scroll
  // to the bottom with no gesture behind it is a residual follow self-scroll (its event can land just
  // after an upward gesture unpins), not a deliberate return, and must not re-pin.
  let sawDownGesture = false;
  // Writers already named in the dev log for the current unpinned span, so each is warned about at most
  // once (a denied follow write is EXPECTED while reading; we just want the writer named, not a flood).
  const warnedWriters = new Set<string>();

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setPinned = (next: boolean, reason: PinReason): void => {
    lastReason = reason;
    if (pinned === next) {
      return;
    }
    pinned = next;
    if (pinned) {
      // A fresh unpinned span starts on the next unpin; clear the per-span dev-log dedup now.
      warnedWriters.clear();
    }
    notify();
  };

  const gesture = (direction: "up" | "down"): void => {
    // Upward is the whole point: unpin synchronously, with no position precondition and no intent
    // window. Downward is not, by itself, a re-pin - it ARMS the scroll-event re-pin, which fires once
    // the viewport actually arrives within the tolerance band (a downward gesture ending at the bottom).
    if (direction === "up") {
      sawDownGesture = false;
      setPinned(false, "user-gesture-up");
    } else {
      sawDownGesture = true;
    }
  };

  const scrolled = (geo: ScrollGeometry): void => {
    // Self-write recognition FIRST: a scroll event that lands where a write we approved said it would is
    // our own movement - consume it (and any older, now-stale offsets), advance the baseline, and change
    // nothing else.
    const matched = selfOffsets.findIndex(
      (offset) => Math.abs(geo.scrollTop - offset) <= EPSILON_PX,
    );
    if (matched !== -1) {
      selfOffsets.splice(0, matched + 1);
      lastScrollTop = geo.scrollTop;
      return;
    }

    // The first observed scroll only sets the baseline - direction is undefined without a prior sample.
    if (lastScrollTop === null) {
      lastScrollTop = geo.scrollTop;
      return;
    }

    const previous = lastScrollTop;
    lastScrollTop = geo.scrollTop;

    const movedUp = geo.scrollTop < previous - EPSILON_PX;
    const movedDown = geo.scrollTop > previous + EPSILON_PX;

    if (pinned) {
      // The catch-all unpin: an unattributed UPWARD scroll that leaves the bottom band (keyboard PageUp,
      // touch drag, a scrollbar where one is shown) - the user read away from the live edge. Both
      // conditions matter: a follow write moving DOWN toward the edge must never trip this even while it
      // momentarily trails a fast stream (bottomDelta > tolerance mid-catch-up), and a sub-band nudge
      // that stays at the live edge is still "at bottom", not a read.
      if (movedUp && !atBottomOf(geo)) {
        setPinned(false, "unattributed-scroll-up");
      }
      return;
    }

    // Unpinned: re-pin only on a DELIBERATE return to the bottom - a downward gesture (armed above) that
    // arrives within the tolerance band. Upward transit through the band never satisfies this, and a
    // gesture-less downward scroll (a residual follow write settling) is not a return.
    if (sawDownGesture && movedDown && atBottomOf(geo)) {
      sawDownGesture = false;
      setPinned(true, "user-return-to-bottom");
    }
  };

  const repin = (reason: "jump" | "submit"): void => {
    sawDownGesture = false;
    setPinned(true, reason);
  };

  const requestWrite = (
    writeClass: WriteClass,
    writeOptions: RequestWriteOptions = {},
  ): WriteDecision => {
    // Anchor-compensation is always allowed - it cancels a content shift to keep the viewport where the
    // user left it, which is the ONE programmatic write that is safe while unpinned.
    const allowed = writeClass === "anchor-compensation" || pinned;

    if (!allowed) {
      const writer = writeOptions.writer ?? "unknown";
      lastDeniedWrite = { writeClass, writer };
      if (isDev() && !warnedWriters.has(writer)) {
        warnedWriters.add(writer);
        // Structured, dev-only: names the writer that tried to follow while the user was reading, so a
        // future regression is attributable instead of a silent tug.
        console.warn("[scroll-follow] denied a follow write while unpinned", {
          writer,
          writeClass,
        });
      }
      return { allowed: false, reason: "unpinned-denies-follow" };
    }

    // Approved: record where the element will end up so the resulting scroll event is a recognized
    // self-write. Keep only the last few offsets - a scroll event coalesces to the most recent write.
    if (writeOptions.resultingOffset !== undefined) {
      selfOffsets.push(writeOptions.resultingOffset);
      if (selfOffsets.length > SELF_OFFSET_HISTORY) {
        selfOffsets.shift();
      }
    }
    return {
      allowed: true,
      reason: writeClass === "follow" ? "pinned-allows-follow" : "anchor-allowed",
    };
  };

  return {
    isPinned: () => pinned,
    snapshot: () => ({ pinned, lastReason, lastDeniedWrite }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    gesture,
    scrolled,
    repin,
    requestWrite,
  };
}

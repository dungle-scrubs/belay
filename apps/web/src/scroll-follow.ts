/**
 * The transcript follow controller (plan 12.2). One authority owns "does the transcript follow the
 * live edge, and may this programmatic scroll write run" - replacing the pre-12.2 lagging derived pin
 * state that ~6 independent effects each consulted and fought over.
 *
 * Responsible for:
 *   - The pin state machine. Unpin is DIRECTION-BASED and SYNCHRONOUS: any upward user gesture unpins
 *     in the same call, with no `atBottomOf` precondition and no intent window; an unattributed
 *     upward scroll (touch drag, keyboard, a scrollbar where one is shown) also unpins. Re-pin happens
 *     only on a genuine user arrival at the bottom - any input kind, recognized from the scroll event
 *     moving DOWN and ending within the tolerance band - the jump button, or prompt submit. Upward
 *     transit through the band never re-pins.
 *   - Write arbitration. While pinned, follow-class writes are allowed; while unpinned every
 *     follow-class write is denied, and anchor-compensation writes (which keep the viewport visually
 *     stationary) pass UNLESS they would land at the live edge or move toward it.
 *   - Self-write bookkeeping, so a scroll event caused by a write this controller approved is not
 *     misread as user movement. An edge-targeting write is also recognized by LANDING at the edge,
 *     because its exact offset can clamp/drift a few px as the column re-measures in flight.
 *   - A debug snapshot (pinned, last transition reason, last denied write) and a change subscription
 *     for the React adapter's jump-button render.
 *
 * Not for: the DOM, React, or the virtualizer (that is the adapter + `VirtualTranscript`), and not the
 * bottom-distance math - that stays in `scroll.ts` and is imported here (never re-derived).
 */

import { atBottomOf, distanceFromBottom, type ScrollGeometry } from "./scroll";

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
 *     above re-measures. Allowed while unpinned too - unless it would land at the live edge or move
 *     toward it.
 */
export type WriteClass = "follow" | "anchor-compensation";

/** The writers that may request a programmatic scroll write - a closed union so a typo'd writer label
 *  cannot silently drift past review (each names the effect that asked, for the denied-write log). */
export type ScrollWriter =
  | "append"
  | "pinned-change"
  | "post-ready"
  | "settle-loop"
  | "total-size"
  | "virtualizer";

/** The machine-readable outcome of a write request. */
export type WriteReason =
  | "pinned-allows-follow"
  | "unpinned-denies-follow"
  | "anchor-allowed"
  | "anchor-denied-lands-at-edge"
  | "anchor-denied-moves-toward-edge";

export interface DeniedWrite {
  readonly writeClass: WriteClass;
  /** The writer that was denied, so a future tug names itself instead of being silent. */
  readonly writer: ScrollWriter;
}

export interface ScrollFollowSnapshot {
  readonly pinned: boolean;
  readonly lastReason: PinReason;
  readonly lastDeniedWrite: DeniedWrite | null;
}

export interface WriteDecision {
  readonly allowed: boolean;
  readonly reason: WriteReason;
}

export interface RequestWriteOptions {
  /** Names the writer for the debug snapshot + dev log. */
  readonly writer: ScrollWriter;
  /** The scrollTop the element will hold after this write, if known, so the resulting scroll event is
   *  recognized as a self-write rather than reinterpreted as user movement. */
  readonly resultingOffset?: number;
  /** The element's two lengths at request time, as flat scalars (this path runs per re-measure at
   *  streaming rate - no geometry literal per call). With `resultingOffset` they let the controller
   *  (a) deny an unpinned anchor-compensation that would land at the live edge and (b) recognize a
   *  clamped edge landing as a self-write. */
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
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
   *  unattributed upward move, and re-pins on a genuine user arrival at the bottom. */
  scrolled(geo: ScrollGeometry): void;
  /** An explicit re-pin command: the jump-to-bottom affordance or a prompt submit. Re-pins from anywhere. */
  repin(reason: "jump" | "submit"): void;
  /** Ask whether a programmatic scroll write may run, and record it for self-write recognition. */
  requestWrite(writeClass: WriteClass, options: RequestWriteOptions): WriteDecision;
}

/** Sub-pixel slack: scroll positions within this many px count as "the same place" (rounding, clamping). */
const EPSILON_PX = 1.5;

/** How many recent approved writes to remember for self-write recognition (one follow can issue
 *  several writes in a frame; a scroll event matches the newest that lands). */
const SELF_WRITE_HISTORY = 8;

/**
 * Dev-mode flag, computed ONCE at module load (this module sits on 60Hz+ scroll paths). Vitest and
 * `vite dev` set `import.meta.env.DEV`; production builds get false, so the denied-write debug state
 * and log are skipped entirely there.
 */
const DEV = (() => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
})();

/** One approved-but-not-yet-observed write. */
interface SelfWrite {
  readonly offset: number;
  /** The write targeted the live edge at request time. Its landing may clamp a few px off `offset` as
   *  the column re-measures in flight, so it is also recognized by LANDING at the (current) edge. */
  readonly targetsEdge: boolean;
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
  // The ledger of approved writes whose scroll events have not landed yet, so our own movement is not
  // reinterpreted as the user's. A short ring (not a single slot) because one follow can issue several
  // writes in a frame whose landing offset drifts, and the coalesced scroll event matches only one.
  const selfWrites: SelfWrite[] = [];
  // Writers already named in the dev log for the current unpinned span, so each is warned about at most
  // once (a denied follow write is EXPECTED while reading; we just want the writer named, not a flood).
  const warnedWriters = new Set<ScrollWriter>();

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setPinned = (next: boolean, reason: PinReason): void => {
    if (pinned === next) {
      return;
    }
    pinned = next;
    lastReason = reason;
    if (pinned) {
      // Fresh pinned state: the per-span dev-log dedup, the stale last denial, and any leftover ledger
      // entries all belonged to the unpinned span that just ended.
      warnedWriters.clear();
      lastDeniedWrite = null;
      selfWrites.length = 0;
    }
    notify();
  };

  const gesture = (direction: "up" | "down"): void => {
    // Upward is the whole point: unpin synchronously, with no position precondition and no intent
    // window. Downward needs no handling here - a deliberate return is recognized by the scroll event
    // actually ARRIVING at the bottom (`scrolled`), which works for wheel, touch, keyboard, and
    // scrollbar alike; residual self-writes landing there are filtered by the ledger instead.
    if (direction !== "up" || !pinned) {
      return;
    }
    // The upward input supersedes any in-flight mid-column write. Edge-targeting writes are kept: they
    // were approved while pinned, their scroll event is already queued and will land AT the bottom, and
    // without ledger recognition that landing would be misread as a deliberate user return (re-pinning
    // right through the flick - the regression spec 3 guards).
    for (let i = selfWrites.length - 1; i >= 0; i -= 1) {
      if (!selfWrites[i]?.targetsEdge) {
        selfWrites.splice(i, 1);
      }
    }
    setPinned(false, "user-gesture-up");
  };

  const scrolled = (geo: ScrollGeometry): void => {
    // Self-write recognition FIRST: a scroll event that lands where a write we approved said it would
    // (or at the live edge, for an edge-targeting write whose exact offset clamped in flight) is our
    // own movement - consume it and any older, superseded entries, advance the baseline, change nothing.
    // Indexed loop, no closure: this runs per scroll event (60Hz+).
    let matched = -1;
    for (let i = 0; i < selfWrites.length; i += 1) {
      const entry = selfWrites[i] as SelfWrite;
      if (
        Math.abs(geo.scrollTop - entry.offset) <= EPSILON_PX ||
        (entry.targetsEdge && atBottomOf(geo))
      ) {
        matched = i;
        break;
      }
    }
    if (matched !== -1) {
      selfWrites.splice(0, matched + 1);
      lastScrollTop = geo.scrollTop;
      return;
    }

    // The first observed scroll only sets the baseline - direction is undefined without a prior sample.
    if (lastScrollTop === null) {
      lastScrollTop = geo.scrollTop;
      return;
    }

    // Unmatched = the user moved the viewport. Scroll events arrive in order, so every write recorded
    // before this event is superseded - flush the ledger, or a stale offset could later swallow a
    // genuine scrollbar/keyboard scroll and suppress the unpin/re-pin logic.
    selfWrites.length = 0;

    const previous = lastScrollTop;
    lastScrollTop = geo.scrollTop;

    const movedUp = geo.scrollTop < previous - EPSILON_PX;
    const movedDown = geo.scrollTop > previous + EPSILON_PX;

    if (pinned) {
      // The catch-all unpin: an unattributed UPWARD scroll that leaves the bottom band (keyboard
      // PageUp, touch drag, a scrollbar where one is shown). Both conditions matter: a follow write
      // momentarily trailing a fast stream moves DOWN (never trips this), and a sub-band nudge that
      // stays at the live edge is still "at bottom", not a read.
      if (movedUp && !atBottomOf(geo)) {
        setPinned(false, "unattributed-scroll-up");
      }
      return;
    }

    // Unpinned: re-pin on a genuine user arrival at the bottom - moving DOWN and ending within the
    // tolerance band. Input-agnostic (wheel, touch, keyboard End/PageDown, scrollbar drag). A residual
    // follow self-scroll cannot reach here (consumed by the ledger above), and upward transit through
    // the band never satisfies `movedDown`.
    if (movedDown && atBottomOf(geo)) {
      setPinned(true, "user-return-to-bottom");
    }
  };

  const repin = (reason: "jump" | "submit"): void => {
    setPinned(true, reason);
  };

  const requestWrite = (
    writeClass: WriteClass,
    writeOptions: RequestWriteOptions,
  ): WriteDecision => {
    const { writer, resultingOffset, scrollHeight, clientHeight } = writeOptions;
    // Whether this write would land at the live edge - computable only when the caller supplied its
    // geometry, and meaningful only when the column overflows (jsdom reports 0/0 lengths; no overflow
    // means there is no edge to land at).
    const landsAtEdge =
      resultingOffset !== undefined &&
      scrollHeight !== undefined &&
      clientHeight !== undefined &&
      scrollHeight > clientHeight &&
      atBottomOf({ scrollHeight, clientHeight, scrollTop: resultingOffset });
    const movesTowardEdge =
      writeClass === "anchor-compensation" &&
      !pinned &&
      resultingOffset !== undefined &&
      scrollHeight !== undefined &&
      clientHeight !== undefined &&
      scrollHeight > clientHeight &&
      lastScrollTop !== null &&
      distanceFromBottom({ scrollHeight, clientHeight, scrollTop: resultingOffset }) <
        distanceFromBottom({ scrollHeight, clientHeight, scrollTop: lastScrollTop }) - EPSILON_PX;

    if (writeClass === "follow" && !pinned) {
      if (DEV) {
        lastDeniedWrite = { writeClass, writer };
        if (!warnedWriters.has(writer)) {
          warnedWriters.add(writer);
          // Structured, dev-only: names the writer that tried to follow while the user was reading, so
          // a future regression is attributable instead of a silent tug.
          console.warn("[scroll-follow] denied a follow write while unpinned", {
            writer,
            writeClass,
          });
        }
      }
      return { allowed: false, reason: "unpinned-denies-follow" };
    }

    // An unpinned anchor-compensation that would land at the live edge is a follow in disguise (the
    // virtualizer's `anchorTo` lags a render behind a synchronous unpin and can request one): deny it.
    // Letting it run would yank the reader to the bottom and then read as a deliberate return. No dev
    // warn - this denial is EXPECTED during the one-render lag window; the reason string names it.
    if (writeClass === "anchor-compensation" && !pinned && landsAtEdge) {
      if (DEV) {
        lastDeniedWrite = { writeClass, writer };
      }
      return { allowed: false, reason: "anchor-denied-lands-at-edge" };
    }

    // A real anchor compensation keeps the user's viewport visually stationary. If the requested
    // landing would shrink bottom-distance while unpinned, it is still a downward tug even when it does
    // not reach the edge.
    if (movesTowardEdge) {
      if (DEV) {
        lastDeniedWrite = { writeClass, writer };
      }
      return { allowed: false, reason: "anchor-denied-moves-toward-edge" };
    }

    // Approved: record the landing so the resulting scroll event reads as a self-write.
    if (resultingOffset !== undefined) {
      selfWrites.push({ offset: resultingOffset, targetsEdge: landsAtEdge });
      if (selfWrites.length > SELF_WRITE_HISTORY) {
        selfWrites.shift();
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

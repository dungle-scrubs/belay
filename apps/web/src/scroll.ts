/**
 * Transcript scroll math (D-086). The transcript well uses a normal top-down column (content starts
 * at the top and grows downward), so "at the live edge" is the distance from the bottom, not
 * `scrollTop === 0`. These pure helpers own that math so it's unit-tested without a DOM and the App
 * effects and the jump-to-bottom affordance can't drift on the definition of "at bottom".
 */

/** Px tolerance for "at the live edge" - sub-pixel rounding and a row's worth of slack count as bottom. */
export const AT_BOTTOM_TOLERANCE = 40;

/** A scrollable element's geometry (the three numbers the math needs). */
export interface ScrollGeometry {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
}

/** Distance (px) from the live bottom edge: 0 when pinned, growing as the user scrolls up. */
export function distanceFromBottom(geo: ScrollGeometry): number {
  return geo.scrollHeight - geo.clientHeight - geo.scrollTop;
}

/**
 * True when the viewport is at (or within tolerance of) the live bottom edge. Content shorter than
 * the viewport (`scrollHeight <= clientHeight`, scrollTop 0) reads as at-bottom, so a short session
 * follows new output and shows no jump-to-bottom affordance.
 */
export function atBottomOf(geo: ScrollGeometry, tolerance = AT_BOTTOM_TOLERANCE): boolean {
  return distanceFromBottom(geo) < tolerance;
}

/**
 * Whether an app-owned AUTO-follow scroll may run: only while pinned at the live edge (D-001). This is
 * the single named gate for "the transcript follows new content" - every automatic bottom-follow
 * (initial reveal, pinned streaming, append, measured-size growth) checks it, and a deferred follow
 * frame re-checks it at fire time, so manual upward scrolling is never fought. Explicit jump-to-bottom
 * is a SEPARATE path (it re-pins first), not gated here.
 */
export function mayAutoFollow(pinned: boolean): boolean {
  return pinned;
}

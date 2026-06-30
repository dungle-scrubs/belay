/**
 * Platform `Mod` normalization + chord matching (plan 07). "Mod" is the primary app modifier - `Cmd`
 * on macOS, `Ctrl` on Windows/Linux - so every Trevor binding is written once as e.g. `Mod+K` and
 * matched against the live platform. Pure + injectable (`mac` is a parameter), so the router decision
 * is unit-tested without a real `navigator`.
 */

/** macOS uses Cmd as the primary modifier; Windows/Linux use Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  // `platform` is the most reliable where present; fall back to the UA string.
  return /mac/i.test(navigator.platform || navigator.userAgent || "");
}

/** Formats a canonical chord for display: `Mod+Shift+\` -> `⌘⇧\` (macOS) / `Ctrl+Shift+\` (else). */
export function formatChord(keys: string, mac = isMac()): string {
  if (mac) {
    return keys.replace("Mod", "⌘").replace("Shift", "⇧").replace("Alt", "⌥").replace(/\+/g, "");
  }
  return keys.replace("Mod", "Ctrl");
}

/** A normalized key chord, e.g. `Mod+Shift+\` -> `{ mod:true, shift:true, alt:false, key:"\\" }`. */
export interface Chord {
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** The non-modifier key, normalized: a single char is lowercased; named keys (Enter, Escape) kept. */
  readonly key: string;
}

/** The subset of a KeyboardEvent the matcher reads (so a plain object can stand in for tests). */
export interface KeyChordEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Parses a canonical chord string (`Mod+Shift+K`). Modifiers are `Mod`, `Shift`, `Alt`; the last
 *  segment is the key. */
export function parseChord(chord: string): Chord {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  return {
    mod: parts.includes("Mod"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
    key: normalizeKey(key),
  };
}

/**
 * Whether a key event matches a chord on this platform. `Mod` maps to Cmd (mac) / Ctrl (else); the
 * OTHER primary modifier must be absent (so `Ctrl+K` on macOS does NOT match `Mod+K`), and Shift/Alt
 * must match exactly so a `Mod+K` binding never also fires on `Mod+Shift+K`.
 */
export function matchesChord(event: KeyChordEvent, chord: Chord, mac = isMac()): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const otherMod = mac ? event.ctrlKey : event.metaKey;
  return (
    mod === chord.mod &&
    !otherMod &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    normalizeKey(event.key) === chord.key
  );
}

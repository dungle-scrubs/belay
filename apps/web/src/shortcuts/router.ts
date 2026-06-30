import { useEffect, useRef } from "react";
import { isMac, type KeyChordEvent, matchesChord } from "./keys";
import { PARSED_SHORTCUTS, type ShortcutId } from "./registry";

/** The platform is fixed for a session, so resolve `Mod` once instead of per keystroke. */
const MAC = isMac();

/**
 * The central shortcut router (plan 07). A single `window` keydown listener owns every Trevor `Mod`
 * binding, so a key can only affect the FRONTMOST eligible surface - never a surface behind a modal,
 * menu, or panel (the bug class this plan kills). The decision is the pure {@link routeKey}; the hook
 * {@link useShortcutRouter} wires it to the window + the App-owned handlers.
 *
 * Surface model (highest first): a frontmost overlay (command palette, resume/worktree/archive chooser,
 * model chooser, prompt editor) owns its own keys, so while one is open the GLOBAL app shortcuts are
 * suppressed. `submit` is COMPOSER-owned: it fires only while an editable field has focus. Everything
 * else is a global app shortcut. `Mod` chords never collide with text typing, so they fire even with the
 * composer focused (the focus guard exists for any future bare-key bindings + the composer-only submit).
 */

export interface RouterContext {
  /** macOS (Cmd is `Mod`) vs not (Ctrl). */
  readonly mac: boolean;
  /** A frontmost overlay owns keys -> the global app shortcuts below it are suppressed. */
  readonly overlayOpen: boolean;
  /** Focus is in an editable text field (the composer/editor textarea) - required for `submit`. */
  readonly editableFocused: boolean;
}

/** Which shortcut a key event fires, or null if none owns it in the current context. */
export function routeKey(event: KeyChordEvent, ctx: RouterContext): ShortcutId | null {
  for (const s of PARSED_SHORTCUTS) {
    if (!matchesChord(event, s.chord, ctx.mac)) {
      continue;
    }
    if (s.id === "submit") {
      // Composer-owned: only when an editable field has focus, and never behind a frontmost overlay.
      return ctx.editableFocused && !ctx.overlayOpen ? "submit" : null;
    }
    // A global app shortcut: suppressed while a frontmost overlay owns the keys.
    return ctx.overlayOpen ? null : s.id;
  }
  return null;
}

/** Whether an element is an editable text target a bare key would type into (the focus guard).
 *  `isContentEditable` is the computed truth in browsers; the `contentEditable` property is the
 *  attribute reflection (and the only one jsdom reports), so check both. */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) {
    return false;
  }
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    return true;
  }
  const editable = el as HTMLElement;
  return editable.isContentEditable === true || editable.contentEditable === "true";
}

export interface ShortcutRouterOptions {
  /** A frontmost overlay (modal/menu/chooser/editor) is open, so global shortcuts are suppressed. */
  readonly overlayOpen: boolean;
  /** The action per shortcut id; an absent id is simply not handled. */
  readonly handlers: Partial<Record<ShortcutId, () => void>>;
  /**
   * The global Escape action (cancel a run / clear the draft / flush queued steer). Escape is not a
   * `Mod` chord, so it routes here instead of through {@link routeKey}: this single window listener owns
   * it, and the composer's Vim layer (which `stopPropagation`s a consumed key) suppresses it before it
   * reaches here. The handler owns its own `preventDefault` + overlay precedence (via `escapeAction`).
   */
  readonly onEscape?: (event: KeyboardEvent) => void;
}

/**
 * Attaches the one window keydown listener and dispatches matched shortcuts to their handlers,
 * `preventDefault`ing + `stopPropagation`ing only when the router owns the key. Escape is forwarded to
 * `onEscape` (its precedence lives in the App's pure `escapeAction`). Reads the latest options through a
 * ref so the listener is registered once and never goes stale.
 */
export function useShortcutRouter(options: ShortcutRouterOptions): void {
  const ref = useRef(options);
  ref.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { overlayOpen, handlers, onEscape } = ref.current;
      if (event.key === "Escape") {
        onEscape?.(event);
        return;
      }
      const id = routeKey(event, {
        mac: MAC,
        overlayOpen,
        editableFocused: isEditableTarget(document.activeElement),
      });
      if (!id) {
        return;
      }
      const handler = handlers[id];
      if (!handler) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

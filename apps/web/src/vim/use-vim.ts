import { type KeyboardEvent, type RefObject, useCallback, useRef, useState } from "react";
import { handleVimKey, INITIAL_VIM_STATE, type VimKey, type VimState } from "./controller";
import type { VimMode } from "./mode";

/**
 * The React adapter for the pure Vim {@link handleVimKey} controller (plan 06, M6). It binds the
 * controller to a textarea ref + the host-owned `enabled` preference, holds the mode/anchor/pending
 * state, and exposes:
 *   - `onKeyDown(event)` -> boolean: read the textarea snapshot, run the controller, apply the result
 *     (selection always; value via a native input event so the controlled composer's onChange updates
 *     the draft through its token reconciliation), and return whether Vim CONSUMED the key. The caller
 *     stops its own handling when true; when false the key flows on natively (insert typing, Enter
 *     submit, the slash menu, history recall, IME).
 *   - `onFocus()`: reset to insert, so a freshly focused Vim-enabled prompt always types normally.
 *   - `mode`: for the indicator (always `insert` when disabled, so the surface reads off cleanly).
 *
 * Surface-agnostic: the inline composer and the full-surface editor both attach the same hook to their
 * textarea, so Vim mode is identical on both (D-007).
 *
 * Conflict precedence (plan 06, M7), highest first:
 *   1. Composer token-delete (D-092) - Backspace/Delete adjacent to an image/paste token.
 *   2. The slash command menu while open - it owns arrows/Enter/Escape, so the composer SUSPENDS the
 *      Vim layer while `menuOpen` (a `/`-draft is typed in insert anyway).
 *   3. This Vim layer - in insert only Escape (-> normal); in normal/visual the motions/edits.
 *   4. App's Enter-submit + Up/Down history (insert mode, where Vim yields).
 *   5. The global Escape (cancel a turn / clear the draft): reached only by a SECOND Escape, since the
 *      first enters normal mode and is consumed (stopPropagation). The full-surface editor instead
 *      consumes the first Escape for normal-mode and closes on the second; Cmd/Ctrl-Enter always
 *      confirms there. The `!` shell lane is submit-time routing, not a keydown, so it never conflicts.
 */

export interface VimController {
  readonly enabled: boolean;
  readonly mode: VimMode;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly onFocus: () => void;
}

/** Sets a controlled textarea's value through the native setter + an input event, so React's onChange
 *  (the composer's draft reconciliation) runs - direct `.value =` would be clobbered on the next render. */
function applyValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useVim(
  ref: RefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
): VimController {
  const [state, setState] = useState<VimState>(INITIAL_VIM_STATE);
  // The controller is stateless-per-key but threads {mode,pending,anchor}; a ref keeps the latest so a
  // burst of keydowns in one frame never reads a stale (not-yet-committed) state.
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: VimState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!enabled) {
        return false;
      }
      const el = ref.current;
      if (!el) {
        return false;
      }
      // An IME composition keydown must reach the textarea untouched.
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        return false;
      }
      const key: VimKey = {
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
      };
      const result = handleVimKey(
        stateRef.current,
        { value: el.value, selStart: el.selectionStart ?? 0, selEnd: el.selectionEnd ?? 0 },
        key,
      );
      commit(result.state);
      if (!result.handled) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      if (result.value !== undefined && result.value !== el.value) {
        applyValue(el, result.value);
      }
      el.setSelectionRange(result.selStart, result.selEnd);
      return true;
    },
    [enabled, ref, commit],
  );

  const onFocus = useCallback(() => commit(INITIAL_VIM_STATE), [commit]);

  return { enabled, mode: enabled ? state.mode : "insert", onKeyDown, onFocus };
}

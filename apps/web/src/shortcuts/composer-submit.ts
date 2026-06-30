import { isMac, type KeyChordEvent, matchesChord } from "./keys";
import { shortcutChord } from "./registry";

/**
 * Whether a composer keydown should send the message (plan 07 M6). Submit is composer-owned: this only
 * runs from the composer's own keydown, so focus is implicit. Two ways to send:
 *   - plain `Enter` with no modifiers (the default single-press send); `Shift+Enter` stays a newline,
 *     and any other modifier+Enter is left alone, so it never steals a surface chord;
 *   - the registry `submit` chord `Mod+Enter` (`Cmd+Enter` macOS / `Ctrl+Enter` else) - the explicit,
 *     documented send that also works where a bare Enter inserts a newline.
 * The chord is read from the registry so the binding stays single-sourced. Validity (non-empty draft or
 * attachments) is enforced downstream by the form's onSubmit, so this is purely "is this a send key".
 */
export function isComposerSubmitKey(event: KeyChordEvent, mac = isMac()): boolean {
  if (event.key !== "Enter") {
    return false;
  }
  const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  return plain || matchesChord(event, shortcutChord("submit"), mac);
}

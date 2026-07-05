import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

/**
 * The supervisor's native folder-pick boundary (plan 44.1) - the ONE place a native OS dialog is
 * popped to choose a project folder. It mirrors the host clipboard writer's injectable seam: platform
 * selection + the real dialog stay behind this interface, and a test swaps in a fake so no real dialog
 * ever fires. It is best-effort and LOCAL-ONLY by construction: the supervisor is an ensured local
 * service, so the dialog opens on this machine's display; on a non-darwin platform (no supported
 * dialog) it degrades to `cancelled`, and the browser (44.2) then falls back to paste-a-path.
 */

const execFileAsync = promisify(execFile);

/** The result of a folder pick: the chosen POSIX path, or `cancelled` (user dismissed / unavailable). */
export interface FolderPickOutcome {
  readonly path?: string;
  readonly cancelled: boolean;
}

/** The seam every folder pick crosses; the real picker shells out, a test picker returns canned data. */
export interface FolderPicker {
  pick(): Promise<FolderPickOutcome>;
}

// AppleScript that pops the native folder chooser and prints the chosen directory as a POSIX path.
// A user cancel exits non-zero (osascript error -128), which we read as `cancelled`.
const CHOOSE_FOLDER_SCRIPT =
  'POSIX path of (choose folder with prompt "Choose a project folder to open in Trevor")';

/** The real picker: `osascript choose folder` on macOS; `cancelled` on any other platform or failure. */
class OsascriptFolderPicker implements FolderPicker {
  async pick(): Promise<FolderPickOutcome> {
    // The local-only guard: only macOS has a supported native dialog here. Anything else is unavailable.
    if (platform() !== "darwin") {
      return { cancelled: true };
    }
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", CHOOSE_FOLDER_SCRIPT]);
      // `POSIX path of` yields a trailing-slashed directory; normalize to a canonical no-trailing-slash
      // root (but keep "/" itself) so it matches how the launcher stores project roots.
      const path = stdout.trim().replace(/\/+$/, "") || "/";
      return stdout.trim() ? { cancelled: false, path } : { cancelled: true };
    } catch {
      // Non-zero exit: the user cancelled (-128) or no GUI/osascript is available. Either way, no path.
      return { cancelled: true };
    }
  }
}

const realFolderPicker: FolderPicker = new OsascriptFolderPicker();
let activePicker: FolderPicker = realFolderPicker;

/** Swaps the active folder picker (tests inject a fake so no real dialog is popped). */
export function setFolderPicker(picker: FolderPicker): void {
  activePicker = picker;
}

/** Restores the real osascript-backed picker (afterEach in tests). */
export function resetFolderPicker(): void {
  activePicker = realFolderPicker;
}

/** The picker the supervisor currently picks through. */
export function getFolderPicker(): FolderPicker {
  return activePicker;
}

/** The public entry the daemon wires as its `pickFolder` collaborator: pick through the active seam. */
export function pickProjectFolder(): Promise<FolderPickOutcome> {
  return getFolderPicker().pick();
}

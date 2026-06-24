import { execFile } from "node:child_process";

/**
 * Opens a file in the local editor on the host's machine. The browser requests
 * this via the `editor.open` side-channel event; the host (which shares the
 * user's machine) runs the editor's CLI.
 *
 * Defaults to `zed`; override with the `TREVOR_EDITOR` env var (a binary name on
 * PATH or an absolute path). The target is passed as a single `path:line:column`
 * argument - Zed's accepted form. The path is passed directly to `execFile` (no
 * shell), so it can never be interpreted as a command.
 */
export function openInEditor(path: string, line?: number, column?: number): Promise<void> {
  const editor = process.env.TREVOR_EDITOR?.trim() || "zed";
  const target = line != null ? `${path}:${line}${column != null ? `:${column}` : ""}` : path;

  return new Promise((resolve, reject) => {
    execFile(editor, [target], { timeout: 10_000 }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

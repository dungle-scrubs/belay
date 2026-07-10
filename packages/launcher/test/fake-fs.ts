import type { LauncherFs } from "../src/fs";

/**
 * The shared in-memory {@link LauncherFs} for launcher tests, so an interface change is a one-file
 * edit instead of a per-test-file tax (plan 58.8's `directoryExists` addition touched six private
 * copies). `present` pre-marks paths `exists` should report without content (e.g. `.git` markers).
 * A directory "exists" when any stored or marked path lies under it, mirroring how tests seed
 * project roots. The backing `files` map is exposed for direct seeding/assertions.
 */
export function fakeLauncherFs(
  present: Iterable<string> = [],
): LauncherFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const marks = new Set(present);
  return {
    files,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => void files.set(path, content),
    exists: (path) => files.has(path) || marks.has(path),
    directoryExists: (path) => [...files.keys(), ...marks].some((k) => k.startsWith(`${path}/`)),
    remove: (path) => {
      files.delete(path);
      marks.delete(path);
    },
  };
}

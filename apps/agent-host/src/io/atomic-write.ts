/**
 * Responsible for: the ONE temp-write + rename atomic file write the host's file-backed stores share
 * (admission resources, docs corpora, JSON config files, CLAUDE.md migration writes). Write-then-rename
 * so a concurrent reader or a mid-write crash never observes a TRUNCATED file - a torn read would
 * parse-fail and silently drop state. rename is atomic on one filesystem; the per-process tmp name
 * keeps concurrent processes from colliding on the staging file (per-path serialization, where needed,
 * is the caller's concern - e.g. the admission mutex).
 * Not for: read/parse/degrade policy (boot/config.ts) or what content to write - callers own both.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Atomically write `content` (UTF-8) to `path`, creating the parent directory as needed. Returns the
 * byte length written (some callers account bytes).
 */
export function writeFileAtomic(path: string, content: string): number {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return Buffer.byteLength(content);
}

/** The minimal async filesystem capability the injected-fs variant needs. */
export interface AtomicWriteFs {
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * The injected-filesystem variant of {@link writeFileAtomic} for async stores that abstract their fs
 * for tests (the docs corpus store). Same temp-write + rename contract over the caller's capabilities;
 * directory creation stays with the caller (its fs owns mkdir semantics).
 */
export async function writeFileAtomicVia(
  fs: AtomicWriteFs,
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, path);
}

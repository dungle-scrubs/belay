import { glob } from "node:fs/promises";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { SKIP_DIRS } from "./shared";

/**
 * The one workspace file-walk both search tools (glob, grep) share: iterate the entries matching
 * a glob under WORKSPACE_ROOT, skipping the never-descended SKIP_DIRS. It owns the
 * `glob(pattern, { cwd })` + SKIP_DIRS filter that used to be copied into each tool, so a change
 * to the skip policy or the cwd contract lands in one place. The per-tool work - collecting paths
 * (glob) or reading + line-scanning each file (grep) - stays with the tool.
 */
export async function* walkWorkspace(pattern: string): AsyncIterable<string> {
  for await (const entry of glob(pattern, { cwd: WORKSPACE_ROOT })) {
    if (SKIP_DIRS.test(`/${entry}/`)) {
      continue;
    }
    yield entry;
  }
}

/**
 * Walks the workspace for `pattern` and collects `select(entry)` for each non-skipped entry, up to
 * `max` collected items. Returns the items and whether MORE existed past the cap, so a caller can
 * say "first N (more exist), narrow the pattern" honestly rather than implying the slice is the
 * whole set. `select` returning undefined skips an entry without counting it. This is the
 * predicate + max iterator glob is built on; grep, which needs async per-file scanning under its
 * own match/file caps, walks `walkWorkspace` directly.
 */
export async function collectWorkspace<T>(
  pattern: string,
  max: number,
  select: (entry: string) => T | undefined,
): Promise<{ readonly items: T[]; readonly truncated: boolean }> {
  const items: T[] = [];
  for await (const entry of walkWorkspace(pattern)) {
    const selected = select(entry);
    if (selected === undefined) {
      continue;
    }
    // Reaching the cap with another match still to come means this is an incomplete slice:
    // record it and stop, so `truncated` distinguishes "exactly max" from "more exist".
    if (items.length >= max) {
      return { items, truncated: true };
    }
    items.push(selected);
  }
  return { items, truncated: false };
}

import { resolve, sep } from "node:path";

/**
 * The directory that write/edit/glob/grep are confined to. Point the agent at a
 * target repo with TREVOR_WORKSPACE; defaults to the host's working directory.
 * Confinement is a path-escape guard (no `../` or absolute path may leave the
 * root), the write-side analogue of the bash safety floor - not a sandbox.
 */
export const WORKSPACE_ROOT = resolve(process.env.TREVOR_WORKSPACE ?? process.cwd());

/** Resolves a path inside the workspace, or throws if it escapes the root. */
export function confine(path: string): string {
  const resolved = resolve(WORKSPACE_ROOT, path);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + sep)) {
    throw new Error(`path escapes workspace root (${path})`);
  }
  return resolved;
}

/**
 * The host's single owner of the "is this pid a live process?" check, shared by the file-based
 * advisory locks/leases that reap a crashed owner (the cwd lock, the admission store). `kill(pid, 0)`
 * signals nothing but validates existence; an `EPERM` means the process exists but is owned by another
 * user, so it counts as ALIVE (the conservative choice - a lock/lease is never reclaimed from a process
 * that is actually still running).
 *
 * (Distinct from the launcher's `apps/trevor-cli/src/platform.ts` variant, which treats EPERM as not-
 * ours/dead for a different purpose; the locks deliberately keep the conservative alive-on-EPERM
 * semantics, so they live here rather than sharing that one.)
 *
 * Responsible for: the pid-liveness check (`processAlive`) the host's file locks/leases share.
 * Not for: the launcher's not-ours/dead EPERM variant - apps/trevor-cli/src/platform.ts.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

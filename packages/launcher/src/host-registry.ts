import { join } from "node:path";
import { type LauncherFs, readJson, writeJson } from "./fs";

/**
 * Per-project host lifecycle bookkeeping for the launcher (D-085): ownership records (which pid is
 * answering which session, from where), the reuse/stale/spawn decision, and a per-session lock so two
 * concurrent `trevor` launches can't both spawn a host for the same project. Pure over an injected
 * `LauncherFs` + small capability callbacks (process-liveness, clock), so every branch is unit-tested
 * without real processes.
 */

/** One launcher-owned host: the answering pid, its session + project root, the command, and birth time. */
export interface HostRecord {
  readonly sessionId: string;
  readonly pid: number;
  readonly root: string;
  readonly command: string;
  readonly startedAt: string;
}

const hostsPath = (home: string): string => join(home, "hosts.json");
const lockPath = (home: string, sessionId: string): string =>
  join(home, "locks", `${sessionId}.lock`);

/** The persisted session→host record map, or {} when none / unreadable. */
export function loadHosts(fs: LauncherFs, home: string): Record<string, HostRecord> {
  const raw = readJson<Record<string, HostRecord>>(fs, hostsPath(home), {});
  const out: Record<string, HostRecord> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value.pid === "number" && typeof value.sessionId === "string") {
      out[key] = value;
    }
  }
  return out;
}

/** Records (or replaces) the host owning a session. */
export function recordHost(fs: LauncherFs, home: string, record: HostRecord): void {
  const hosts = loadHosts(fs, home);
  hosts[record.sessionId] = record;
  writeJson(fs, hostsPath(home), hosts);
}

/** Drops the host record for a session (a stale/dead host being replaced). */
export function removeHost(fs: LauncherFs, home: string, sessionId: string): void {
  const hosts = loadHosts(fs, home);
  if (hosts[sessionId]) {
    delete hosts[sessionId];
    writeJson(fs, hostsPath(home), hosts);
  }
}

/**
 *  - reuse         : a recorded host is alive AND answering this session - open the tab against it,
 *  - replace-stale : a record exists but its process is dead, or alive yet not answering the session
 *                    (a leftover record) - drop it and spawn,
 *  - spawn         : no record - start a fresh host.
 */
export type HostAction = "reuse" | "replace-stale" | "spawn";

export function decideHostAction(
  record: HostRecord | null,
  deps: { readonly processAlive: (pid: number) => boolean; readonly hostPresent: boolean },
): HostAction {
  if (!record) {
    return "spawn";
  }
  if (!deps.processAlive(record.pid)) {
    return "replace-stale";
  }
  return deps.hostPresent ? "reuse" : "replace-stale";
}

interface LockFile {
  readonly pid: number;
  readonly acquiredAt: string;
}

export type LockResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly heldBy: number };

/**
 * Acquires the per-session launch lock. A live holder (a concurrent `trevor` mid-launch for the same
 * project) blocks - the caller backs off and reuses whatever that launch produces, so two launches
 * never both spawn. A lock left by a DEAD process is stale and taken over. Our own held lock re-acquires.
 */
export function acquireLock(
  fs: LauncherFs,
  home: string,
  sessionId: string,
  deps: {
    readonly pid: number;
    readonly now: string;
    readonly processAlive: (pid: number) => boolean;
  },
): LockResult {
  const path = lockPath(home, sessionId);
  const existing = readJson<LockFile | null>(fs, path, null);
  if (existing && existing.pid !== deps.pid && deps.processAlive(existing.pid)) {
    return { acquired: false, heldBy: existing.pid };
  }
  writeJson(fs, path, { pid: deps.pid, acquiredAt: deps.now } satisfies LockFile);
  return { acquired: true };
}

/** Releases the per-session lock, but only if this process still holds it (never steals another's). */
export function releaseLock(fs: LauncherFs, home: string, sessionId: string, pid: number): void {
  const path = lockPath(home, sessionId);
  const existing = readJson<LockFile | null>(fs, path, null);
  if (existing && existing.pid === pid) {
    fs.remove(path);
  }
}

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shortHash } from "@trevor/session";
import { storagePathByName } from "@trevor/session/node-paths";
import { Data } from "effect";

/**
 * Dedicated cwd-path advisory lock (plan 01 - managed-worktree hardening). It protects a real working
 * directory as a RESOURCE against two DIFFERENT Trevor sessions mutating it at once - the hazard the
 * per-session launcher lock (keyed by sessionId) and the deterministic worktree session ids do not
 * cover when two identities resolve to the same realpath (a symlinked path, a managed worktree reached
 * via `/cd` under a fresh session, two repos aliased to one directory). The lock keys on the cwd's
 * realpath, records owner metadata + a heartbeat, and is stale-safe across crash/restart.
 *
 * Pure over injected capabilities (fs, realpath, process-liveness, clock) so every branch - acquire,
 * same-session re-take, stale takeover, conflict, refresh, release, inspect - is unit-tested without
 * real processes or a real host. The host wires the node-backed capabilities at the boundary: it
 * acquires when it becomes the session LEADER (the single mutating owner of the cwd), refreshes the
 * heartbeat on a timer, and releases on graceful stop / process exit. A standby host is a passive
 * observer and never holds the lock, so leader/standby failover within one session is unaffected.
 *
 * NOT responsible for: per-session / per-process ownership (that stays the launcher's host-registry
 * lock), worktree records (the worktree registry owns those), or repairing / mutating locks from
 * /doctor (inspection is read-only - reclaiming a stale lock happens only on the next acquire).
 */

/** Heartbeat-age (ms) beyond which a lock whose pid still appears alive is nonetheless treated as
 *  stale and reclaimable - the belt to pid-liveness's suspenders, covering pid reuse and a wedged or
 *  long-abandoned owner. Generous so a briefly-busy live leader is never stolen out from under itself. */
export const CWD_LOCK_STALE_MS = 300_000;

/** The inventory name of the state-home directory holding cwd lock files (see node-paths STORAGE_INVENTORY). */
export const CWD_LOCKS_STORAGE_NAME = "cwd-locks";

/** The owning identity stamped on a lock: the session it belongs to, the host instance, and the pid. */
export interface CwdLockOwner {
  readonly sessionId: string;
  readonly hostId: string;
  readonly pid: number;
}

/** The on-disk lock record: the realpath it guards plus the owner metadata and heartbeat. */
export interface CwdLockFile extends CwdLockOwner {
  /** The normalized realpath of the guarded working directory (the resource identity). */
  readonly cwd: string;
  /** ISO time this owner took the lock (reset on a genuine handover, preserved on a same-process refresh). */
  readonly acquiredAt: string;
  /** ISO time of the owner's most recent heartbeat (drives heartbeat-age staleness). */
  readonly heartbeatAt: string;
}

/** A lock record enriched with the live facts /doctor and conflict messages read off it. */
export interface CwdLockOwnerInfo extends CwdLockFile {
  /** Milliseconds since the owner's last heartbeat (never negative). */
  readonly heartbeatAgeMs: number;
  /** Whether the owner pid still appears to be a running process. */
  readonly alive: boolean;
}

/** The outcome of an acquire attempt. */
export type CwdLockResult =
  | { readonly status: "acquired"; readonly file: CwdLockFile }
  | { readonly status: "reacquired"; readonly file: CwdLockFile }
  | {
      readonly status: "tookOverStale";
      readonly file: CwdLockFile;
      readonly previous: CwdLockOwnerInfo;
    }
  | { readonly status: "conflict"; readonly heldBy: CwdLockOwnerInfo };

/** A read-only snapshot of a cwd's lock state for diagnostics; never mutates. */
export interface CwdLockInspection {
  /** The realpath identity the lock is keyed on. */
  readonly cwd: string;
  /** The absolute lock-file path (caller may abbreviate for display). */
  readonly path: string;
  /** The parsed lock record, or null when no (valid) lock exists. */
  readonly file: CwdLockFile | null;
  /** Owner facts (age + liveness), or null when no lock exists. */
  readonly owner: CwdLockOwnerInfo | null;
  /** Whether the existing lock is stale (dead owner pid, or heartbeat past the staleness window). */
  readonly stale: boolean;
}

/** The minimal synchronous filesystem the lock needs, injected so the core is pure and testable. */
export interface CwdLockFs {
  /** File contents, or null when the path does not exist / is unreadable. */
  readFile(path: string): string | null;
  /** Writes the file, creating parent directories as needed. */
  writeFile(path: string, content: string): void;
  /** Removes the file (best-effort; a missing file is not an error). */
  remove(path: string): void;
}

/** The capabilities the lock core is pure over: fs, path normalization, process-liveness, and a clock. */
export interface CwdLockCaps {
  readonly fs: CwdLockFs;
  /** Resolves a path to its canonical realpath (the resource identity). */
  readonly realpath: (path: string) => string;
  /** Whether a pid currently maps to a running process. */
  readonly processAlive: (pid: number) => boolean;
  /** Current epoch-ms clock. */
  readonly now: () => number;
  /** Override the cwd-locks directory (tests); defaults to the state-home `cwd-locks` inventory path. */
  readonly dir?: string;
  /** Heartbeat-age staleness window (ms); defaults to {@link CWD_LOCK_STALE_MS}. */
  readonly staleAfterMs?: number;
}

/** The real node-backed filesystem for cwd lock files. */
export const nodeCwdLockFs: CwdLockFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  remove(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      // already gone
    }
  },
};

/** Whether a pid maps to a live process. `kill(pid, 0)` signals nothing but validates existence; an
 *  `EPERM` means the process exists but is owned by another user (still alive). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The real node-backed capabilities, with optional overrides for wiring/tests. */
export function nodeCwdLockCaps(over: Partial<CwdLockCaps> = {}): CwdLockCaps {
  return {
    fs: nodeCwdLockFs,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    },
    processAlive,
    now: () => Date.now(),
    ...over,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The realpath identity a lock is keyed on - the resource, independent of how the path was reached. */
function cwdIdentity(cwd: string, caps: CwdLockCaps): string {
  return caps.realpath(cwd);
}

function lockDir(caps: CwdLockCaps): string {
  return caps.dir ?? storagePathByName(CWD_LOCKS_STORAGE_NAME);
}

/** A readable lock-file basename: a slug of the directory name plus the path hash (which actually
 *  disambiguates), so `ls cwd-locks/` is human-scannable while two like-named dirs stay distinct. */
function lockFileName(identity: string): string {
  const base =
    identity
      .split(/[/\\]+/)
      .filter(Boolean)
      .pop() ?? "cwd";
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cwd";
  return `${slug}-${shortHash(identity)}.lock`;
}

function lockFilePath(identity: string, caps: CwdLockCaps): string {
  return join(lockDir(caps), lockFileName(identity));
}

/** Parses + validates a lock file, returning null for a missing / malformed / partial record. */
function readLockFile(caps: CwdLockCaps, path: string): CwdLockFile | null {
  const raw = caps.fs.readFile(path);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CwdLockFile>;
    if (
      parsed &&
      typeof parsed.cwd === "string" &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.hostId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.acquiredAt === "string" &&
      typeof parsed.heartbeatAt === "string"
    ) {
      return parsed as CwdLockFile;
    }
  } catch {
    // malformed - treat as no lock
  }
  return null;
}

function writeLockFile(caps: CwdLockCaps, path: string, file: CwdLockFile): void {
  caps.fs.writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

function heartbeatAgeMs(file: CwdLockFile, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(file.heartbeatAt));
}

function ownerInfo(file: CwdLockFile, nowMs: number, caps: CwdLockCaps): CwdLockOwnerInfo {
  return {
    ...file,
    heartbeatAgeMs: heartbeatAgeMs(file, nowMs),
    alive: caps.processAlive(file.pid),
  };
}

/** Stale when the owner pid is dead, OR its pid still appears alive but its heartbeat is older than the
 *  staleness window (pid reuse / a wedged or abandoned owner). Pid-liveness is the primary gate so a
 *  live, actively-heartbeating owner is never reclaimed. */
function isStale(file: CwdLockFile, nowMs: number, caps: CwdLockCaps): boolean {
  if (!caps.processAlive(file.pid)) {
    return true;
  }
  return heartbeatAgeMs(file, nowMs) > (caps.staleAfterMs ?? CWD_LOCK_STALE_MS);
}

/** Same logical owner = same SESSION: a different host/pid of the same session (leader<->standby
 *  failover, a host restart) is the same owner and re-takes the lock rather than conflicting. */
function isSameSession(file: CwdLockFile, owner: CwdLockOwner): boolean {
  return file.sessionId === owner.sessionId;
}

/** Same physical owner = same host instance AND pid: only this exact process may refresh or release. */
function isSameProcess(file: CwdLockFile, owner: CwdLockOwner): boolean {
  return file.pid === owner.pid && file.hostId === owner.hostId;
}

/**
 * Acquires the cwd advisory lock for `cwd` on behalf of `owner`. Resolves the realpath identity, then:
 * an empty slot is taken; a lock held by the SAME session is re-taken (failover / restart); a STALE
 * lock (dead owner, or heartbeat past the window) is taken over; a lock held by a DIFFERENT live
 * session is a conflict the caller must surface (it does not steal it). The written record always
 * stamps a fresh heartbeat; `acquiredAt` resets on a genuine handover and is preserved on a same-process
 * re-acquire.
 */
export function acquireCwdLock(cwd: string, owner: CwdLockOwner, caps: CwdLockCaps): CwdLockResult {
  const identity = cwdIdentity(cwd, caps);
  const path = lockFilePath(identity, caps);
  const nowMs = caps.now();
  const existing = readLockFile(caps, path);
  const write = (acquiredAt: string): CwdLockFile => {
    const file: CwdLockFile = {
      cwd: identity,
      sessionId: owner.sessionId,
      hostId: owner.hostId,
      pid: owner.pid,
      acquiredAt,
      heartbeatAt: iso(nowMs),
    };
    writeLockFile(caps, path, file);
    return file;
  };
  if (!existing) {
    return { status: "acquired", file: write(iso(nowMs)) };
  }
  if (isSameSession(existing, owner)) {
    const acquiredAt = isSameProcess(existing, owner) ? existing.acquiredAt : iso(nowMs);
    return { status: "reacquired", file: write(acquiredAt) };
  }
  if (isStale(existing, nowMs, caps)) {
    return {
      status: "tookOverStale",
      file: write(iso(nowMs)),
      previous: ownerInfo(existing, nowMs, caps),
    };
  }
  return { status: "conflict", heldBy: ownerInfo(existing, nowMs, caps) };
}

/** Why a heartbeat refresh did not happen: the lock vanished, or another owner now holds it. */
export type CwdLockRefreshMiss = "missing" | "not-owner";

/**
 * Refreshes the heartbeat on a lock this exact process still holds. Unlike {@link acquireCwdLock} it
 * never takes over: if the lock is gone or now held by someone else (a takeover happened), it reports
 * the miss instead so the caller can re-acquire or surface contention.
 */
export function refreshCwdLock(
  cwd: string,
  owner: CwdLockOwner,
  caps: CwdLockCaps,
): { readonly refreshed: boolean; readonly reason?: CwdLockRefreshMiss } {
  const identity = cwdIdentity(cwd, caps);
  const path = lockFilePath(identity, caps);
  const existing = readLockFile(caps, path);
  if (!existing) {
    return { refreshed: false, reason: "missing" };
  }
  if (!isSameProcess(existing, owner)) {
    return { refreshed: false, reason: "not-owner" };
  }
  writeLockFile(caps, path, { ...existing, heartbeatAt: iso(caps.now()) });
  return { refreshed: true };
}

/**
 * Releases the cwd lock, but only when this exact process still holds it - it never steals a lock a
 * successor (same-session or otherwise) has since taken over.
 */
export function releaseCwdLock(
  cwd: string,
  owner: CwdLockOwner,
  caps: CwdLockCaps,
): { readonly released: boolean } {
  const identity = cwdIdentity(cwd, caps);
  const path = lockFilePath(identity, caps);
  const existing = readLockFile(caps, path);
  if (existing && isSameProcess(existing, owner)) {
    caps.fs.remove(path);
    return { released: true };
  }
  return { released: false };
}

/** Reads the current lock state for a cwd without mutating it - the diagnostic surface /doctor renders. */
export function inspectCwdLock(cwd: string, caps: CwdLockCaps): CwdLockInspection {
  const identity = cwdIdentity(cwd, caps);
  const path = lockFilePath(identity, caps);
  const file = readLockFile(caps, path);
  if (!file) {
    return { cwd: identity, path, file: null, owner: null, stale: false };
  }
  const nowMs = caps.now();
  return {
    cwd: identity,
    path,
    file,
    owner: ownerInfo(file, nowMs, caps),
    stale: isStale(file, nowMs, caps),
  };
}

/** A one-line description of a lock owner for conflict messages and diagnostics. */
export function describeCwdLockOwner(info: CwdLockOwnerInfo): string {
  const ageSeconds = Math.round(info.heartbeatAgeMs / 1000);
  const liveness = info.alive ? "alive" : "no live process";
  return `host ${info.hostId.slice(0, 8)} (session ${info.sessionId}, pid ${info.pid}, ${liveness}, held since ${info.acquiredAt}, last heartbeat ${ageSeconds}s ago)`;
}

/** The operator-facing conflict explanation + the non-destructive recommended next action. */
export function cwdLockConflictMessage(cwd: string, heldBy: CwdLockOwnerInfo): string {
  return [
    `cwd ${cwd} is already owned by ${describeCwdLockOwner(heldBy)}.`,
    "Refusing to take mutating workspace ownership of the same directory from a second session.",
    "If that host is gone the lock is reclaimed automatically once it goes stale; inspect with /doctor, and only force-clear it by deleting the lock file when you are certain no host is using the directory.",
  ].join(" ");
}

/**
 * A different live session already owns the cwd. Carries the conflicting owner so callers (the
 * worktree switch / open paths) can surface owner, cwd, session, pid, and heartbeat age; the `message`
 * is the operator-facing explanation plus the safe recommended action.
 */
export class CwdLockConflict extends Data.TaggedError("CwdLockConflict")<{
  readonly cwd: string;
  readonly heldBy: CwdLockOwnerInfo;
}> {
  override get message(): string {
    return cwdLockConflictMessage(this.cwd, this.heldBy);
  }
}

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { idSlug, shortHash } from "@trevor/session";
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

/** How often the live leader refreshes its lock heartbeat. Far below {@link CWD_LOCK_STALE_MS} so an
 *  actively-running owner stays comfortably fresh while a crashed one ages into stale within minutes. */
export const CWD_LOCK_HEARTBEAT_MS = 5_000;

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

/** The real node-backed capabilities, with optional overrides for wiring/tests. The realpath probe is
 *  memoized: a workspace directory's realpath is invariant for the host's lifetime, so the per-heartbeat
 *  refresh never re-walks the path. Only successful resolutions are cached, so a path that does not yet
 *  exist resolves correctly once it appears. */
export function nodeCwdLockCaps(over: Partial<CwdLockCaps> = {}): CwdLockCaps {
  const realpathCache = new Map<string, string>();
  return {
    fs: nodeCwdLockFs,
    realpath: (path) => {
      const cached = realpathCache.get(path);
      if (cached !== undefined) {
        return cached;
      }
      try {
        const resolved = realpathSync(path);
        realpathCache.set(path, resolved);
        return resolved;
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
  return `${idSlug(base, "cwd")}-${shortHash(identity)}.lock`;
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

/** Resolves a cwd to its realpath identity, lock-file path, and current (validated) lock record - the
 *  shared preamble every acquire/refresh/release/inspect entry point starts from. */
function locateLock(
  cwd: string,
  caps: CwdLockCaps,
): { identity: string; path: string; file: CwdLockFile | null } {
  const identity = caps.realpath(cwd);
  const path = lockFilePath(identity, caps);
  return { identity, path, file: readLockFile(caps, path) };
}

/**
 * Owner facts + staleness from a SINGLE liveness probe (one `process.kill(pid, 0)` per read, not two).
 * Stale when the owner pid is dead, OR its pid still appears alive but its heartbeat is older than the
 * staleness window (pid reuse / a wedged or abandoned owner). Pid-liveness is the primary gate so a
 * live, actively-heartbeating owner is never reclaimed.
 */
function classifyLock(
  file: CwdLockFile,
  nowMs: number,
  caps: CwdLockCaps,
): { owner: CwdLockOwnerInfo; stale: boolean } {
  const alive = caps.processAlive(file.pid);
  const ageMs = heartbeatAgeMs(file, nowMs);
  const stale = !alive || ageMs > (caps.staleAfterMs ?? CWD_LOCK_STALE_MS);
  return { owner: { ...file, heartbeatAgeMs: ageMs, alive }, stale };
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
  const { identity, path, file: existing } = locateLock(cwd, caps);
  const nowMs = caps.now();
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
  const { owner: heldBy, stale } = classifyLock(existing, nowMs, caps);
  if (stale) {
    return { status: "tookOverStale", file: write(iso(nowMs)), previous: heldBy };
  }
  return { status: "conflict", heldBy };
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
  const { path, file: existing } = locateLock(cwd, caps);
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
  const { path, file: existing } = locateLock(cwd, caps);
  if (existing && isSameProcess(existing, owner)) {
    caps.fs.remove(path);
    return { released: true };
  }
  return { released: false };
}

/** Reads the current lock state for a cwd without mutating it - the diagnostic surface /doctor renders. */
export function inspectCwdLock(cwd: string, caps: CwdLockCaps): CwdLockInspection {
  const { identity, path, file } = locateLock(cwd, caps);
  if (!file) {
    return { cwd: identity, path, file: null, owner: null, stale: false };
  }
  const { owner, stale } = classifyLock(file, caps.now(), caps);
  return { cwd: identity, path, file, owner, stale };
}

/** A one-line description of a lock owner for conflict messages and diagnostics. */
export function describeCwdLockOwner(info: CwdLockOwnerInfo): string {
  const ageSeconds = Math.round(info.heartbeatAgeMs / 1000);
  const liveness = info.alive ? "alive" : "no live process";
  return `host ${info.hostId.slice(0, 8)} (session ${info.sessionId}, pid ${info.pid}, ${liveness}, held since ${info.acquiredAt}, last heartbeat ${ageSeconds}s ago)`;
}

/** The non-destructive recovery recommendation, shared by the conflict message and the /doctor
 *  finding's next action so the operator guidance has one wording. */
export const CWD_LOCK_FORCE_CLEAR_HINT =
  "only force-clear the lock file when you are certain no host is using the directory";

/** The operator-facing conflict explanation + the non-destructive recommended next action. */
export function cwdLockConflictMessage(cwd: string, heldBy: CwdLockOwnerInfo): string {
  return [
    `cwd ${cwd} is already owned by ${describeCwdLockOwner(heldBy)}.`,
    "Refusing to take mutating workspace ownership of the same directory from a second session.",
    `If that host is gone the lock is reclaimed automatically once it goes stale; inspect with /doctor, and ${CWD_LOCK_FORCE_CLEAR_HINT}.`,
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

/** How this host stands relative to the cwd lock, the way /doctor renders it. */
export type CwdLockState =
  /** No lock file: the directory is free. */
  | "unlocked"
  /** Held by this host's own session (the normal, healthy case). */
  | "held"
  /** A different, LIVE session owns it - the contention hazard this lock exists to catch. */
  | "contended"
  /** A leftover lock from a dead / abandoned owner; reclaimed on the next acquire. */
  | "stale";

/** Whether a cwd-lock state warrants a /doctor warning finding (a contended or stale lock) rather than
 *  just a fact row (held / unlocked). One owner of the warn rule so the fact and finding never drift. */
export function isCwdLockWarn(state: CwdLockState | undefined): boolean {
  return state === "contended" || state === "stale";
}

/** The redaction-safe cwd-lock projection /doctor surfaces (session id + short host + pid - no secrets;
 *  the heartbeat age is already embedded in `owner`). `owner` is a one-line description when a lock
 *  exists; absent when unlocked. */
export interface CwdLockDoctorFact {
  readonly state: CwdLockState;
  /** The lock-file path (caller may abbreviate the home prefix for display). */
  readonly path: string;
  readonly owner?: string;
}

/**
 * Classifies a cwd's lock relative to THIS host's session for the /doctor Workspace area: unlocked,
 * held (our session), stale (dead/abandoned owner), or contended (a different live session). Pure read
 * model - it inspects, never mutates.
 */
export function cwdLockDoctorFact(
  cwd: string,
  ownSessionId: string,
  caps: CwdLockCaps,
): CwdLockDoctorFact {
  const view = inspectCwdLock(cwd, caps);
  if (!view.owner) {
    return { state: "unlocked", path: view.path };
  }
  const base = { path: view.path, owner: describeCwdLockOwner(view.owner) };
  if (view.owner.sessionId === ownSessionId) {
    return { state: "held", ...base };
  }
  return { state: view.stale ? "stale" : "contended", ...base };
}

/** A one-line cwd-lock summary shared by both /doctor surfaces (the structured fact and the plaintext
 *  dump), so they never disagree on how a state reads. */
export function cwdLockSummary(lock: CwdLockDoctorFact): string {
  switch (lock.state) {
    case "unlocked":
      return "unlocked";
    case "held":
      return "held by this session";
    case "contended":
      return `contended - ${lock.owner ?? "another live session"}`;
    case "stale":
      return `stale - ${lock.owner ?? "dead owner"} (reclaimed on next acquire)`;
  }
}

/**
 * The pre-switch availability gate: returns a {@link CwdLockConflict} when a DIFFERENT live session
 * already owns the target directory, so the worktree / workspace switch is blocked before any mutating
 * host is spawned. Read-only (it inspects, never claims) - the spawned host takes the lock when it
 * becomes leader. A free directory, a stale lock, or one owned by the target's own session returns null
 * (the switch proceeds; same-session ownership is a resume, not a conflict).
 */
export function cwdSwitchConflict(
  targetCwd: string,
  targetSessionId: string,
  caps: CwdLockCaps,
): CwdLockConflict | null {
  const view = inspectCwdLock(targetCwd, caps);
  // `!view.stale` already implies the owner is live (a dead owner is stale), so it is the only liveness
  // gate needed here.
  if (view.owner && !view.stale && view.owner.sessionId !== targetSessionId) {
    return new CwdLockConflict({ cwd: view.cwd, heldBy: view.owner });
  }
  return null;
}

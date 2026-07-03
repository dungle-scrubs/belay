import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@host/io/atomic-write";
import { processAlive } from "@host/processes/process-liveness";
import { idSlug } from "@trevor/session";
import { storagePathByName } from "@trevor/session/node-paths";
import {
  type AdmissionAcquireOutcome,
  type AdmissionEstimate,
  type AdmissionOwner,
  type AdmissionPollOutcome,
  type AdmissionPriority,
  priorityRank,
  resourceKeyHash,
} from "./contract";

/**
 * The shared cross-process admission lease + queue store (plan 11 M3/M4).
 *
 * It is the capacity-N, priority-queued sibling of the capacity-1 {@link ../cwd-lock} advisory lock:
 * one JSON file per resource key holds the active holders and the waiting queue, each mutation is
 * serialized across processes by a short-lived exclusive mutex sidecar, and a stale holder (dead pid or
 * an aged-out heartbeat) is reaped by whichever client next touches the resource - so a crashed owner's
 * slot frees for the waiter behind it without a daemon. Capacity defaults to 1 per resource (D-003);
 * queued work drains in priority order (foreground first), FIFO within a class (D-004).
 *
 * Pure over injected capabilities (fs, clock, process-liveness, id + sleep), so every branch - acquire,
 * queue, drain, heartbeat, release, stale reap, refusal - is unit-tested with an in-memory fs and a
 * fake clock, no real processes. The host wires the node-backed caps and stores files under the state
 * root's `admission` inventory dir (D-006: leases are machine-local runtime state, alongside cwd-locks).
 *
 * NOT responsible for: WHERE admission is acquired (the provider integration owns that), the token
 * ESTIMATE itself (the caller computes it), or status presentation (the protocol + web own that).
 *
 * Responsible for: the durable per-resource lease + queue files - acquire/poll/heartbeat/release,
 * stale reaping, priority drain, and mutex-serialized cross-process mutation.
 * Not for: where admission is acquired, token estimates, or status presentation (see above).
 */

/** Heartbeat-age (ms) past which a holder/waiter whose pid still appears alive is treated as stale and
 *  reclaimable - the belt to pid-liveness's suspenders (pid reuse, a wedged owner). Generous so a busy
 *  but live generation is never reaped out from under itself. */
export const ADMISSION_STALE_MS = 120_000;

/** How often an ACTIVE holder refreshes its heartbeat - a quarter of the stale window, so a long
 *  generation stays comfortably fresh (~4 refreshes per window) without a tight RMW loop. */
export const ADMISSION_HEARTBEAT_MS = 30_000;

/** How often a QUEUED waiter polls for a freed slot. Fast (sub-second) so a foreground turn picks up a
 *  background turn's released slot promptly; each poll doubles as the waiter's heartbeat, so a snappy
 *  poll costs nothing in safety (and the per-resource mutex keeps the file I/O cheap + local). */
export const ADMISSION_POLL_MS = 500;

/** Default active capacity per local resource (D-003): one generation/reload at a time unless config
 *  raises it for a runtime that is proven to handle more. */
export const ADMISSION_DEFAULT_CAPACITY = 1;

/** The inventory name of the state-home dir holding admission lease/queue files (node-paths). */
export const ADMISSION_STORAGE_NAME = "admission";

/** A mutex sidecar older than this was orphaned by a holder that crashed mid-RMW; break it. */
const MUTEX_STALE_MS = 5_000;
/** Max wall time (ms) to wait for the per-resource mutex before declaring the store unavailable. Kept
 *  ABOVE {@link MUTEX_STALE_MS} so any contending waiter survives long enough to break an orphaned
 *  mutex and proceed, instead of giving up (fail-open, losing serialization) while the orphan ages. The
 *  mutex is held only for one sub-millisecond read-modify-write, so real contention clears fast. */
const MUTEX_MAX_WAIT_MS = 8_000;
/** Backoff between mutex attempts under contention. */
const MUTEX_RETRY_MS = 15;

/** A queued or active reservation as stored on disk. */
export interface AdmissionRecord {
  readonly owner: AdmissionOwner;
  readonly priority: AdmissionPriority;
  readonly estimate: AdmissionEstimate;
  /** ISO time the request entered its current list (acquired-at for active, enqueued-at for queue). */
  readonly since: string;
  /** ISO time of the owner's most recent heartbeat (drives stale reaping). */
  readonly heartbeatAt: string;
}

/** The on-disk record for ONE resource key: its capacity, the active holders, and the waiting queue. */
export interface AdmissionResourceFile {
  readonly key: string;
  readonly capacity: number;
  readonly active: readonly AdmissionRecord[];
  readonly queue: readonly AdmissionRecord[];
}

/** A record enriched with the live facts /doctor reads off it. */
export interface AdmissionRecordView extends AdmissionRecord {
  readonly heartbeatAgeMs: number;
  readonly alive: boolean;
}

/** A read-only snapshot of one resource's admission state for diagnostics. */
export interface AdmissionResourceView {
  readonly key: string;
  readonly capacity: number;
  readonly active: readonly AdmissionRecordView[];
  readonly queue: readonly AdmissionRecordView[];
}

/** The minimal synchronous filesystem the store needs, injected so the core is pure and testable. */
export interface AdmissionFs {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  remove(path: string): void;
  /** Atomically create the file IFF it does not exist (O_EXCL); false when it already exists. The
   *  cross-process mutex primitive. */
  createExclusive(path: string): boolean;
  /** Atomically rename `from` to `to`, returning true on success and false when `from` is gone - the
   *  atomic CLAIM used to break an orphaned mutex without a remove+recreate TOCTOU (only one racer can
   *  win the rename). */
  renameIfExists(from: string, to: string): boolean;
  /** The file's mtime in epoch-ms, or null when it does not exist - for breaking a stale mutex. */
  mtimeMs(path: string): number | null;
  /** The `.json` resource filenames (basenames) in the admission dir, for an aggregate snapshot. */
  listResources(dir: string): readonly string[];
}

/** The capabilities the store core is pure over. */
export interface AdmissionCaps {
  readonly fs: AdmissionFs;
  readonly now: () => number;
  readonly processAlive: (pid: number) => boolean;
  /** A short async sleep, used only for mutex backoff under real contention (never in single-threaded
   *  unit tests, where the mutex is always free on the first try). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Override the admission directory (tests); defaults to the state-home `admission` inventory path. */
  readonly dir?: string;
  /** Heartbeat-age staleness window (ms); defaults to {@link ADMISSION_STALE_MS}. */
  readonly staleAfterMs?: number;
}

/** Thrown when the per-resource mutex cannot be taken within the bound, so admission cannot be decided. */
export class AdmissionStoreUnavailable extends Error {
  constructor(key: string) {
    super(`admission store unavailable for ${key} (mutex contended beyond ${MUTEX_MAX_WAIT_MS}ms)`);
    this.name = "AdmissionStoreUnavailable";
  }
}

/** The real node-backed filesystem for admission files. */
export const nodeAdmissionFs: AdmissionFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile(path, content) {
    // Atomic (shared temp-write + rename helper) so a reader (the unlocked /doctor snapshot) or a
    // mid-write crash never sees a TRUNCATED resource file - a torn read would parse-fail to the empty
    // resource and silently drop every active holder + queued waiter (an over-admit). The mutex
    // serializes writers per resource, so the helper's per-process tmp name never collides.
    writeFileAtomic(path, content);
  },
  remove(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      // already gone
    }
  },
  createExclusive(path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      return false;
    }
  },
  renameIfExists(from, to) {
    try {
      renameSync(from, to);
      return true;
    } catch {
      return false;
    }
  },
  mtimeMs(path) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  listResources(dir) {
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  },
};

/** The real node-backed capabilities, with optional overrides for wiring/tests. */
export function nodeAdmissionCaps(over: Partial<AdmissionCaps> = {}): AdmissionCaps {
  return {
    fs: nodeAdmissionFs,
    now: () => Date.now(),
    processAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...over,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function admissionDir(caps: AdmissionCaps): string {
  return caps.dir ?? storagePathByName(ADMISSION_STORAGE_NAME);
}

/** A readable-ish, collision-resistant lease filename stem: a slug of the key's last segment (model id
 *  or endpoint) plus the key hash (which actually disambiguates). */
function resourceStem(key: string): string {
  const last = key.split(":").filter(Boolean).pop() ?? "resource";
  return `${idSlug(last, "res")}-${resourceKeyHash(key)}`;
}

function resourcePath(key: string, caps: AdmissionCaps): string {
  return join(admissionDir(caps), `${resourceStem(key)}.json`);
}

function mutexPath(key: string, caps: AdmissionCaps): string {
  return join(admissionDir(caps), `${resourceStem(key)}.lock`);
}

/** Parses + validates a resource file, returning an empty resource (at `fallbackCapacity`) for a
 *  missing / malformed record. A valid file keeps its STORED capacity so read-only inspect/poll respect
 *  it; {@link acquireAdmission} overrides it with the current config capacity (config changes win). */
function readResource(
  key: string,
  fallbackCapacity: number,
  caps: AdmissionCaps,
): AdmissionResourceFile {
  const empty: AdmissionResourceFile = { key, capacity: fallbackCapacity, active: [], queue: [] };
  const raw = caps.fs.readFile(resourcePath(key, caps));
  if (!raw) {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AdmissionResourceFile>;
    if (parsed && Array.isArray(parsed.active) && Array.isArray(parsed.queue)) {
      return {
        key,
        capacity:
          typeof parsed.capacity === "number" && parsed.capacity > 0
            ? parsed.capacity
            : fallbackCapacity,
        active: parsed.active.filter(isRecord),
        queue: parsed.queue.filter(isRecord),
      };
    }
  } catch {
    // malformed - treat as empty
  }
  return empty;
}

/** A structural guard for a stored record (tolerates forward-compat extra fields). */
function isRecord(value: unknown): value is AdmissionRecord {
  const r = value as Partial<AdmissionRecord> | null;
  return (
    !!r &&
    typeof r === "object" &&
    !!r.owner &&
    typeof r.owner.ownerId === "string" &&
    typeof r.owner.pid === "number" &&
    typeof r.heartbeatAt === "string"
  );
}

function writeResource(file: AdmissionResourceFile, caps: AdmissionCaps): void {
  // An empty resource (no active, no queue) leaves no file behind - keep the dir clean.
  const path = resourcePath(file.key, caps);
  if (file.active.length === 0 && file.queue.length === 0) {
    caps.fs.remove(path);
    return;
  }
  caps.fs.writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

function heartbeatAgeMs(record: AdmissionRecord, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(record.heartbeatAt));
}

/** Whether a record's owner is gone: its pid is dead, OR its heartbeat aged past the stale window. */
function isStale(record: AdmissionRecord, nowMs: number, caps: AdmissionCaps): boolean {
  const alive = caps.processAlive(record.owner.pid);
  const ageMs = heartbeatAgeMs(record, nowMs);
  return !alive || ageMs > (caps.staleAfterMs ?? ADMISSION_STALE_MS);
}

/** Drops stale active holders and queued waiters - the cross-process reap every mutation runs first, so
 *  a crashed owner's slot/queue spot frees for whoever next touches the resource. */
function reap(
  file: AdmissionResourceFile,
  nowMs: number,
  caps: AdmissionCaps,
): AdmissionResourceFile {
  return {
    ...file,
    active: file.active.filter((r) => !isStale(r, nowMs, caps)),
    queue: file.queue.filter((r) => !isStale(r, nowMs, caps)),
  };
}

/** Queue order: highest priority first, then FIFO by enqueue time, then ownerId as a stable tiebreak. */
function queueOrder(a: AdmissionRecord, b: AdmissionRecord): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  const byTime = Date.parse(a.since) - Date.parse(b.since);
  return byTime !== 0 ? byTime : a.owner.ownerId.localeCompare(b.owner.ownerId);
}

/** Promotes queue fronts (in priority/FIFO order) into any free active slots - the drain run after an
 *  enqueue, a release, or a stale reap. Returns the rebalanced resource. */
function drain(file: AdmissionResourceFile, nowMs: number): AdmissionResourceFile {
  const queue = [...file.queue].sort(queueOrder);
  const active = [...file.active];
  while (active.length < file.capacity && queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    active.push({ ...next, since: iso(nowMs), heartbeatAt: iso(nowMs) });
  }
  return { ...file, active, queue };
}

function indexOfOwner(records: readonly AdmissionRecord[], ownerId: string): number {
  return records.findIndex((r) => r.owner.ownerId === ownerId);
}

/** Runs `fn` under the per-resource exclusive mutex (cross-process), breaking a mutex orphaned by a
 *  crash. Throws {@link AdmissionStoreUnavailable} if the mutex stays contended past the bound. */
async function withResourceMutex<T>(key: string, caps: AdmissionCaps, fn: () => T): Promise<T> {
  const path = mutexPath(key, caps);
  const deadline = caps.now() + MUTEX_MAX_WAIT_MS;
  for (;;) {
    if (caps.fs.createExclusive(path)) {
      try {
        return fn();
      } finally {
        caps.fs.remove(path);
      }
    }
    const mtime = caps.fs.mtimeMs(path);
    if (mtime != null && caps.now() - mtime > MUTEX_STALE_MS) {
      // Break an orphaned mutex by ATOMICALLY claiming it (rename to a per-attempt token), so two racing
      // breakers can't both delete-and-recreate it (the remove+create TOCTOU that would double-grant);
      // only the racer that wins the rename proceeds, and it drops the token before retrying create.
      if (caps.fs.renameIfExists(path, `${path}.broken.${process.pid}`)) {
        caps.fs.remove(`${path}.broken.${process.pid}`);
      }
      continue;
    }
    if (caps.now() >= deadline) {
      throw new AdmissionStoreUnavailable(key);
    }
    await caps.sleep(MUTEX_RETRY_MS);
  }
}

/** The shared estimate/refusal gate (V1 provenance): a request whose own estimate cannot fit the model
 *  context, or whose estimate plus the active reservations would overflow it, is impossible and refused
 *  before it queues. A zero/unknown context window disables the check (queue-only). */
function refusalFor(
  active: readonly AdmissionRecord[],
  estimate: AdmissionEstimate,
): AdmissionAcquireOutcome | null {
  const window = estimate.contextWindowTokens;
  if (window <= 0) {
    return null;
  }
  if (estimate.estimatedTokens > window) {
    return { status: "refused", refusal: "estimated_tokens_exceed_context_window" };
  }
  const activeTokens = active.reduce((sum, r) => sum + r.estimate.estimatedTokens, 0);
  if (activeTokens + estimate.estimatedTokens > window) {
    return { status: "refused", refusal: "active_reservations_exceed_context_window" };
  }
  return null;
}

/** A request to acquire admission for a resource. */
export interface AdmissionRequest {
  readonly key: string;
  readonly owner: AdmissionOwner;
  readonly priority: AdmissionPriority;
  readonly estimate: AdmissionEstimate;
  /** The resource's active capacity (default {@link ADMISSION_DEFAULT_CAPACITY}). */
  readonly capacity?: number;
}

/**
 * Attempts to acquire admission: reap stale, refuse an impossible request, else enqueue the candidate
 * and drain free slots in priority order. The candidate ends up `acquired` if it wins a free slot now,
 * else `queued` with its current position. Cross-process safe via the per-resource mutex.
 */
export async function acquireAdmission(
  request: AdmissionRequest,
  caps: AdmissionCaps,
): Promise<AdmissionAcquireOutcome> {
  // A non-positive capacity would wedge the resource shut (nothing ever admits), so fall back to the
  // default rather than trust a 0 / negative override.
  const capacity =
    request.capacity && request.capacity > 0 ? request.capacity : ADMISSION_DEFAULT_CAPACITY;
  return withResourceMutex(request.key, caps, () => {
    const nowMs = caps.now();
    // The current config capacity wins over whatever the file was last written with.
    const reaped = {
      ...reap(readResource(request.key, capacity, caps), nowMs, caps),
      capacity,
    };
    const refusal = refusalFor(reaped.active, request.estimate);
    if (refusal) {
      writeResource(reaped, caps);
      return refusal;
    }
    const candidate: AdmissionRecord = {
      owner: request.owner,
      priority: request.priority,
      estimate: request.estimate,
      since: iso(nowMs),
      heartbeatAt: iso(nowMs),
    };
    const drained = drain({ ...reaped, queue: [...reaped.queue, candidate] }, nowMs);
    writeResource(drained, caps);
    if (indexOfOwner(drained.active, request.owner.ownerId) !== -1) {
      return { status: "acquired" };
    }
    return { status: "queued", position: queuePositionOf(drained, request.owner.ownerId) };
  });
}

/** The 0-based position of an owner within the priority-ordered queue (its number in line). */
function queuePositionOf(file: AdmissionResourceFile, ownerId: string): number {
  return [...file.queue].sort(queueOrder).findIndex((r) => r.owner.ownerId === ownerId);
}

/**
 * Polls a queued request: reap stale, refresh this owner's heartbeat (it is actively waiting), drain
 * free slots, and report whether the owner is now active (`acquired`), still `queued` (with position),
 * or `gone` (released/reaped/never-present). A queued waiter loops on this until acquired or cancelled.
 */
export async function pollAdmission(
  key: string,
  ownerId: string,
  caps: AdmissionCaps,
): Promise<AdmissionPollOutcome> {
  return withResourceMutex(key, caps, () => {
    const nowMs = caps.now();
    // Refresh the poller's own heartbeat BEFORE reaping, so the act of actively polling protects a
    // waiter from being reaped for staleness in its own call (the poll IS the waiter's heartbeat).
    const reaped = reap(
      touchHeartbeat(readResource(key, ADMISSION_DEFAULT_CAPACITY, caps), ownerId, nowMs),
      nowMs,
      caps,
    );
    if (indexOfOwner(reaped.active, ownerId) !== -1) {
      writeResource(reaped, caps);
      return { status: "acquired" };
    }
    const drained = drain(reaped, nowMs);
    writeResource(drained, caps);
    if (indexOfOwner(drained.active, ownerId) !== -1) {
      return { status: "acquired" };
    }
    const position = queuePositionOf(drained, ownerId);
    return position === -1 ? { status: "gone" } : { status: "queued", position };
  });
}

/** Refreshes one owner's heartbeat in whichever list (active or queue) holds it. Pure. */
function touchHeartbeat(
  file: AdmissionResourceFile,
  ownerId: string,
  nowMs: number,
): AdmissionResourceFile {
  const bump = (records: readonly AdmissionRecord[]): readonly AdmissionRecord[] =>
    records.map((r) => (r.owner.ownerId === ownerId ? { ...r, heartbeatAt: iso(nowMs) } : r));
  return { ...file, active: bump(file.active), queue: bump(file.queue) };
}

/**
 * Refreshes an active holder's (or queued waiter's) heartbeat so a long-running generation is not
 * reaped as stale. Returns whether the owner was found. Cross-process safe.
 */
export async function heartbeatAdmission(
  key: string,
  ownerId: string,
  caps: AdmissionCaps,
): Promise<{ readonly refreshed: boolean }> {
  return withResourceMutex(key, caps, () => {
    const nowMs = caps.now();
    const file = reap(readResource(key, ADMISSION_DEFAULT_CAPACITY, caps), nowMs, caps);
    const present =
      indexOfOwner(file.active, ownerId) !== -1 || indexOfOwner(file.queue, ownerId) !== -1;
    if (!present) {
      writeResource(file, caps);
      return { refreshed: false };
    }
    writeResource(touchHeartbeat(file, ownerId, nowMs), caps);
    return { refreshed: true };
  });
}

/**
 * Releases an owner's admission - whether it was active or still queued - and drains the freed slot to
 * the next waiter. Idempotent: releasing an unknown/already-gone owner is a no-op. Cross-process safe.
 */
export async function releaseAdmission(
  key: string,
  ownerId: string,
  caps: AdmissionCaps,
): Promise<{ readonly released: boolean }> {
  return withResourceMutex(key, caps, () => {
    const nowMs = caps.now();
    const file = reap(readResource(key, ADMISSION_DEFAULT_CAPACITY, caps), nowMs, caps);
    const wasActive = indexOfOwner(file.active, ownerId) !== -1;
    const wasQueued = indexOfOwner(file.queue, ownerId) !== -1;
    if (!wasActive && !wasQueued) {
      writeResource(file, caps);
      return { released: false };
    }
    const without: AdmissionResourceFile = {
      ...file,
      active: file.active.filter((r) => r.owner.ownerId !== ownerId),
      queue: file.queue.filter((r) => r.owner.ownerId !== ownerId),
    };
    writeResource(drain(without, nowMs), caps);
    return { released: true };
  });
}

function viewRecord(
  record: AdmissionRecord,
  nowMs: number,
  caps: AdmissionCaps,
): AdmissionRecordView {
  return {
    ...record,
    heartbeatAgeMs: heartbeatAgeMs(record, nowMs),
    alive: caps.processAlive(record.owner.pid),
  };
}

/** Reads one resource's current admission state WITHOUT mutating it - the /doctor surface. Stale entries
 *  are surfaced (with `alive`/age) rather than reaped, since inspection never writes. */
export function inspectResource(key: string, caps: AdmissionCaps): AdmissionResourceView {
  const nowMs = caps.now();
  const file = readResource(key, ADMISSION_DEFAULT_CAPACITY, caps);
  return {
    key: file.key,
    capacity: file.capacity,
    active: file.active.map((r) => viewRecord(r, nowMs, caps)),
    queue: [...file.queue].sort(queueOrder).map((r) => viewRecord(r, nowMs, caps)),
  };
}

/** The live active holders on `key`: each alive (pid up) and heartbeated within `staleAfterMs`. The one
 *  definition of "still holding" the residency claim count (M3) and the generation-liveness guard (M4)
 *  share, so a crashed or wedged holder is excluded identically everywhere. */
export function liveActiveRecords(
  key: string,
  caps: AdmissionCaps,
  staleAfterMs: number = ADMISSION_STALE_MS,
): readonly AdmissionRecordView[] {
  return inspectResource(key, caps).active.filter(
    (r) => r.alive && r.heartbeatAgeMs <= staleAfterMs,
  );
}

/** Reads EVERY known resource's admission state (for the /doctor aggregate) without mutating. Resources
 *  with neither active nor queued records are omitted (their files are removed on release). */
export function snapshotAdmission(caps: AdmissionCaps): readonly AdmissionResourceView[] {
  const dir = admissionDir(caps);
  const nowMs = caps.now();
  const views: AdmissionResourceView[] = [];
  for (const name of caps.fs.listResources(dir)) {
    const raw = caps.fs.readFile(join(dir, name));
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AdmissionResourceFile>;
      if (!parsed || typeof parsed.key !== "string") {
        continue;
      }
      const active = (parsed.active ?? []).filter(isRecord);
      const queue = (parsed.queue ?? []).filter(isRecord);
      if (active.length === 0 && queue.length === 0) {
        continue;
      }
      views.push({
        key: parsed.key,
        capacity:
          typeof parsed.capacity === "number" ? parsed.capacity : ADMISSION_DEFAULT_CAPACITY,
        active: active.map((r) => viewRecord(r, nowMs, caps)),
        queue: [...queue].sort(queueOrder).map((r) => viewRecord(r, nowMs, caps)),
      });
    } catch {
      // skip malformed
    }
  }
  return views;
}

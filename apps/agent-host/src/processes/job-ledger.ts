/**
 * The background-job WATCHDOG (plan 09 hardening): a persisted per-session ledger of the running jobs a
 * host spawned, plus the pure reconcile that reaps orphans a crashed prior host left behind.
 *
 * The {@link ProcessRegistry} is an in-memory singleton: a job's status flips to `exited`/`killed` only
 * when its child emits `exit` to that host, and a graceful STOP reaps running jobs via `killAll`. But a
 * host that died WITHOUT a clean shutdown (SIGKILL, machine restart, a killed terminal) left its
 * long-lived children (dev servers, watchers, builds) running with no owner - and the last `host.online`
 * snapshot it published keeps reporting them as `running` forever, because nothing alive can correct it.
 *
 * The ledger closes that gap. Each host writes the pids of its own running jobs to `<state>/jobs-ledger/
 * <session>.json` as they start/stop. On a leader transition (a restart, or a standby taking over) the
 * new host reads that ledger, SIGTERMs every pid that is still alive AND provably one of this session's
 * jobs (command-verified, so a REUSED pid is never killed), then rewrites the ledger to its own
 * (initially empty) set. The existing `host.online` announce then publishes the corrected snapshot.
 *
 * Responsible for: the persisted running-job pid ledger and the pure orphan-reconcile decision.
 * Not for: spawning/tracking jobs (process-registry.ts) or deciding WHEN to reconcile (boot/leadership.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One running job the ledger remembers so a later host can judge it an orphan: its pid, command, and
 *  start time. `command` is the verify-before-kill token (the child was `spawn(command, { shell: true })`,
 *  so its real command line contains this string); `startedAt` is for diagnostics. */
export interface RunningJobRecord {
  readonly pid: number;
  readonly command: string;
  readonly startedAt: number;
}

/** The persisted per-session ledger of currently-running jobs, keyed by job id. */
export interface JobLedger {
  /** Every running job the ledger currently remembers, or {} when none / unreadable. */
  load(): Record<string, RunningJobRecord>;
  /** Overwrites the ledger with exactly these running jobs (an empty map clears it). */
  replaceAll(running: Record<string, RunningJobRecord>): void;
}

/**
 * Opens the running-job ledger at `filePath` (default: `<state>/jobs-ledger/<sessionId>.json`). Reads
 * tolerate a missing or corrupt file (treated as empty), so a bad file never crashes startup - the
 * reconcile just has nothing to reap. Mirrors {@link createLoopPersistence}'s tolerant JSON IO.
 */
export function createJobLedger(
  filePath: string = join(process.cwd(), "jobs-ledger.json"),
): JobLedger {
  const readAll = (): Record<string, RunningJobRecord> => {
    if (!existsSync(filePath)) {
      return {};
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        return {};
      }
      const out: Record<string, RunningJobRecord> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          value &&
          typeof value === "object" &&
          typeof (value as RunningJobRecord).pid === "number" &&
          typeof (value as RunningJobRecord).command === "string"
        ) {
          out[id] = value as RunningJobRecord;
        }
      }
      return out;
    } catch {
      return {};
    }
  };
  return {
    load: readAll,
    replaceAll(running) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(running, null, 2));
    },
  };
}

/** The OS capabilities the reconcile needs, injected so the decision is pure and unit-testable: the
 *  host wires the real `processAlive` + `ps` + `process.kill`, tests wire fakes. */
export interface ReconcileDeps {
  /** `kill(pid, 0)` liveness: true when the pid is a live process. */
  readonly isAlive: (pid: number) => boolean;
  /** The pid's full command line (e.g. `ps -p <pid> -ww -o command=`), or null when unknown/gone. Used
   *  ONLY to confirm a pid is really one of this session's jobs before killing - never to decide alone. */
  readonly commandOf: (pid: number) => string | null;
  /** Delivers the termination signal (SIGTERM) to a confirmed orphan. Best-effort: a vanished pid is
   *  not an error (it raced out between the liveness check and the signal). */
  readonly terminate: (pid: number) => void;
}

/** What a reconcile did, for host logging/diagnostics (never affects the turn). */
export interface ReconcileOutcome {
  /** Pids that were alive, command-verified as this session's, and terminated. */
  readonly killed: readonly number[];
  /** Ledger pids spared: already dead, or alive but NOT command-verified (a reused pid - never killed). */
  readonly spared: readonly number[];
}

/**
 * Whether a live pid is REALLY the job the ledger remembers. The child was spawned with
 * `spawn(command, { shell: true })`, so its real command line contains the ledger's `command` string; a
 * reused pid running an unrelated process will not. Conservative by design: a `null`/empty description
 * or a non-matching command spares the pid (a missed reap, never a wrong kill). The substring match is
 * one-directional on purpose - the ledger command is the trusted token.
 */
export function commandMatches(record: RunningJobRecord, actual: string | null): boolean {
  if (actual === null || actual.trim().length === 0) {
    return false;
  }
  return actual.includes(record.command);
}

/**
 * Reconciles the ledger against `live` (the running jobs THIS host currently tracks): every ledger job
 * that is no longer live-tracked is an orphan from a prior (crashed) host. Each orphan that is still
 * alive AND command-verified is SIGTERM'd; a dead orphan or a reused pid is spared. The ledger is then
 * rewritten to exactly `live`, so this host owns it going forward. Pure over the injected deps, so every
 * branch (alive+verified kill, dead spare, reused-pid spare) is unit-tested without real processes.
 *
 * Safety is the never-kill-the-wrong-process bias: the only pids touched are ones the ledger itself
 * recorded as this session's jobs, and only when their live command line still proves it.
 */
export function reconcileOrphanJobs(
  ledger: JobLedger,
  live: Record<string, RunningJobRecord>,
  deps: ReconcileDeps,
): ReconcileOutcome {
  const remembered = ledger.load();
  const killed: number[] = [];
  const spared: number[] = [];
  for (const [id, record] of Object.entries(remembered)) {
    if (live[id] !== undefined) {
      continue; // this host still tracks it - not an orphan
    }
    if (!deps.isAlive(record.pid)) {
      spared.push(record.pid); // already gone on its own - nothing to reap
      continue;
    }
    if (commandMatches(record, deps.commandOf(record.pid))) {
      deps.terminate(record.pid);
      killed.push(record.pid);
    } else {
      spared.push(record.pid); // alive but not command-verified -> likely a reused pid; spare it
    }
  }
  // This host now owns the ledger: rewrite it to exactly the jobs it tracks.
  ledger.replaceAll(live);
  return { killed, spared };
}

import { fetchWithTimeout, findListenerPids, STORE_READY_TIMEOUT_MS } from "@trevor/launcher";
import { HEALTH_PATH } from "@trevor/server-kit";
import { errorMessage } from "@trevor/session";
import { RESERVED_PORTS } from "@trevor/session/ports";
import {
  SPAN_NAMES,
  type SpanName,
  type SpanStatus,
  safeAttributes,
  safeEmitSpan,
  type TelemetrySink,
} from "@trevor/session/telemetry";

/**
 * The supervisor's store watchdog (plan 45.2 M2): poll the session-store's `/health` on an interval
 * and, when the store is WEDGED (process alive, `:17424` held, health dead - the 2026-07-06 failure
 * launchdawg's KeepAlive cannot see), terminate the store PID so KeepAlive respawns it (~2s). This
 * converts a multi-hour silent wedge into a ~10s blip, cause-agnostic.
 *
 * SUPERVISION, not communication: the watchdog only observes `/health` and forces process DEATH. It
 * never speaks the session protocol to the store, never carries requests, and never STARTS a store -
 * recovery is kill + let launchdawg KeepAlive respawn, because `startService` here could race
 * KeepAlive into a duplicate `:17424` bind, and shelling out to `launchdawg restart` would couple the
 * supervisor to an external CLI.
 *
 * Every automated kill is guarded so the watchdog can never kill-loop:
 *  - the trip needs N CONSECUTIVE probe failures, each within a window of the previous (a stale
 *    streak from suspended timers - laptop sleep - is discarded rather than tripping on resume);
 *  - a BOOTING store (never yet seen healthy) is protected by a startup grace;
 *  - after a kill, a recovery grace (the same window `waitForStore` gives a booting store) must
 *    elapse before the attempt counts as failed;
 *  - failed attempts back off exponentially and are CAPPED - at the cap the watchdog raises one
 *    `store_recovery_exhausted` alarm span and drops to observe-only until health returns.
 *
 * The state machine is pure over injected collaborators (prober, terminator, telemetry, clock), so
 * tests drive `tick()` deterministically; `startStoreWatchdog` wires the real node IO + interval.
 */

export interface StoreWatchdogConfig {
  /** How often the production loop polls `/health`. */
  readonly pollIntervalMs: number;
  /** Per-probe HTTP budget; a healthy local store answers in single-digit ms. */
  readonly probeTimeoutMs: number;
  /** N consecutive probe failures before the watchdog trips. */
  readonly failureThreshold: number;
  /** Max gap between consecutive failures for the streak to stay live (stale streaks reset). */
  readonly failureWindowMs: number;
  /** How long a never-yet-healthy (booting) store is protected from the first kill. */
  readonly startupGraceMs: number;
  /** How long after a kill the respawned store gets to answer `/health` before the attempt fails. */
  readonly recoveryGraceMs: number;
  /** First backoff after a failed recovery; doubles per further attempt. */
  readonly backoffBaseMs: number;
  /** Max kills per wedge episode; at the cap the alarm span fires and killing stops. */
  readonly maxRecoveryAttempts: number;
}

/** Detection ≈ threshold × interval ≈ 10s; recovery grace reuses the launcher's store-boot window. */
export const DEFAULT_STORE_WATCHDOG_CONFIG: StoreWatchdogConfig = {
  pollIntervalMs: 2_000,
  probeTimeoutMs: 800,
  failureThreshold: 5,
  failureWindowMs: 10_000,
  startupGraceMs: 30_000,
  recoveryGraceMs: STORE_READY_TIMEOUT_MS,
  backoffBaseMs: 5_000,
  maxRecoveryAttempts: 5,
};

/** The injected collaborators; the real ones live in {@link startStoreWatchdog}. */
export interface StoreWatchdogDeps {
  /** One timed `/health` probe: true = the store answered 200. */
  readonly probeHealth: () => Promise<boolean>;
  /** Finds + terminates the store process; resolves the PIDs it signalled (empty = none found). */
  readonly terminateStore: () => Promise<readonly number[]>;
  readonly telemetry: TelemetrySink;
  /** Structured diagnostics sink; a no-op by default. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Injectable clock (tests drive time deterministically). */
  readonly now?: () => number;
}

/**
 *  - watching   : normal polling; failures build a streak toward the trip.
 *  - recovering : a kill happened; waiting for KeepAlive's respawn to answer `/health` (or for the
 *                 recovery grace + backoff to allow the next attempt).
 *  - exhausted  : the attempt cap was hit; observe-only until health returns.
 */
type WatchdogPhase = "watching" | "recovering" | "exhausted";

/** Inspectable internal state (observability + tests); never consumed by the machine itself. */
export interface StoreWatchdogSnapshot {
  readonly phase: WatchdogPhase;
  readonly everHealthy: boolean;
  readonly consecutiveFailures: number;
  readonly recoveryAttempts: number;
}

export interface StoreWatchdog {
  /** One poll-and-recover cycle. Re-entrant calls while a cycle is in flight are no-ops, so a slow
   *  probe or terminate never stacks cycles under the production interval. */
  tick(): Promise<void>;
  snapshot(): StoreWatchdogSnapshot;
}

export function createStoreWatchdog(
  deps: StoreWatchdogDeps,
  config: Partial<StoreWatchdogConfig> = {},
): StoreWatchdog {
  const cfg: StoreWatchdogConfig = { ...DEFAULT_STORE_WATCHDOG_CONFIG, ...config };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const startedAt = now();

  let phase: WatchdogPhase = "watching";
  let everHealthy = false;
  let streak = 0; // consecutive failed probes (keeps counting through a recovery, for the spans)
  let streakStartedAt = 0;
  let lastFailureAt = 0;
  let attempts = 0; // kills in the current wedge episode
  let wedgeDetectedAt = 0;
  let killedAt = 0;
  let nextAttemptAt: number | null = null; // the backoff gate for the next kill
  let ticking = false;

  function emit(
    name: SpanName,
    status: SpanStatus,
    durationMs: number,
    attributes: Readonly<Record<string, unknown>>,
    error?: string,
  ): void {
    safeEmitSpan(deps.telemetry, {
      name,
      attributes: safeAttributes(attributes),
      status,
      durationMs,
      ...(error ? { error } : {}),
    });
  }

  /** Full re-arm: the next wedge needs N fresh consecutive failures again. */
  function reset(): void {
    phase = "watching";
    everHealthy = true;
    streak = 0;
    attempts = 0;
    nextAttemptAt = null;
  }

  function onHealthy(at: number): void {
    if (phase === "recovering") {
      // KeepAlive's respawn answered within the episode: the kill worked.
      emit(SPAN_NAMES.supervisorStoreRestarted, "ok", at - wedgeDetectedAt, {
        attempts,
        failure_streak: streak,
      });
      log("store recovered after kill", { attempts, recoveryMs: at - wedgeDetectedAt });
    } else if (phase === "exhausted") {
      // Recovery arrived without us (operator / an eventual KeepAlive win): resume normal watching.
      log("store healthy again after recovery was exhausted", { attempts });
    }
    reset();
  }

  /** One more kill: count the attempt first so a throwing terminator still burns toward the cap. */
  async function kill(at: number): Promise<void> {
    attempts += 1;
    killedAt = at;
    phase = "recovering";
    try {
      const pids = await deps.terminateStore();
      log("terminated wedged store", { attempt: attempts, pids: pids.join(",") || "none" });
    } catch (error) {
      log("store terminate failed", { attempt: attempts, error: errorMessage(error) });
    }
  }

  async function onUnhealthy(at: number): Promise<void> {
    if (phase === "exhausted") {
      return; // the alarm already fired; never kill-loop
    }

    if (phase === "watching") {
      // A stale streak (poll gap past the window: suspended timers, laptop sleep) must not trip a
      // kill on resume - restart the count from this failure.
      if (streak > 0 && at - lastFailureAt > cfg.failureWindowMs) {
        streak = 0;
      }
      if (streak === 0) {
        streakStartedAt = at;
      }
      streak += 1;
      lastFailureAt = at;
      // A booting store (health never yet seen) is not a wedge until the startup grace elapses.
      if (!everHealthy && at - startedAt < cfg.startupGraceMs) {
        return;
      }
      if (streak < cfg.failureThreshold) {
        return;
      }
      wedgeDetectedAt = at;
      emit(
        SPAN_NAMES.supervisorStoreWedgeDetected,
        "error",
        at - streakStartedAt,
        { failure_streak: streak },
        `store /health failed ${streak} consecutive probes`,
      );
      log("store wedge detected", { failureStreak: streak, windowMs: at - streakStartedAt });
      await kill(at);
      return;
    }

    // phase === "recovering"
    streak += 1;
    lastFailureAt = at;
    if (nextAttemptAt !== null) {
      // Backing off after a failed recovery: only the elapsed backoff allows the next kill.
      if (at < nextAttemptAt) {
        return;
      }
      nextAttemptAt = null;
      await kill(at);
      return;
    }
    if (at - killedAt < cfg.recoveryGraceMs) {
      return; // KeepAlive's respawn window; the store gets the same grace waitForStore gives a boot
    }
    // The recovery attempt failed its grace.
    if (attempts >= cfg.maxRecoveryAttempts) {
      emit(
        SPAN_NAMES.supervisorStoreRecoveryExhausted,
        "error",
        at - wedgeDetectedAt,
        { attempts, failure_streak: streak },
        `store did not recover after ${attempts} kills; giving up until health returns`,
      );
      log("store recovery exhausted", { attempts, failureStreak: streak });
      phase = "exhausted";
      return;
    }
    nextAttemptAt = at + cfg.backoffBaseMs * 2 ** (attempts - 1);
    log("store recovery attempt failed; backing off", {
      attempt: attempts,
      nextAttemptInMs: nextAttemptAt - at,
    });
  }

  return {
    async tick(): Promise<void> {
      if (ticking) {
        return;
      }
      ticking = true;
      try {
        const healthy = await deps.probeHealth();
        const at = now();
        if (healthy) {
          onHealthy(at);
        } else {
          await onUnhealthy(at);
        }
      } finally {
        ticking = false;
      }
    },
    snapshot: () => ({
      phase,
      everHealthy,
      consecutiveFailures: streak,
      recoveryAttempts: attempts,
    }),
  };
}

export interface StartStoreWatchdogOptions {
  /** The store base URL (the supervisor's env-resolved one, so probe and kill target agree). */
  readonly storeUrl: string;
  readonly telemetry: TelemetrySink;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly config?: Partial<StoreWatchdogConfig>;
}

/** The port whose LISTEN holder is the kill target, from the same URL the probe hits. */
function storePort(storeUrl: string): number {
  try {
    const port = Number.parseInt(new URL(storeUrl).port, 10);
    return Number.isInteger(port) && port > 0 ? port : RESERVED_PORTS.store;
  } catch {
    return RESERVED_PORTS.store;
  }
}

/**
 * Finds the store's port listener(s) and SIGKILLs them. SIGKILL, not SIGTERM: the target has already
 * failed N consecutive `/health` probes, so its event loop cannot be trusted to run a graceful
 * handler - and abrupt death is safe (SQLite WAL) because launchdawg KeepAlive owns the respawn.
 * The supervisor's own pid is excluded as a hard safety line (it can never kill itself).
 */
async function terminateStoreListeners(
  port: number,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<readonly number[]> {
  const pids = (await findListenerPids(port)).filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // Already gone (died between discovery and kill): KeepAlive owns the respawn either way.
      log("store kill signal failed", { pid, error: errorMessage(error) });
    }
  }
  return pids;
}

/** Wires the real prober (`fetchWithTimeout` on `/health`) + terminator and starts the poll loop.
 *  Returns a stop function (tests and a future graceful shutdown; the daemon never calls it). */
export function startStoreWatchdog(opts: StartStoreWatchdogOptions): () => void {
  const cfg: StoreWatchdogConfig = { ...DEFAULT_STORE_WATCHDOG_CONFIG, ...opts.config };
  const log = opts.log ?? (() => {});
  const port = storePort(opts.storeUrl);
  const healthUrl = `${opts.storeUrl}${HEALTH_PATH}`;
  const watchdog = createStoreWatchdog(
    {
      probeHealth: async () => {
        const res = await fetchWithTimeout(healthUrl, cfg.probeTimeoutMs);
        return res?.ok ?? false;
      },
      terminateStore: () => terminateStoreListeners(port, log),
      telemetry: opts.telemetry,
      log: opts.log,
    },
    cfg,
  );
  const timer = setInterval(() => void watchdog.tick(), cfg.pollIntervalMs);
  log("store watchdog started", { port, pollIntervalMs: cfg.pollIntervalMs });
  return () => clearInterval(timer);
}

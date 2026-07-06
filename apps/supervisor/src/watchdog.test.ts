import assert from "node:assert/strict";
import { SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { test } from "vitest";
import { createStoreWatchdog, type StoreWatchdogConfig } from "./watchdog";

/**
 * The supervisor's store watchdog state machine (plan 45.2 M2), driven deterministically: the
 * `/health` prober, the terminate action, and the clock are all injected, and each `tick()` is one
 * poll-and-recover cycle - no real timers, sockets, or processes. These tests pin the guards that
 * keep a kill from ever looping: the N-consecutive-failures trip (terminate fires exactly once, not
 * per poll), the startup grace for a booting store, the recovery grace after a kill, and the
 * exponential backoff + attempt cap that ends in one `store_recovery_exhausted` alarm.
 */

/** Small, round thresholds so each guard is exercised with a handful of ticks. */
const CFG: StoreWatchdogConfig = {
  pollIntervalMs: 2_000,
  probeTimeoutMs: 800,
  failureThreshold: 3,
  failureWindowMs: 10_000,
  startupGraceMs: 30_000,
  recoveryGraceMs: 15_000,
  backoffBaseMs: 5_000,
  maxRecoveryAttempts: 2,
};

function makeWatchdog(overrides: Partial<StoreWatchdogConfig> = {}) {
  const clock = { now: 0 };
  const health = { value: true };
  const kills: number[] = [];
  const recorder = recordingTelemetrySink();
  const watchdog = createStoreWatchdog(
    {
      probeHealth: () => Promise.resolve(health.value),
      terminateStore: () => {
        kills.push(clock.now);
        return Promise.resolve([4242]);
      },
      telemetry: recorder.sink,
      now: () => clock.now,
    },
    { ...CFG, ...overrides },
  );
  /** Advances the injected clock to `at` and runs one poll cycle. */
  const tickAt = (at: number): Promise<void> => {
    clock.now = at;
    return watchdog.tick();
  };
  return { watchdog, health, kills, recorder, tickAt };
}

test("trips after N consecutive /health failures and terminates exactly once, not per poll", async () => {
  const { health, kills, recorder, tickAt } = makeWatchdog();
  await tickAt(0); // healthy once: the store is up, so the startup grace no longer applies

  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  assert.deepEqual(kills, [], "below the threshold no kill fires");

  await tickAt(6_000); // 3rd consecutive failure = the trip
  assert.deepEqual(kills, [6_000]);
  const wedges = recorder.named(SPAN_NAMES.supervisorStoreWedgeDetected);
  assert.equal(wedges.length, 1);
  assert.equal(wedges[0]?.status, "error");
  assert.equal(wedges[0]?.attributes.failure_streak, 3);

  // Polls keep failing inside the recovery grace: terminate must NOT fire again per poll.
  await tickAt(8_000);
  await tickAt(10_000);
  await tickAt(12_000);
  assert.deepEqual(kills, [6_000], "one wedge episode = one terminate, not one per poll");
  assert.equal(recorder.named(SPAN_NAMES.supervisorStoreWedgeDetected).length, 1);
});

test("a healthy probe resets the failure streak (failures must be consecutive)", async () => {
  const { health, kills, tickAt } = makeWatchdog();
  await tickAt(0);

  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  health.value = true;
  await tickAt(6_000); // recovery below the threshold: streak back to zero
  health.value = false;
  await tickAt(8_000);
  await tickAt(10_000);
  assert.deepEqual(kills, [], "2 + 2 non-consecutive failures never trip");

  await tickAt(12_000); // 3rd consecutive failure of the NEW streak
  assert.deepEqual(kills, [12_000]);
});

test("a stale streak (poll gap past the window) is discarded instead of tripping on resume", async () => {
  const { health, kills, tickAt } = makeWatchdog();
  await tickAt(0);

  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  // The next poll lands far outside the failure window (suspended timers / laptop sleep).
  await tickAt(60_000);
  await tickAt(62_000);
  assert.deepEqual(kills, [], "the pre-gap failures do not count toward the trip");
  await tickAt(64_000); // 3rd failure of the fresh, in-window streak
  assert.deepEqual(kills, [64_000]);
});

test("startup grace: a booting store (never yet healthy) is not killed until the grace elapses", async () => {
  const { health, kills, tickAt } = makeWatchdog();
  health.value = false;
  for (let at = 2_000; at <= 28_000; at += 2_000) {
    await tickAt(at);
  }
  assert.deepEqual(kills, [], "no kill inside the startup grace");

  await tickAt(31_000); // grace elapsed and the store never came up: now it is a wedge
  assert.deepEqual(kills, [31_000]);
});

test("a store that boots within the grace is never killed and re-arms the normal threshold", async () => {
  const { health, kills, tickAt } = makeWatchdog();
  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  await tickAt(6_000);
  await tickAt(8_000);
  health.value = true;
  await tickAt(10_000); // boot completed inside the grace
  assert.deepEqual(kills, []);

  health.value = false;
  await tickAt(12_000);
  await tickAt(14_000);
  assert.deepEqual(kills, [], "post-boot failures start a fresh streak");
  await tickAt(16_000);
  assert.deepEqual(kills, [16_000]);
});

test("recovery: /health 200 within the grace emits store_restarted and resumes normal polling", async () => {
  const { health, kills, recorder, tickAt } = makeWatchdog();
  await tickAt(0);
  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  await tickAt(6_000); // trip + kill
  assert.deepEqual(kills, [6_000]);

  health.value = true;
  await tickAt(9_000); // KeepAlive respawned the store inside the recovery grace
  const restarts = recorder.named(SPAN_NAMES.supervisorStoreRestarted);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0]?.status, "ok");
  assert.equal(restarts[0]?.attributes.attempts, 1);
  assert.equal(restarts[0]?.attributes.failure_streak, 3);
  assert.equal(restarts[0]?.durationMs, 3_000, "recovery latency = healthy - wedge detection");

  // Back to normal polling: a NEW wedge needs N fresh consecutive failures again.
  health.value = false;
  await tickAt(11_000);
  await tickAt(13_000);
  assert.deepEqual(kills, [6_000], "re-armed: below-threshold failures do not kill");
  await tickAt(15_000);
  assert.deepEqual(kills, [6_000, 15_000]);
  assert.equal(recorder.named(SPAN_NAMES.supervisorStoreWedgeDetected).length, 2);
});

test("restart storm: exponential backoff between attempts, capped by one exhausted alarm", async () => {
  const { health, kills, recorder, tickAt } = makeWatchdog();
  await tickAt(0);
  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  await tickAt(6_000); // trip + kill #1
  assert.deepEqual(kills, [6_000]);

  // The store never comes back: polls fail through the whole recovery grace (6s..21s)...
  for (let at = 8_000; at <= 20_000; at += 2_000) {
    await tickAt(at);
  }
  assert.deepEqual(kills, [6_000], "no re-kill inside the recovery grace");

  // ...the failed attempt arms the backoff (5s * 2^0 after the grace verdict at 22s)...
  await tickAt(22_000);
  await tickAt(24_000);
  await tickAt(26_000);
  assert.deepEqual(kills, [6_000], "no re-kill inside the backoff");
  await tickAt(28_000); // backoff elapsed (>= 27s): kill #2
  assert.deepEqual(kills, [6_000, 28_000]);

  // Attempt #2 also fails its grace (28s..43s): the cap (2) is reached - alarm, never a 3rd kill.
  for (let at = 30_000; at <= 44_000; at += 2_000) {
    await tickAt(at);
  }
  const exhausted = recorder.named(SPAN_NAMES.supervisorStoreRecoveryExhausted);
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]?.status, "error");
  assert.equal(exhausted[0]?.attributes.attempts, 2);

  for (let at = 46_000; at <= 60_000; at += 2_000) {
    await tickAt(at);
  }
  assert.deepEqual(kills, [6_000, 28_000], "exhausted = observe only, no kill loop");
  assert.equal(recorder.named(SPAN_NAMES.supervisorStoreRecoveryExhausted).length, 1);

  // External recovery (operator / KeepAlive finally wins): the watchdog re-arms fully.
  health.value = true;
  await tickAt(62_000);
  health.value = false;
  await tickAt(64_000);
  await tickAt(66_000);
  await tickAt(68_000);
  assert.deepEqual(kills, [6_000, 28_000, 68_000], "a fresh wedge after recovery kills again");
});

test("a healthy probe during the backoff also counts as recovery", async () => {
  const { health, kills, recorder, tickAt } = makeWatchdog();
  await tickAt(0);
  health.value = false;
  await tickAt(2_000);
  await tickAt(4_000);
  await tickAt(6_000); // kill #1
  for (let at = 8_000; at <= 22_000; at += 2_000) {
    await tickAt(at); // grace fails; backoff armed at 22s
  }
  health.value = true;
  await tickAt(24_000); // recovered while backing off
  assert.deepEqual(kills, [6_000]);
  const restarts = recorder.named(SPAN_NAMES.supervisorStoreRestarted);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0]?.attributes.attempts, 1);
});

test("overlapping ticks are coalesced: a slow probe never stacks poll cycles", async () => {
  let probes = 0;
  let release: ((healthy: boolean) => void) | undefined;
  const recorder = recordingTelemetrySink();
  const watchdog = createStoreWatchdog(
    {
      probeHealth: () => {
        probes += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      terminateStore: () => Promise.resolve([]),
      telemetry: recorder.sink,
      now: () => 0,
    },
    CFG,
  );

  const first = watchdog.tick();
  await watchdog.tick(); // fires while the first probe is still in flight: must be a no-op
  assert.equal(probes, 1);
  release?.(true);
  await first;

  const next = watchdog.tick(); // the loop resumes once the in-flight cycle settled
  assert.equal(probes, 2);
  release?.(true);
  await next;
});

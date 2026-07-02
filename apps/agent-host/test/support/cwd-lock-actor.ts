import {
  acquireCwdLock,
  type CwdLockOwner,
  nodeCwdLockCaps,
  refreshCwdLock,
  releaseCwdLock,
} from "@host/session/cwd-lock";

/**
 * A standalone cwd-lock actor for the cross-process smoke (plan 01, M3). It runs the EXACT host lock
 * path - `nodeCwdLockCaps` + `acquireCwdLock` with a {sessionId, hostId, pid} owner - in a real OS
 * process so the e2e smoke proves cross-process contention, stale takeover, and handover for real
 * (real pids, real `process.kill(pid, 0)` liveness, real lock files), not just in-memory fakes.
 *
 * Invoked as: `tsx cwd-lock-actor.ts <mode> <cwd> <sessionId> <hostId>` with TREVOR_STATE_HOME in the
 * env (so the lock lands under the smoke's temp state home). It prints ONE JSON line with its pid and
 * the acquire result, so the parent can assert the outcome.
 *
 *   - `acquire-once`: acquire, print the result, exit immediately WITHOUT releasing (used to probe a
 *     conflict, or to seed a lock whose owner then dies for a stale-takeover check).
 *   - `hold`: acquire, print the result, then stay alive holding the lock (refreshing its heartbeat)
 *     until SIGTERM, at which point it releases and exits - a live owner the parent contends against.
 */

const [mode, cwd, sessionId, hostId] = process.argv.slice(2);

if (!mode || !cwd || !sessionId || !hostId) {
  console.error("usage: cwd-lock-actor <mode> <cwd> <sessionId> <hostId>");
  process.exit(2);
}

const caps = nodeCwdLockCaps();
const owner: CwdLockOwner = { sessionId, hostId, pid: process.pid };

const result = acquireCwdLock(cwd, owner, caps);
// One machine-readable line the parent parses; everything else goes to stderr.
console.log(JSON.stringify({ pid: process.pid, result }));

if (mode === "acquire-once") {
  process.exit(0);
}

if (mode === "hold") {
  // Keep the heartbeat fresh like a live leader, so the parent's contention check sees a fresh owner.
  const heartbeat = setInterval(() => {
    refreshCwdLock(cwd, owner, caps);
  }, 500);
  const release = (): void => {
    clearInterval(heartbeat);
    releaseCwdLock(cwd, owner, caps);
    process.exit(0);
  };
  process.on("SIGTERM", release);
  process.on("SIGINT", release);
  // A safety valve so a leaked actor never lingers if the parent dies without signaling.
  setTimeout(release, 60_000);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

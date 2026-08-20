import {
  type AdmissionOwner,
  type AdmissionPriority,
  NO_ESTIMATE,
} from "../../src/admission/contract";
import {
  acquireAdmission,
  heartbeatAdmission,
  nodeAdmissionCaps,
  pollAdmission,
  releaseAdmission,
} from "../../src/admission/store";

/**
 * A standalone admission actor for the cross-process smoke (plan 11, M9). It runs the EXACT host
 * admission path - `nodeAdmissionCaps` + `acquireAdmission`/`pollAdmission`/`releaseAdmission` with a
 * real `{ownerId, hostId, pid}` owner - in a real OS process, so the e2e proves cross-process capacity,
 * queue drain, and crash-stale reclaim for real (real pids, real `process.kill(pid, 0)` liveness, real
 * lease files), not just in-memory fakes.
 *
 * Invoked as: `tsx admission-actor.ts <mode> <key> <ownerId> <hostId> [capacity] [priority]` with
 * BELAY_STATE_HOME in the env (so the lease lands under the smoke's temp state home). It prints ONE OR
 * TWO machine-readable JSON lines (phase: initial | final); everything else goes to stderr.
 *
 *   - `acquire-once`: acquire, print the outcome, exit immediately WITHOUT releasing (probe a queued/
 *     acquired status, or seed a holder that then crashes for a stale-reclaim check).
 *   - `wait`: acquire (print the initial outcome), then poll until granted, print the final outcome,
 *     release, and exit - a queued waiter that drains once the holder releases.
 *   - `hold`: acquire, print the outcome, then stay alive heartbeating until SIGTERM, at which point it
 *     releases and exits - a live holder the others contend against (a SIGKILL is an uncatchable crash).
 */

const args = process.argv.slice(2);

/** A required positional arg, narrowed to `string` (exits the actor when absent). */
function requireArg(index: number, name: string): string {
  const value = args[index];
  if (!value) {
    console.error("usage: admission-actor <mode> <key> <ownerId> <hostId> [capacity] [priority]");
    console.error(`missing required argument: ${name}`);
    process.exit(2);
  }
  return value;
}

const mode = requireArg(0, "mode");
const key = requireArg(1, "key");
const ownerId = requireArg(2, "ownerId");
const hostId = requireArg(3, "hostId");
const capacityArg = args[4];
const priorityArg = args[5];

const caps = nodeAdmissionCaps();
const owner: AdmissionOwner = {
  ownerId,
  hostId,
  pid: process.pid,
  provider: "lmstudio",
  model: "test-model",
};
const capacity = capacityArg ? Number(capacityArg) : 1;
const priority = (priorityArg as AdmissionPriority) ?? "foreground";

function emit(phase: "initial" | "final", outcome: unknown): void {
  console.log(JSON.stringify({ pid: process.pid, phase, outcome }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const initial = await acquireAdmission(
    { key, owner, priority, estimate: NO_ESTIMATE, capacity },
    caps,
  );
  emit("initial", initial);

  if (mode === "acquire-once") {
    process.exit(0);
  }

  if (mode === "wait") {
    let final = initial;
    const deadline = Date.now() + 30_000;
    while (final.status === "queued" && Date.now() < deadline) {
      await sleep(100);
      const poll = await pollAdmission(key, ownerId, caps);
      if (poll.status === "acquired") {
        final = { status: "acquired" };
      } else if (poll.status === "gone") {
        final = await acquireAdmission(
          { key, owner, priority, estimate: NO_ESTIMATE, capacity },
          caps,
        );
      }
    }
    emit("final", final);
    await releaseAdmission(key, ownerId, caps);
    process.exit(0);
  }

  if (mode === "hold") {
    const heartbeat = setInterval(() => {
      void heartbeatAdmission(key, ownerId, caps);
    }, 500);
    const release = (): void => {
      clearInterval(heartbeat);
      void releaseAdmission(key, ownerId, caps).finally(() => process.exit(0));
    };
    process.on("SIGTERM", release);
    process.on("SIGINT", release);
    // Safety valve so a leaked actor never lingers if the parent dies without signaling.
    setTimeout(release, 60_000);
    return;
  }

  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

void main();

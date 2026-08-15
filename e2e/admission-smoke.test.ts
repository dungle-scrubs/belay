import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, waitFor } from "@belay/test-kit";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

/**
 * Cross-process local-admission smoke (plan 11, M9). The unit tests prove the lease/queue decision logic
 * over injected fakes; this proves the SAME logic across REAL OS processes contending on REAL lease files
 * for one resource - the cross-process contention the in-process V1 map could not cover. Each "host" is
 * an `admission-actor` child running the host's actual acquire path (`nodeAdmissionCaps` +
 * `acquireAdmission`/`pollAdmission`/`releaseAdmission`), so capacity enforcement, queue drain, and
 * crash reclaim are exercised with real pids and real `process.kill(pid, 0)` liveness, not mocks.
 *
 * Deterministic (no model, no network), so it runs in the required hermetic e2e lane.
 */

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = require.resolve("tsx/cli");
const ACTOR = join(REPO_ROOT, "apps", "agent-host", "test", "support", "admission-actor.ts");

interface ActorLine {
  readonly pid: number;
  readonly phase: "initial" | "final";
  readonly outcome: { readonly status: string; readonly position?: number };
}

let stateHome: string;
const live: ChildProcess[] = [];
let keySeq = 0;

beforeAll(() => {
  stateHome = tempDir("belay-admission-state-");
});

afterEach(() => {
  for (const child of live.splice(0)) {
    killGroup(child, "SIGKILL");
  }
});

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

/** A fresh resource key per test so the shared temp state home never cross-contaminates. */
function freshKey(): string {
  keySeq += 1;
  return `local-provider:lmstudio:http://localhost:1234/v1:model-${keySeq}`;
}

function spawnActor(mode: string, key: string, ownerId: string, hostId: string): ChildProcess {
  return spawn(process.execPath, [TSX_CLI, ACTOR, mode, key, ownerId, hostId], {
    cwd: REPO_ROOT,
    // The actor is host source run by tsx from the repo root; the @host/* alias (22.1 D-007)
    // resolves through the host tsconfig, which tsx only finds via an explicit pointer here.
    env: {
      ...process.env,
      BELAY_STATE_HOME: stateHome,
      TREVOR_DEBUG: "0",
      TSX_TSCONFIG_PATH: join(REPO_ROOT, "apps/agent-host/tsconfig.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

/** A buffered line reader over a child's stdout: `next()` resolves the next JSON line (or rejects with
 *  the captured stderr if the child exits first). Lets the `wait` actor's two lines be read in turn. */
function lineReader(child: ChildProcess): { next: () => Promise<ActorLine> } {
  const queued: ActorLine[] = [];
  const waiters: Array<{ resolve: (l: ActorLine) => void; reject: (e: Error) => void }> = [];
  let buf = "";
  let err = "";
  let exited = false;
  const pump = (): void => {
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const parsed = JSON.parse(line) as ActorLine;
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(parsed);
        } else {
          queued.push(parsed);
        }
      }
      nl = buf.indexOf("\n");
    }
  };
  child.stdout?.on("data", (d) => {
    buf += String(d);
    pump();
  });
  child.stderr?.on("data", (d) => {
    err += String(d);
  });
  child.on("exit", (code) => {
    exited = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`actor exited (${code}) before a line; stderr:\n${err}`));
    }
  });
  return {
    next: () =>
      new Promise<ActorLine>((resolve, reject) => {
        const ready = queued.shift();
        if (ready) {
          resolve(ready);
        } else if (exited) {
          reject(new Error(`actor already exited; stderr:\n${err}`));
        } else {
          waiters.push({ resolve, reject });
        }
      }),
  };
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
  });
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Spawns a holding actor and resolves once it reports its acquire outcome (then it stays alive). */
async function startHold(
  key: string,
  ownerId: string,
  hostId: string,
): Promise<{ line: ActorLine; child: ChildProcess }> {
  const child = spawnActor("hold", key, ownerId, hostId);
  live.push(child);
  const reader = lineReader(child);
  return { line: await reader.next(), child };
}

async function runOnce(
  mode: string,
  key: string,
  ownerId: string,
  hostId: string,
): Promise<ActorLine> {
  const child = spawnActor(mode, key, ownerId, hostId);
  return lineReader(child).next();
}

/** The active owner ids on a resource's lease file (matched by key), or [] when no file/holder. */
function activeOwners(key: string): string[] {
  const dir = join(stateHome, "admission");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      key: string;
      active: Array<{ owner: { ownerId: string } }>;
    };
    if (record.key === key) {
      return record.active.map((a) => a.owner.ownerId);
    }
  }
  return [];
}

test("a capacity-1 resource admits one process and queues the other, then drains on release", async () => {
  const key = freshKey();

  // Host A holds the only slot.
  const a = await startHold(key, "owner-a", "host-a");
  expect(a.line.outcome.status).toBe("acquired");
  expect(activeOwners(key)).toEqual(["owner-a"]);

  // Host B waits: it queues behind A (real cross-process contention).
  const b = spawnActor("wait", key, "owner-b", "host-b");
  live.push(b);
  const bReader = lineReader(b);
  const bInitial = await bReader.next();
  expect(bInitial.outcome.status).toBe("queued");
  expect(bInitial.outcome.position).toBe(0);

  // A releases (SIGTERM -> graceful release); B's poll then drains into the freed slot.
  killGroup(a.child, "SIGTERM");
  await exited(a.child);
  const bFinal = await bReader.next();
  expect(bFinal.outcome.status).toBe("acquired");
});

test("a crashed holder's slot is reclaimed by the next acquirer (real dead pid)", async () => {
  const key = freshKey();

  const a = await startHold(key, "owner-a", "host-a");
  expect(a.line.outcome.status).toBe("acquired");

  // Crash: SIGKILL (uncatchable) leaves the lease behind with owner-a still listed active. Wait until
  // the pid is truly gone so the next actor's liveness probe sees a dead holder.
  killGroup(a.child, "SIGKILL");
  await exited(a.child);
  await waitFor(() => pidGone(a.line.pid), { label: `pid ${a.line.pid} gone` });
  expect(activeOwners(key)).toEqual(["owner-a"]); // the lease survives the crash

  // B reaps the dead holder and acquires immediately.
  const b = await runOnce("acquire-once", key, "owner-b", "host-b");
  expect(b.outcome.status).toBe("acquired");
  expect(activeOwners(key)).toEqual(["owner-b"]);
});

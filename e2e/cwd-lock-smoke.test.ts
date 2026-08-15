import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, waitFor } from "@belay/test-kit";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

/**
 * Cross-process cwd-lock smoke (plan 01, M3). The unit tests prove the lock's decision logic over
 * injected fakes; this proves the SAME logic across REAL OS processes contending on REAL lock files
 * for a REAL managed git worktree - the cross-process risk the per-session lock could not cover. Each
 * "host" is a `cwd-lock-actor` child running the host's actual acquire path (`nodeCwdLockCaps` +
 * `acquireCwdLock`), so contention, handover, and crash-stale-takeover are exercised with real pids
 * and real `process.kill(pid, 0)` liveness, not mocks.
 *
 * Deterministic (no model, no lease, no network), so it runs in the required hermetic e2e lane. The
 * FULL two-host boot (two agent-host processes elected through the lease) is inherently timing-flaky
 * and was deliberately NOT made a default lane (D-003); it is reproduced manually instead - see the
 * runbook in `.plans/01-managed-worktree-hardening/artifacts/two-host-runbook.md`.
 */

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = require.resolve("tsx/cli");
const ACTOR = join(REPO_ROOT, "apps", "agent-host", "test", "support", "cwd-lock-actor.ts");

interface ActorOutput {
  readonly pid: number;
  readonly result: {
    readonly status: string;
    readonly heldBy?: { readonly sessionId: string };
    readonly previous?: { readonly sessionId: string };
  };
}

interface Actor {
  readonly out: ActorOutput;
  readonly child: ChildProcess;
}

let stateHome: string;
let repo: string;
const live: ChildProcess[] = [];

beforeAll(() => {
  stateHome = tempDir("belay-cwd-lock-state-");
  repo = tempDir("belay-cwd-lock-repo-");
  // A real git repo with one commit, so `git worktree add` has a base to cut from.
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "smoke@belay.test");
  git("config", "user.name", "Smoke");
  git("commit", "--allow-empty", "-q", "-m", "base");
});

afterEach(() => {
  // Never leak a held actor between tests: group-kill each launcher (and its tsx-spawned actor), then
  // prune the temp worktrees so they don't accumulate.
  for (const child of live.splice(0)) {
    killGroup(child, "SIGKILL");
  }
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "ignore" });
  } catch {
    // repo may already be gone
  }
});

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Creates a real managed worktree (a `git worktree add` under the temp state home) and returns it. */
function makeWorktree(name: string): string {
  const path = join(stateHome, ".worktrees", name);
  mkdirSync(join(stateHome, ".worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", `feat/${name}`, path], {
    cwd: repo,
    stdio: "ignore",
  });
  return path;
}

function spawnActor(mode: string, cwd: string, sessionId: string, hostId: string): ChildProcess {
  // `detached` makes the launcher a process-group leader, so a group signal reaches BOTH it and the
  // actor tsx spawns under it - letting a SIGKILL be a real crash and SIGTERM a real graceful stop.
  return spawn(process.execPath, [TSX_CLI, ACTOR, mode, cwd, sessionId, hostId], {
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

/** Signals a launcher's whole process group (the launcher + the actor it spawned). */
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

/** First stdout JSON line from a child, or a rejection carrying its captured stderr for diagnosis. */
function firstLine(child: ChildProcess): Promise<ActorOutput> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        resolve(JSON.parse(out.slice(0, nl)) as ActorOutput);
      }
    });
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    child.on("exit", (code) => {
      if (!out.includes("\n")) {
        reject(new Error(`actor produced no result (exit ${code}); stderr:\n${err}`));
      }
    });
  });
}

/** Runs a one-shot actor to completion and returns its result. */
async function runOnce(
  mode: string,
  cwd: string,
  sessionId: string,
  hostId: string,
): Promise<ActorOutput> {
  return firstLine(spawnActor(mode, cwd, sessionId, hostId));
}

/** Spawns a holding actor and resolves once it reports its acquire result (then it stays alive). */
async function startHold(cwd: string, sessionId: string, hostId: string): Promise<Actor> {
  const child = spawnActor("hold", cwd, sessionId, hostId);
  live.push(child);
  return { out: await firstLine(child), child };
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

/** True once a pid is gone from this process's point of view (the same check the lock makes). */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true; // ESRCH: the process is gone
  }
}

/** The lock record guarding a specific worktree (matched by its realpath), or null when none. The
 *  temp state home is shared across tests, so a lock is looked up by directory, not "the only file". */
function lockFor(wt: string): { sessionId: string; pid: number; cwd: string } | null {
  const dir = join(stateHome, "cwd-locks");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".lock"));
  } catch {
    return null;
  }
  const target = realpathSync(wt);
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      sessionId: string;
      pid: number;
      cwd: string;
    };
    if (record.cwd === target) {
      return record;
    }
  }
  return null;
}

test("a second live session is blocked, then takes over after the holder releases", async () => {
  const wt = makeWorktree("contend");

  // Session alpha takes and holds the lock.
  const alpha = await startHold(wt, "alpha-aaaa", "host-alpha");
  expect(alpha.out.result.status).toBe("acquired");
  expect(lockFor(wt)?.sessionId).toBe("alpha-aaaa");

  // A different live session targeting the same worktree is blocked (real cross-process conflict).
  const beta = await runOnce("acquire-once", wt, "beta-bbbb", "host-beta");
  expect(beta.result.status).toBe("conflict");
  expect(beta.result.heldBy?.sessionId).toBe("alpha-aaaa");
  expect(lockFor(wt)?.sessionId).toBe("alpha-aaaa"); // a conflict never overwrites

  // Alpha stops gracefully (SIGTERM -> the actor's release handler); beta can then take the directory.
  killGroup(alpha.child, "SIGTERM");
  await exited(alpha.child);
  expect(lockFor(wt)).toBeNull(); // released

  const beta2 = await runOnce("acquire-once", wt, "beta-bbbb", "host-beta2");
  expect(beta2.result.status).toBe("acquired");
  expect(lockFor(wt)?.sessionId).toBe("beta-bbbb");
});

test("a crashed holder's lock is reclaimed as stale by the next session (real dead pid)", async () => {
  const wt = makeWorktree("crash");

  const alpha = await startHold(wt, "alpha-aaaa", "host-alpha");
  expect(alpha.out.result.status).toBe("acquired");

  // Crash: SIGKILL (uncatchable) leaves the lock file behind with no release. Wait until the holder's
  // pid is truly gone, so the next actor's liveness probe sees a dead owner.
  killGroup(alpha.child, "SIGKILL");
  await exited(alpha.child);
  await waitFor(() => pidGone(alpha.out.pid), { label: `pid ${alpha.out.pid} gone` });
  expect(lockFor(wt)?.sessionId).toBe("alpha-aaaa"); // the lock survives the crash

  const beta = await runOnce("acquire-once", wt, "beta-bbbb", "host-beta");
  expect(beta.result.status).toBe("tookOverStale");
  expect(beta.result.previous?.sessionId).toBe("alpha-aaaa");
  expect(lockFor(wt)?.sessionId).toBe("beta-bbbb");
});

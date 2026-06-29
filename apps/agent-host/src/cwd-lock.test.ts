import { describe, expect, test } from "vitest";
import {
  acquireCwdLock,
  CWD_LOCK_STALE_MS,
  type CwdLockCaps,
  CwdLockConflict,
  type CwdLockFile,
  type CwdLockFs,
  cwdLockConflictMessage,
  cwdLockDoctorFact,
  cwdSwitchConflict,
  inspectCwdLock,
  refreshCwdLock,
  releaseCwdLock,
} from "./cwd-lock";

/** An in-memory CwdLockFs plus the backing store so a test can assert what was written. */
function memFs(): CwdLockFs & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    readFile: (path) => store.get(path) ?? null,
    writeFile: (path, content) => {
      store.set(path, content);
    },
    remove: (path) => {
      store.delete(path);
    },
  };
}

interface Harness {
  readonly caps: CwdLockCaps;
  readonly fs: CwdLockFs & { readonly store: Map<string, string> };
  readonly alive: Set<number>;
  setNow(ms: number): void;
}

/** Builds a controllable harness: injected clock, a mutable live-pid set, and a realpath alias map. */
function harness(
  over: {
    nowMs?: number;
    alive?: number[];
    realpath?: Record<string, string>;
    staleAfterMs?: number;
  } = {},
): Harness {
  const fs = memFs();
  const alive = new Set<number>(over.alive ?? []);
  const realpathMap = new Map<string, string>(Object.entries(over.realpath ?? {}));
  let nowMs = over.nowMs ?? 1_000_000;
  const caps: CwdLockCaps = {
    fs,
    realpath: (path) => realpathMap.get(path) ?? path,
    processAlive: (pid) => alive.has(pid),
    now: () => nowMs,
    dir: "/state/cwd-locks",
    staleAfterMs: over.staleAfterMs,
  };
  return {
    caps,
    fs,
    alive,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

const owner = (over: Partial<{ sessionId: string; hostId: string; pid: number }> = {}) => ({
  sessionId: over.sessionId ?? "alpha-1111",
  hostId: over.hostId ?? "host-a",
  pid: over.pid ?? 100,
});

/** Reads the single lock file the harness wrote (exactly one path is expected). */
function onlyLock(fs: CwdLockFs & { readonly store: Map<string, string> }): CwdLockFile {
  const values = [...fs.store.values()];
  expect(values).toHaveLength(1);
  const raw = values[0];
  if (raw === undefined) {
    throw new Error("expected exactly one lock file");
  }
  return JSON.parse(raw) as CwdLockFile;
}

describe("acquire", () => {
  test("takes an empty slot and stamps full owner metadata", () => {
    const h = harness({ nowMs: 5_000, alive: [100] });
    const result = acquireCwdLock("/repo", owner(), h.caps);

    expect(result.status).toBe("acquired");
    const file = onlyLock(h.fs);
    expect(file).toMatchObject({
      cwd: "/repo",
      sessionId: "alpha-1111",
      hostId: "host-a",
      pid: 100,
    });
    expect(file.acquiredAt).toBe(new Date(5_000).toISOString());
    expect(file.heartbeatAt).toBe(new Date(5_000).toISOString());
  });

  test("normalizes the cwd to its realpath identity: two aliases of one dir share a lock", () => {
    // Both a symlinked path and the canonical path resolve to the same realpath.
    const h = harness({
      alive: [100, 200],
      realpath: { "/link/to/repo": "/canonical/repo", "/canonical/repo": "/canonical/repo" },
    });

    const first = acquireCwdLock("/link/to/repo", owner({ pid: 100 }), h.caps);
    expect(first.status).toBe("acquired");
    expect(h.fs.store.size).toBe(1);

    // A different live session arriving via the canonical path hits the SAME lock -> conflict.
    const second = acquireCwdLock(
      "/canonical/repo",
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );
    expect(second.status).toBe("conflict");
    expect(h.fs.store.size).toBe(1);
    expect(onlyLock(h.fs).cwd).toBe("/canonical/repo");
  });

  test("a managed-worktree cwd and a non-worktree cwd obey the SAME path-ownership rule", () => {
    // The lock keys purely on realpath - it never inspects whether a path is a worktree. A worktree
    // path and a plain project path that resolve to the same realpath collide identically.
    const worktreePath = "/state/.worktrees/feat-x";
    const plainPath = "/elsewhere/feat-x";
    const h = harness({
      alive: [100, 200],
      realpath: { [worktreePath]: "/real/feat-x", [plainPath]: "/real/feat-x" },
    });

    expect(acquireCwdLock(worktreePath, owner({ pid: 100 }), h.caps).status).toBe("acquired");
    const viaPlain = acquireCwdLock(
      plainPath,
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );
    expect(viaPlain.status).toBe("conflict");
  });
});

describe("same-session re-take (leader/standby failover, restart)", () => {
  test("a different host/pid of the SAME session re-acquires rather than conflicting", () => {
    const h = harness({ nowMs: 1_000, alive: [100, 101] });
    acquireCwdLock("/repo", owner({ hostId: "host-a", pid: 100 }), h.caps);

    h.setNow(2_000);
    const result = acquireCwdLock("/repo", owner({ hostId: "host-b", pid: 101 }), h.caps);

    expect(result.status).toBe("reacquired");
    const file = onlyLock(h.fs);
    expect(file.pid).toBe(101);
    expect(file.hostId).toBe("host-b");
    // A genuine handover resets acquiredAt to the new owner's start.
    expect(file.acquiredAt).toBe(new Date(2_000).toISOString());
  });

  test("the same exact process re-acquiring preserves acquiredAt and only moves the heartbeat", () => {
    const h = harness({ nowMs: 1_000, alive: [100] });
    acquireCwdLock("/repo", owner({ pid: 100 }), h.caps);

    h.setNow(9_000);
    const result = acquireCwdLock("/repo", owner({ pid: 100 }), h.caps);

    expect(result.status).toBe("reacquired");
    const file = onlyLock(h.fs);
    expect(file.acquiredAt).toBe(new Date(1_000).toISOString());
    expect(file.heartbeatAt).toBe(new Date(9_000).toISOString());
  });
});

describe("conflict (different live session)", () => {
  test("reports the holder with liveness + heartbeat age and does not overwrite the lock", () => {
    const h = harness({ nowMs: 100_000, alive: [100, 200] });
    acquireCwdLock("/repo", owner({ sessionId: "alpha-1111", hostId: "host-a", pid: 100 }), h.caps);
    const before = onlyLock(h.fs);

    h.setNow(130_000); // 30s later
    const result = acquireCwdLock(
      "/repo",
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.heldBy.sessionId).toBe("alpha-1111");
    expect(result.heldBy.pid).toBe(100);
    expect(result.heldBy.alive).toBe(true);
    expect(result.heldBy.heartbeatAgeMs).toBe(30_000);
    // Lock bytes are untouched by a conflicting acquire.
    expect(onlyLock(h.fs)).toEqual(before);
  });

  test("the CwdLockConflict error message names owner, session, pid, and a safe recommendation", () => {
    const h = harness({ nowMs: 50_000, alive: [100, 200] });
    acquireCwdLock(
      "/repo",
      owner({ sessionId: "alpha-1111", hostId: "host-aaaa", pid: 100 }),
      h.caps,
    );
    const result = acquireCwdLock(
      "/repo",
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );
    if (result.status !== "conflict") throw new Error("expected conflict");

    const error = new CwdLockConflict({ cwd: "/repo", heldBy: result.heldBy });
    expect(error._tag).toBe("CwdLockConflict");
    expect(error.message).toContain("/repo");
    expect(error.message).toContain("session alpha-1111");
    expect(error.message).toContain("pid 100");
    expect(error.message).toContain("/doctor");
    // The same wording is available standalone for diagnostics.
    expect(cwdLockConflictMessage("/repo", result.heldBy)).toBe(error.message);
  });
});

describe("stale takeover", () => {
  test("a lock whose owner pid is dead is taken over", () => {
    const h = harness({ nowMs: 10_000, alive: [200] }); // 100 is NOT alive
    acquireCwdLock("/repo", owner({ sessionId: "alpha-1111", pid: 100 }), h.caps);

    const result = acquireCwdLock(
      "/repo",
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );

    expect(result.status).toBe("tookOverStale");
    if (result.status !== "tookOverStale") return;
    expect(result.previous.sessionId).toBe("alpha-1111");
    expect(result.previous.alive).toBe(false);
    expect(onlyLock(h.fs).sessionId).toBe("beta-2222");
  });

  test("a live-pid lock past the heartbeat-staleness window is taken over (pid reuse / abandoned)", () => {
    const h = harness({ nowMs: 0, alive: [100, 200], staleAfterMs: 60_000 });
    acquireCwdLock("/repo", owner({ sessionId: "alpha-1111", pid: 100 }), h.caps);

    h.setNow(120_000); // heartbeat now 120s old, past the 60s window, even though pid 100 "is alive"
    const result = acquireCwdLock(
      "/repo",
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );
    expect(result.status).toBe("tookOverStale");
  });

  test("a fresh, live lock within the window is NOT stolen", () => {
    const h = harness({ nowMs: 0, alive: [100, 200], staleAfterMs: 60_000 });
    acquireCwdLock("/repo", owner({ sessionId: "alpha-1111", pid: 100 }), h.caps);

    h.setNow(30_000); // within the 60s window
    const result = acquireCwdLock(
      "/repo",
      owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }),
      h.caps,
    );
    expect(result.status).toBe("conflict");
  });

  test("defaults to the standard staleness window when none is injected", () => {
    const h = harness({ nowMs: 0, alive: [100, 200] }); // no staleAfterMs override
    acquireCwdLock("/repo", owner({ sessionId: "alpha-1111", pid: 100 }), h.caps);

    h.setNow(CWD_LOCK_STALE_MS + 1);
    expect(
      acquireCwdLock("/repo", owner({ sessionId: "beta-2222", pid: 200 }), h.caps).status,
    ).toBe("tookOverStale");
  });
});

describe("malformed / missing lock files", () => {
  test("a corrupt lock file is treated as no lock", () => {
    const h = harness({ nowMs: 1_000, alive: [100] });
    // Seed garbage at the path the lock would use.
    const probe = inspectCwdLock("/repo", h.caps);
    h.fs.writeFile(probe.path, "{ not json");

    const result = acquireCwdLock("/repo", owner(), h.caps);
    expect(result.status).toBe("acquired");
  });

  test("a partial lock record (missing fields) is treated as no lock", () => {
    const h = harness({ nowMs: 1_000, alive: [100] });
    const probe = inspectCwdLock("/repo", h.caps);
    h.fs.writeFile(probe.path, JSON.stringify({ cwd: "/repo", pid: 100 }));

    expect(acquireCwdLock("/repo", owner(), h.caps).status).toBe("acquired");
  });
});

describe("refresh", () => {
  test("the owning process moves the heartbeat forward", () => {
    const h = harness({ nowMs: 1_000, alive: [100] });
    acquireCwdLock("/repo", owner({ pid: 100 }), h.caps);

    h.setNow(7_000);
    const result = refreshCwdLock("/repo", owner({ pid: 100 }), h.caps);

    expect(result.refreshed).toBe(true);
    expect(onlyLock(h.fs).heartbeatAt).toBe(new Date(7_000).toISOString());
  });

  test("a non-owner cannot refresh (a takeover happened)", () => {
    const h = harness({ nowMs: 1_000, alive: [100, 200] });
    acquireCwdLock("/repo", owner({ hostId: "host-a", pid: 100 }), h.caps);

    const result = refreshCwdLock("/repo", owner({ hostId: "host-b", pid: 200 }), h.caps);
    expect(result).toEqual({ refreshed: false, reason: "not-owner" });
  });

  test("refreshing a vanished lock reports missing", () => {
    const h = harness({ nowMs: 1_000, alive: [100] });
    expect(refreshCwdLock("/repo", owner({ pid: 100 }), h.caps)).toEqual({
      refreshed: false,
      reason: "missing",
    });
  });
});

describe("release", () => {
  test("the owning process removes its lock", () => {
    const h = harness({ nowMs: 1_000, alive: [100] });
    acquireCwdLock("/repo", owner({ pid: 100 }), h.caps);

    expect(releaseCwdLock("/repo", owner({ pid: 100 }), h.caps)).toEqual({ released: true });
    expect(h.fs.store.size).toBe(0);
  });

  test("never steals a successor's lock", () => {
    const h = harness({ nowMs: 1_000, alive: [100, 200] });
    // Session beta took over (different host/pid); the old host-a process tries to release.
    acquireCwdLock("/repo", owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }), h.caps);

    const result = releaseCwdLock("/repo", owner({ hostId: "host-a", pid: 100 }), h.caps);
    expect(result).toEqual({ released: false });
    expect(h.fs.store.size).toBe(1);
  });
});

describe("inspect (read-only diagnostics)", () => {
  test("reports owner, heartbeat age, and liveness without mutating", () => {
    const h = harness({ nowMs: 0, alive: [100] });
    acquireCwdLock("/repo", owner({ pid: 100 }), h.caps);
    const bytesBefore = onlyLock(h.fs);

    h.setNow(45_000);
    const view = inspectCwdLock("/repo", h.caps);

    expect(view.file?.sessionId).toBe("alpha-1111");
    expect(view.owner?.heartbeatAgeMs).toBe(45_000);
    expect(view.owner?.alive).toBe(true);
    expect(view.stale).toBe(false);
    // Inspection never writes.
    expect(onlyLock(h.fs)).toEqual(bytesBefore);
  });

  test("classifies a dead-owner lock as stale", () => {
    const h = harness({ nowMs: 0, alive: [] }); // owner pid never alive
    acquireCwdLock("/repo", owner({ pid: 100 }), h.caps);

    const view = inspectCwdLock("/repo", h.caps);
    expect(view.stale).toBe(true);
    expect(view.owner?.alive).toBe(false);
  });

  test("reports an empty slot as no lock", () => {
    const h = harness({ nowMs: 0 });
    const view = inspectCwdLock("/repo", h.caps);
    expect(view.file).toBeNull();
    expect(view.owner).toBeNull();
    expect(view.stale).toBe(false);
  });
});

describe("doctor fact (state relative to this host's session)", () => {
  test("a free directory is unlocked", () => {
    const h = harness({ nowMs: 0 });
    const fact = cwdLockDoctorFact("/repo", "alpha-1111", h.caps);
    expect(fact.state).toBe("unlocked");
    expect(fact.owner).toBeUndefined();
  });

  test("our own session's lock reads as held", () => {
    const h = harness({ nowMs: 0, alive: [100] });
    acquireCwdLock("/repo", owner({ sessionId: "alpha-1111", pid: 100 }), h.caps);
    const fact = cwdLockDoctorFact("/repo", "alpha-1111", h.caps);
    expect(fact.state).toBe("held");
    expect(fact.owner).toContain("session alpha-1111");
  });

  test("a different live session reads as contended", () => {
    const h = harness({ nowMs: 0, alive: [200] });
    acquireCwdLock("/repo", owner({ sessionId: "beta-2222", pid: 200 }), h.caps);
    const fact = cwdLockDoctorFact("/repo", "alpha-1111", h.caps);
    expect(fact.state).toBe("contended");
    expect(fact.owner).toContain("session beta-2222");
  });

  test("a dead-owner lock from another session reads as stale", () => {
    const h = harness({ nowMs: 0, alive: [] });
    acquireCwdLock("/repo", owner({ sessionId: "beta-2222", pid: 200 }), h.caps);
    expect(cwdLockDoctorFact("/repo", "alpha-1111", h.caps).state).toBe("stale");
  });
});

describe("switch gate (cwdSwitchConflict)", () => {
  test("blocks a switch into a directory a different live session owns", () => {
    const h = harness({ nowMs: 0, alive: [200] });
    acquireCwdLock("/wt", owner({ sessionId: "beta-2222", hostId: "host-b", pid: 200 }), h.caps);

    const conflict = cwdSwitchConflict("/wt", "alpha-1111", h.caps);
    expect(conflict).not.toBeNull();
    expect(conflict?._tag).toBe("CwdLockConflict");
    expect(conflict?.heldBy.sessionId).toBe("beta-2222");
  });

  test("allows a switch into a directory owned by the target's own session (a resume)", () => {
    const h = harness({ nowMs: 0, alive: [200] });
    acquireCwdLock("/wt", owner({ sessionId: "wt-7777", pid: 200 }), h.caps);
    expect(cwdSwitchConflict("/wt", "wt-7777", h.caps)).toBeNull();
  });

  test("allows a switch when the existing lock is stale", () => {
    const h = harness({ nowMs: 0, alive: [] }); // owner pid dead
    acquireCwdLock("/wt", owner({ sessionId: "beta-2222", pid: 200 }), h.caps);
    expect(cwdSwitchConflict("/wt", "alpha-1111", h.caps)).toBeNull();
  });

  test("allows a switch into a free directory", () => {
    const h = harness({ nowMs: 0 });
    expect(cwdSwitchConflict("/wt", "alpha-1111", h.caps)).toBeNull();
  });
});

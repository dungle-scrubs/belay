import { describe, expect, test } from "vitest";
import { driveSerialRun } from "./driver";
import { newSerialRun, type SerialRun } from "./journal";
import { type SerialWorktreeOps, serialDriverCaps } from "./node";

/** An in-memory worktree-ops fake: create returns deterministic ids, the rest are scriptable. */
function fakeOps(over: Partial<SerialWorktreeOps> = {}): SerialWorktreeOps {
  return {
    create: (planId) => ({ ok: true, worktreeId: `wt-${planId}`, sessionId: `s-${planId}` }),
    cleanState: () => ({ clean: true }),
    merge: () => ({ ok: true }),
    remove: () => ({ ok: true }),
    ...over,
  };
}

describe("serialDriverCaps wires worktree ops + the implement seam into the driver", () => {
  test("a green run drives every plan through create -> implement -> merge -> delete", async () => {
    let clock = 0;
    const saves: SerialRun[] = [];
    const implemented: string[] = [];
    const caps = serialDriverCaps({
      ops: fakeOps(),
      implement: async (planId) => {
        implemented.push(planId);
        return { green: true };
      },
      persist: (run) => void saves.push(run),
      now: () => `t${clock++}`,
    });

    const run = await driveSerialRun(newSerialRun("r", ["03-a", "04-b"], "t0"), caps);
    expect(run.status).toBe("complete");
    expect(implemented).toEqual(["03-a", "04-b"]);
    expect(saves.at(-1)?.plans.every((p) => p.phase === "merged")).toBe(true);
  });

  test("a worktree merge failure halts the run with the tree preserved", async () => {
    const caps = serialDriverCaps({
      ops: fakeOps({ merge: () => ({ ok: false, error: "CONFLICT" }) }),
      implement: async () => ({ green: true }),
      persist: () => {},
      now: () => "t",
    });

    const run = await driveSerialRun(newSerialRun("r", ["a"], "t0"), caps);
    expect(run.status).toBe("halted");
    expect(run.plans[0]?.haltReason).toMatch(/merge conflict: CONFLICT/);
  });

  test("a dirty tree (cleanState) halts before merge", async () => {
    let merged = false;
    const caps = serialDriverCaps({
      ops: fakeOps({
        cleanState: () => ({ clean: false, reason: "uncommitted changes" }),
        merge: () => {
          merged = true;
          return { ok: true };
        },
      }),
      implement: async () => ({ green: true }),
      persist: () => {},
      now: () => "t",
    });

    const run = await driveSerialRun(newSerialRun("r", ["a"], "t0"), caps);
    expect(run.status).toBe("halted");
    expect(merged).toBe(false);
  });
});

import { describe, expect, test } from "vitest";
import {
  type CleanCheck,
  type CreateEnterOutcome,
  disposeCurrentPlan,
  driveOnePlan,
  driveSerialRun,
  type GitOutcome,
  type ImplementOutcome,
  type SerialDriverCaps,
  serialNext,
} from "./driver";
import { advancePlan, newSerialRun, type SerialRun } from "./journal";

interface Script {
  createEnter?: (planId: string) => CreateEnterOutcome;
  implement?: (planId: string) => ImplementOutcome;
  inspect?: (worktreeId: string) => CleanCheck;
  merge?: (worktreeId: string) => GitOutcome;
  remove?: (worktreeId: string) => GitOutcome;
}

interface Harness {
  readonly caps: SerialDriverCaps;
  readonly calls: string[];
  readonly saves: SerialRun[];
  /** The high-water mark of simultaneously-alive (created-but-not-removed) worktrees. */
  maxAlive(): number;
}

function harness(script: Script = {}): Harness {
  const calls: string[] = [];
  const saves: SerialRun[] = [];
  let alive = 0;
  let peak = 0;
  let clock = 0;
  const caps: SerialDriverCaps = {
    createEnter: async (planId) => {
      calls.push(`createEnter:${planId}`);
      const out = script.createEnter?.(planId) ?? {
        ok: true,
        worktreeId: `wt-${planId}`,
        sessionId: `s-${planId}`,
      };
      if (out.ok) {
        alive += 1;
        peak = Math.max(peak, alive);
      }
      return out;
    },
    implement: async (planId, sessionId) => {
      calls.push(`implement:${planId}:${sessionId}`);
      return script.implement?.(planId) ?? { green: true };
    },
    inspect: async (worktreeId) => {
      calls.push(`inspect:${worktreeId}`);
      return script.inspect?.(worktreeId) ?? { clean: true };
    },
    merge: async (worktreeId) => {
      calls.push(`merge:${worktreeId}`);
      return script.merge?.(worktreeId) ?? { ok: true };
    },
    remove: async (worktreeId) => {
      calls.push(`remove:${worktreeId}`);
      const out = script.remove?.(worktreeId) ?? { ok: true };
      if (out.ok) {
        alive -= 1;
      }
      return out;
    },
    now: () => `t${clock++}`,
    persist: (run) => void saves.push(run),
  };
  return { caps, calls, saves, maxAlive: () => peak };
}

describe("driveSerialRun - happy path", () => {
  test("implements a queue one tree at a time, merging + deleting each", async () => {
    const h = harness();
    const run = await driveSerialRun(newSerialRun("r", ["03-a", "04-b"], "t0"), h.caps);

    expect(run.status).toBe("complete");
    expect(run.plans.map((p) => p.phase)).toEqual(["merged", "merged"]);
    // Strictly serial: plan 04's tree is created only after plan 03's is removed.
    expect(h.calls).toEqual([
      "createEnter:03-a",
      "implement:03-a:s-03-a",
      "inspect:wt-03-a",
      "merge:wt-03-a",
      "remove:wt-03-a",
      "createEnter:04-b",
      "implement:04-b:s-04-b",
      "inspect:wt-04-b",
      "merge:wt-04-b",
      "remove:wt-04-b",
    ]);
  });

  test("never holds two mutating worktrees at once", async () => {
    const h = harness();
    await driveSerialRun(newSerialRun("r", ["a", "b", "c"], "t0"), h.caps);
    expect(h.maxAlive()).toBe(1);
  });

  test("persists the journal at every transition (durable resume points)", async () => {
    const h = harness();
    await driveSerialRun(newSerialRun("r", ["a"], "t0"), h.caps);
    // tree-created -> implementing -> committed -> merged = 4 saves for one plan.
    expect(h.saves.map((r) => r.plans[0]?.phase)).toEqual([
      "tree-created",
      "implementing",
      "committed",
      "merged",
    ]);
  });
});

describe("driveSerialRun - halts preserve the tree", () => {
  test("a failed create/enter halts the run before any implement", async () => {
    const h = harness({ createEnter: () => ({ ok: false, error: "cwd lock held" }) });
    const run = await driveSerialRun(newSerialRun("r", ["a", "b"], "t0"), h.caps);

    expect(run.status).toBe("halted");
    expect(run.plans[0]).toMatchObject({ phase: "halted" });
    expect(run.plans[0]?.haltReason).toMatch(/create\/enter failed: cwd lock held/);
    expect(run.plans[1]?.phase).toBe("queued"); // never reached
    expect(h.calls).toEqual(["createEnter:a"]);
  });

  test("a red implementation halts and never merges or deletes", async () => {
    const h = harness({ implement: () => ({ green: false, detail: "3 tests failing" }) });
    const run = await driveSerialRun(newSerialRun("r", ["a"], "t0"), h.caps);

    expect(run.status).toBe("halted");
    expect(run.plans[0]?.haltReason).toMatch(/implementation red: 3 tests failing/);
    expect(h.calls).not.toContain("merge:wt-a");
    expect(h.calls).not.toContain("remove:wt-a");
  });

  test("a dirty/unmergeable tree halts before the merge", async () => {
    const h = harness({ inspect: () => ({ clean: false, reason: "uncommitted changes" }) });
    const run = await driveSerialRun(newSerialRun("r", ["a"], "t0"), h.caps);

    expect(run.status).toBe("halted");
    expect(run.plans[0]?.haltReason).toMatch(/tree not clean: uncommitted changes/);
    expect(h.calls).not.toContain("merge:wt-a");
  });

  test("a merge conflict halts with the tree preserved (never deleted)", async () => {
    const h = harness({ merge: () => ({ ok: false, error: "CONFLICT in foo.ts" }) });
    const run = await driveSerialRun(newSerialRun("r", ["a"], "t0"), h.caps);

    expect(run.status).toBe("halted");
    expect(run.plans[0]?.haltReason).toMatch(/merge conflict: CONFLICT in foo.ts/);
    expect(h.calls).toContain("merge:wt-a");
    expect(h.calls).not.toContain("remove:wt-a"); // tree + branch left intact
  });
});

describe("driveOnePlan - resume from a mid-lifecycle journal", () => {
  test("resumes a tree-created plan: implements + disposes, no re-create", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a"], "t0");
    run = advancePlan(
      run,
      "a",
      { phase: "tree-created", worktreeId: "wt-a", sessionId: "s-a" },
      "t1",
    );

    run = await driveOnePlan(run, "a", h.caps);
    expect(run.plans[0]?.phase).toBe("merged");
    expect(h.calls).not.toContain("createEnter:a"); // create skipped on resume
    expect(h.calls).toEqual(["implement:a:s-a", "inspect:wt-a", "merge:wt-a", "remove:wt-a"]);
  });

  test("resumes a committed plan: only disposes (no re-create, no re-implement)", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a"], "t0");
    run = advancePlan(run, "a", { phase: "committed", worktreeId: "wt-a", sessionId: "s-a" }, "t1");

    run = await driveOnePlan(run, "a", h.caps);
    expect(run.plans[0]?.phase).toBe("merged");
    expect(h.calls).toEqual(["inspect:wt-a", "merge:wt-a", "remove:wt-a"]);
  });

  test("a full run resumes mid-sequence and never re-merges a completed plan", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a", "b"], "t0");
    run = advancePlan(run, "a", { phase: "merged" }, "t1"); // a already done in a prior run

    run = await driveSerialRun(run, h.caps);
    expect(run.status).toBe("complete");
    // Only b is acted on; a is never re-created or re-merged.
    expect(h.calls).toEqual([
      "createEnter:b",
      "implement:b:s-b",
      "inspect:wt-b",
      "merge:wt-b",
      "remove:wt-b",
    ]);
  });
});

describe("host-driven controllers (serialNext / disposeCurrentPlan)", () => {
  test("serialNext creates the next tree and reports the in-progress plan", async () => {
    const h = harness();
    const { run, plan } = await serialNext(newSerialRun("r", ["a", "b"], "t0"), h.caps);

    expect(h.calls).toEqual(["createEnter:a"]); // only creates, never implements/merges
    expect(plan?.planId).toBe("a");
    expect(plan?.phase).toBe("tree-created");
    expect(run.plans[0]).toMatchObject({ worktreeId: "wt-a", sessionId: "s-a" });
  });

  test("serialNext is a no-op once the current plan's tree already exists", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a"], "t0");
    run = advancePlan(run, "a", { phase: "tree-created", worktreeId: "wt-a" }, "t1");
    const result = await serialNext(run, h.caps);
    expect(h.calls).toEqual([]); // does not re-create
    expect(result.plan?.planId).toBe("a");
  });

  test("disposeCurrentPlan green-disposes the in-progress plan through the gate", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a", "b"], "t0");
    run = advancePlan(run, "a", { phase: "tree-created", worktreeId: "wt-a" }, "t1");

    run = await disposeCurrentPlan(run, h.caps, { green: true });
    expect(run.plans[0]?.phase).toBe("merged");
    expect(h.calls).toEqual(["inspect:wt-a", "merge:wt-a", "remove:wt-a"]); // no implement
    expect(run.status).toBe("running"); // b still queued
  });

  test("disposeCurrentPlan halts the in-progress plan on a red report, preserving its tree", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a"], "t0");
    run = advancePlan(run, "a", { phase: "tree-created", worktreeId: "wt-a" }, "t1");

    run = await disposeCurrentPlan(run, h.caps, { green: false, detail: "gate red" });
    expect(run.status).toBe("halted");
    expect(run.plans[0]?.haltReason).toMatch(/implementation red: gate red/);
    expect(h.calls).not.toContain("merge:wt-a");
  });

  test("a serialNext/implement/dispose loop drives a 2-plan run to complete", async () => {
    const h = harness();
    let run = newSerialRun("r", ["a", "b"], "t0");
    for (let i = 0; i < 2; i += 1) {
      const next = await serialNext(run, h.caps);
      run = next.run;
      // (the agent implements here, off-band)
      run = await disposeCurrentPlan(run, h.caps, { green: true });
    }
    expect(run.status).toBe("complete");
    expect(run.plans.every((p) => p.phase === "merged")).toBe(true);
  });
});

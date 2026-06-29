import { describe, expect, test } from "vitest";
import type { WorktreeFs } from "../worktrees/registry";
import {
  advancePlan,
  listRuns,
  loadRun,
  newSerialRun,
  nextPlan,
  runStatusFor,
  type SerialRun,
  saveRun,
} from "./journal";

const HOME = "/state";

function fakeFs(): WorktreeFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    exists: (p) => files.has(p),
  };
}

describe("newSerialRun + nextPlan", () => {
  test("seeds every queued plan and points at the first", () => {
    const run = newSerialRun("run-1", ["03-a", "04-b"], "t0");
    expect(run.status).toBe("running");
    expect(run.plans.map((p) => p.phase)).toEqual(["queued", "queued"]);
    expect(nextPlan(run)?.planId).toBe("03-a");
  });
});

describe("advancePlan + resume", () => {
  test("resume skips a merged plan and lands on the next un-disposed one", () => {
    let run = newSerialRun("run-1", ["03-a", "04-b", "05-c"], "t0");
    run = advancePlan(run, "03-a", { phase: "merged" }, "t1");
    expect(nextPlan(run)?.planId).toBe("04-b");
    expect(run.status).toBe("running");
  });

  test("a run is complete only once every plan is merged", () => {
    let run = newSerialRun("run-1", ["03-a", "04-b"], "t0");
    run = advancePlan(run, "03-a", { phase: "merged" }, "t1");
    expect(run.status).toBe("running");
    run = advancePlan(run, "04-b", { phase: "merged" }, "t2");
    expect(run.status).toBe("complete");
    expect(nextPlan(run)).toBeNull();
  });

  test("a halted plan stops resume and marks the run halted, preserving its reason", () => {
    let run = newSerialRun("run-1", ["03-a", "04-b"], "t0");
    run = advancePlan(run, "03-a", { phase: "merged" }, "t1");
    run = advancePlan(
      run,
      "04-b",
      { phase: "halted", haltReason: "tests failing", worktreeId: "wt9" },
      "t2",
    );
    expect(run.status).toBe("halted");
    expect(nextPlan(run)).toBeNull(); // never advances past a halt
    const halted = run.plans.find((p) => p.planId === "04-b");
    expect(halted?.haltReason).toBe("tests failing");
    expect(halted?.worktreeId).toBe("wt9");
  });

  test("carries worktree + session ids onto the entry and restamps updatedAt", () => {
    let run = newSerialRun("run-1", ["03-a"], "t0");
    run = advancePlan(
      run,
      "03-a",
      { phase: "tree-created", worktreeId: "wt1", sessionId: "s1" },
      "t1",
    );
    const entry = run.plans[0];
    expect(entry).toMatchObject({ phase: "tree-created", worktreeId: "wt1", sessionId: "s1" });
    expect(entry?.updatedAt).toBe("t1");
    expect(run.updatedAt).toBe("t1");
  });
});

describe("runStatusFor", () => {
  test("halt dominates a complete-looking set", () => {
    expect(
      runStatusFor([
        { planId: "a", phase: "merged", updatedAt: "t" },
        { planId: "b", phase: "halted", updatedAt: "t" },
      ]),
    ).toBe("halted");
  });
});

describe("persistence + reopen", () => {
  test("a saved run round-trips and is re-openable by id", () => {
    const fs = fakeFs();
    const run = newSerialRun("run-42", ["03-a"], "t0");
    saveRun(fs, HOME, run);
    expect(loadRun(fs, HOME, "run-42")).toEqual(run);
    expect(loadRun(fs, HOME, "nope")).toBeNull();
  });

  test("saving the same run id replaces it (the journal advances in place)", () => {
    const fs = fakeFs();
    let run = newSerialRun("run-1", ["03-a"], "t0");
    saveRun(fs, HOME, run);
    run = advancePlan(run, "03-a", { phase: "merged" }, "t1");
    saveRun(fs, HOME, run);
    expect(loadRun(fs, HOME, "run-1")?.status).toBe("complete");
    expect(listRuns(fs, HOME)).toHaveLength(1);
  });

  test("listRuns returns newest-updated first", () => {
    const fs = fakeFs();
    saveRun(fs, HOME, { ...newSerialRun("old", ["a"], "t0"), updatedAt: "2026-01-01" });
    saveRun(fs, HOME, { ...newSerialRun("new", ["a"], "t0"), updatedAt: "2026-06-01" });
    expect(listRuns(fs, HOME).map((r) => r.runId)).toEqual(["new", "old"]);
  });

  test("a malformed registry yields no runs rather than throwing", () => {
    const fs = fakeFs();
    fs.files.set("/state/serial-runs.json", "{ not json");
    expect(listRuns(fs, HOME)).toEqual([]);
    expect(loadRun(fs, HOME, "x")).toBeNull();
  });

  test("drops malformed entries while keeping well-formed ones", () => {
    const fs = fakeFs();
    const good: SerialRun = newSerialRun("good", ["a"], "t0");
    fs.files.set("/state/serial-runs.json", JSON.stringify({ good, bad: { runId: 5 } }));
    expect(listRuns(fs, HOME).map((r) => r.runId)).toEqual(["good"]);
  });
});

import { describe, expect, test } from "vitest";
import type { WorktreeFs } from "../worktrees/registry";
import { type SerialRunStartDeps, serialRunSeedPrompt, startSerialRun } from "./entry";
import { loadRun, type SerialRun, saveRun } from "./journal";

const AVAILABLE = [
  "03-nested-command-menu",
  "04-archive-browser-and-delete",
  "05-compact-transcript-layout",
];

function fakeFs(): WorktreeFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    exists: (p) => files.has(p),
  };
}

interface Harness {
  readonly deps: SerialRunStartDeps;
  readonly handoffs: string[];
  saved(): SerialRun | null;
}

function harness(over: Partial<SerialRunStartDeps> = {}): Harness {
  const fs = fakeFs();
  const handoffs: string[] = [];
  const deps: SerialRunStartDeps = {
    availablePlans: () => AVAILABLE,
    newRunId: () => "run-7",
    now: () => "t0",
    saveRun: (run) => saveRun(fs, "/state", run),
    handoff: async (prompt) => {
      handoffs.push(prompt);
      return { ok: true, targetSessionId: "sess-target" };
    },
    ...over,
  };
  return { deps, handoffs, saved: () => loadRun(fs, "/state", "run-7") };
}

describe("startSerialRun", () => {
  test("records a durable run, hands off, and frees the launching session", async () => {
    const h = harness();
    const result = await startSerialRun("implement 03 04 05", h.deps);

    expect(result.ok).toBe(true);
    expect(result.runId).toBe("run-7");
    expect(result.targetSessionId).toBe("sess-target");

    // The journal is persisted (re-openable by id) with the parsed queue, all queued.
    const run = h.saved();
    expect(run?.plans.map((p) => p.planId)).toEqual([
      "03-nested-command-menu",
      "04-archive-browser-and-delete",
      "05-compact-transcript-layout",
    ]);
    expect(run?.status).toBe("running");

    // The handoff seed prompt names the run id and the plans (so the spawned run can drive it).
    expect(h.handoffs).toHaveLength(1);
    expect(h.handoffs[0]).toContain("run-7");
    expect(h.handoffs[0]).toContain("03-nested-command-menu");
  });

  test("an unparseable request never records a run or hands off", async () => {
    const h = harness();
    const result = await startSerialRun("implement 99", h.deps);

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/no plan numbered 99/);
    expect(h.saved()).toBeNull(); // nothing persisted
    expect(h.handoffs).toEqual([]); // launching session untouched
  });

  test("records the run but reports failure when the handoff itself fails", async () => {
    const h = harness({ handoff: async () => ({ ok: false }) });
    const result = await startSerialRun("implement 03", h.deps);

    expect(result.ok).toBe(false);
    expect(result.runId).toBe("run-7");
    expect(h.saved()).not.toBeNull(); // journal persisted before the handoff attempt
  });
});

describe("serialRunSeedPrompt", () => {
  test("names the run id, the ordered queue, and the disposition contract", () => {
    const prompt = serialRunSeedPrompt("run-1", ["03-a", "04-b"]);
    expect(prompt).toContain("run-1");
    expect(prompt).toContain("03-a, 04-b");
    expect(prompt).toMatch(/one worktree at a time/i);
    expect(prompt).toMatch(/\/serial-next run-1/);
    expect(prompt).toMatch(/\/serial-dispose run-1/);
  });
});

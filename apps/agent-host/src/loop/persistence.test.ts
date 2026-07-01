import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopSnapshot } from "@trevor/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLoopPersistence } from "./persistence";
import type { LoopIterationRunner } from "./runner";
import { LoopScheduler, type SchedulerClock } from "./scheduler";
import { LoopStore } from "./store";

/** A fixed clock (time never moves; timers never fire) - deterministic next-run without real epoch values. */
const fixedClock: SchedulerClock = { now: () => 1_000, setTimer: () => () => {} };

/**
 * Durable loop persistence + restart (plan 17, M6 tasks 5-6): a durable loop's last-known status + next-run
 * survive a host restart; a session loop is never written.
 */

const idleRunner: LoopIterationRunner = {
  // A cadence an hour out never fires during a test, so this is never actually called.
  run: () => Promise.resolve({ ok: true, summary: "" }),
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trevor-loop-persist-"));
  file = join(dir, "loops.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loop persistence file (M6)", () => {
  it("round-trips a saved record and tolerates a missing file", () => {
    const persistence = createLoopPersistence(file);
    expect(persistence.load()).toEqual([]); // missing file -> empty
    persistence.save({
      id: "loop_1",
      status: "running",
      completed: 2,
      nextRun: 12_345,
      spec: { runner: "process", durability: "durable", action: "x", everyMs: 1000 },
    });
    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.status).toBe("running");
    expect(loaded[0]?.nextRun).toBe(12_345);
  });
});

describe("durable loop restart (M6)", () => {
  it("a durable running loop restores with its last-known status and next-run", () => {
    // First host: create + confirm a durable cadence loop.
    const persistence = createLoopPersistence(file);
    const store1 = new LoopStore({
      emit: () => {},
      makeId: () => "loop_1",
      runner: idleRunner,
      scheduler: new LoopScheduler(fixedClock),
      persist: (record) => persistence.save(record),
    });
    store1.submit('/loop durable every 1h max 9 do "sweep"');
    store1.confirm("loop_1");

    // Second host (fresh store) rehydrates from the same file.
    const restored = persistence.load();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.status).toBe("running");
    expect(restored[0]?.nextRun).toBe(1_000 + 3_600_000); // one hour out (fixed clock), retained

    const events: LoopSnapshot[] = [];
    const store2 = new LoopStore({ emit: (s) => events.push(s) });
    store2.hydrate(restored);
    // A `running` loop restores as `paused` - its timer did not survive the restart, so a "running" badge
    // would be a lie; the user resumes it explicitly.
    expect(store2.get("loop_1")?.status).toBe("paused");
    expect(store2.get("loop_1")?.spec.action).toBe("sweep");
    // Hydration is side-effect-free: no snapshots re-emitted on restore.
    expect(events).toHaveLength(0);
  });

  it("prunes a soft-deleted durable loop from the file (no unbounded growth)", () => {
    const persistence = createLoopPersistence(file);
    const store = new LoopStore({
      emit: () => {},
      makeId: () => "loop_1",
      runner: idleRunner,
      scheduler: new LoopScheduler(fixedClock),
      persist: (record) => persistence.save(record),
    });
    store.submit('/loop durable every 1h max 9 do "x"');
    store.confirm("loop_1");
    expect(persistence.load()).toHaveLength(1);
    store.delete("loop_1");
    // The deleted durable loop is pruned, not left as a growing tombstone.
    expect(persistence.load()).toEqual([]);
  });

  it("does NOT persist a session (non-durable) loop", () => {
    const persistence = createLoopPersistence(file);
    const store = new LoopStore({
      emit: () => {},
      makeId: () => "loop_1",
      runner: idleRunner,
      persist: (record) => persistence.save(record),
    });
    store.submit('/loop every 1h max 9 do "x"'); // session durability (default)
    store.confirm("loop_1");
    expect(existsSync(file)).toBe(false); // nothing written
    expect(persistence.load()).toEqual([]);
  });
});

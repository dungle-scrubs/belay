import type { LoopSnapshot } from "@belay/session";
import { describe, expect, it } from "vitest";
import { LoopStore, summarizeLoopSpec } from "./store";

/**
 * The runtime loop store + confirmation flow (plan 17, M4 tasks 5-6): a ready `/loop` submission becomes a
 * `pending` loop awaiting confirmation, confirm/edit/cancel drive it before activation, and every
 * transition publishes a structured status snapshot.
 */

/** A store with a recording sink + deterministic ids, plus the snapshots it published. */
function makeStore(): { store: LoopStore; events: LoopSnapshot[] } {
  const events: LoopSnapshot[] = [];
  let n = 0;
  const store = new LoopStore({
    emit: (snapshot) => events.push(snapshot),
    makeId: () => `loop_${++n}`,
  });
  return { store, events };
}

describe("loop store confirmation flow (M4)", () => {
  it("a ready submission becomes pending (a confirmation request), not running", () => {
    const { store, events } = makeStore();
    const result = store.submit('/loop max 5 do "run tests"');
    expect(result.ok).toBe(true);
    expect(result.ok && result.snapshot.status).toBe("pending");
    expect(result.ok && result.snapshot.loopId).toBe("loop_1");
    // A pending snapshot was published (the client renders it as a confirmation prompt).
    expect(events.at(-1)?.status).toBe("pending");
    // It is NOT yet running.
    expect(store.get("loop_1")?.status).toBe("pending");
  });

  it("rejects an unready submission so the client keeps editing (never a phantom loop)", () => {
    const { store, events } = makeStore();
    const result = store.submit('/loop do "no bound"');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("bound");
    expect(store.list()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("confirm activates a pending loop to running", () => {
    const { store, events } = makeStore();
    store.submit('/loop max 5 do "run tests"');
    const confirmed = store.confirm("loop_1");
    expect(confirmed.ok && confirmed.snapshot.status).toBe("running");
    expect(events.at(-1)?.status).toBe("running");
  });

  it("edit replaces a pending loop's definition and keeps it pending", () => {
    const { store } = makeStore();
    store.submit('/loop max 5 do "old"');
    const edited = store.edit("loop_1", '/loop max 9 do "new"');
    expect(edited.ok).toBe(true);
    expect(edited.ok && edited.snapshot.status).toBe("pending");
    expect(edited.ok && edited.snapshot.summary).toContain("new");
    expect(edited.ok && edited.snapshot.summary).toContain("max 9");
  });

  it("cannot edit a loop once it is running", () => {
    const { store } = makeStore();
    store.submit('/loop max 5 do "x"');
    store.confirm("loop_1");
    const edited = store.edit("loop_1", '/loop max 9 do "y"');
    expect(edited.ok).toBe(false);
    expect(edited.ok === false && edited.error).toContain("running");
  });

  it("cancel soft-deletes a pending loop and drops it from the list", () => {
    const { store, events } = makeStore();
    store.submit('/loop max 5 do "x"');
    const cancelled = store.cancel("loop_1");
    expect(cancelled.ok && cancelled.snapshot.status).toBe("deleted");
    expect(events.at(-1)?.status).toBe("deleted");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects controls on an unknown loop id", () => {
    const { store } = makeStore();
    expect(store.confirm("nope").ok).toBe(false);
    expect(store.cancel("nope").ok).toBe(false);
  });
});

describe("loop snapshot projection (M4)", () => {
  it("carries the runner, durability, progress, and a human summary", () => {
    const { store } = makeStore();
    const result = store.submit('/loop background durable every 5m timeout 1h do "sweep"');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.runner).toBe("background_agent");
    expect(result.snapshot.durability).toBe("durable");
    expect(result.snapshot.completed).toBe(0);
    expect(result.snapshot.summary).toBe('every 5m · timeout 1h · do "sweep"');
  });

  it("summarizeLoopSpec renders max/every/until/timeout in a stable order", () => {
    expect(
      summarizeLoopSpec({
        runner: "process",
        durability: "session",
        action: "curl x",
        max: 3,
        everyMs: 30_000,
      }),
    ).toBe('max 3 · every 30s · do "curl x"');
  });
});

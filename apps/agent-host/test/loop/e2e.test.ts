import { describe, expect, it } from "vitest";
import { buildCommandRegistry, type CommandContext } from "../../src/commands";
import type { LoopIterationRunner } from "../../src/loop/runner";
import { LoopStore } from "../../src/loop/store";

/**
 * Headless loop lifecycle e2e (plan 17, M8): the command/session protocol - explicit `/loop` command text -
 * drives create, list, pause, resume, run-now, stop, and delete with NO web-only path. Loops are scheduled
 * an hour out so the lifecycle is driven purely by commands (iteration execution is covered by the runtime
 * + runner tests); the store publishes a `loop.status` snapshot on every transition.
 */

const idleRunner: LoopIterationRunner = {
  run: () => Promise.resolve({ ok: true, summary: "ran" }),
};

/** A registry + a store wired as its loop runtime, plus the snapshots the store published. */
function harness() {
  const events: { loopId: string; status: string }[] = [];
  let n = 0;
  const store = new LoopStore({
    emit: (snapshot) => events.push({ loopId: snapshot.loopId, status: snapshot.status }),
    makeId: () => {
      n += 1;
      return `loop_${n}`;
    },
    runner: idleRunner,
  });
  const registry = buildCommandRegistry();
  // The loop commands read only `ctx.loops`; the rest of the context is unused here.
  const ctx = { loops: store } as unknown as CommandContext;
  const run = (input: string) => {
    const [name, ...rest] = input.split(" ");
    return registry.run(name ?? "/loop", rest.join(" "), ctx);
  };
  return { run, events, store };
}

describe("headless /loop lifecycle over the command surface (M8)", () => {
  it("creates + activates a loop from explicit command text", async () => {
    const { run, events } = harness();
    const result = await run('/loop every 1h max 3 do "run the suite"');
    expect(result.ok).toBe(true);
    expect(result.text).toContain("loop_1 running");
    expect(result.text).toContain("run the suite");
    // A pending confirmation then a running snapshot were published.
    expect(events.map((event) => event.status)).toContain("running");
  });

  it("lists active loops, then pauses, resumes, stops, and deletes one - all via commands", async () => {
    const { run } = harness();
    await run('/loop every 1h max 9 do "sweep"');

    expect((await run("/loop list")).text).toContain("loop_1 running");
    expect((await run("/loop pause loop_1")).text).toContain("loop_1 paused");
    expect((await run("/loop resume loop_1")).text).toContain("loop_1 running");
    expect((await run("/loop stop loop_1")).text).toContain("loop_1 stopped");

    const deleted = await run("/loop delete loop_1");
    expect(deleted.text).toContain("loop_1 deleted");
    // After delete, the inventory is empty.
    expect((await run("/loop list")).text).toContain("No active loops");
  });

  it("/loops list works the same as /loop list", async () => {
    const { run } = harness();
    await run('/loop every 1h max 9 do "x"');
    expect((await run("/loops list")).text).toContain("loop_1 running");
  });

  it("reports a structured error for an unready creation and a bad control target", async () => {
    const { run } = harness();
    expect((await run('/loop do "no bound"')).text).toContain("error");
    expect((await run("/loop pause nope")).text).toContain("error");
    expect((await run("/loop pause")).text).toContain("usage: /loop pause <id>");
  });
});

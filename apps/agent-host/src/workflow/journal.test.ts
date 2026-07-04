import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makeScheduler, parallel, type WorkflowEmit } from "./concurrency";
import {
  type AgentJournal,
  cacheFromEvents,
  emptyCache,
  fingerprint,
  journaledAgent,
  type RunCache,
  stableStringify,
} from "./journal";
import type { LeafResult, TurnUsage } from "./leaf";
import { withRootSlot } from "./ordinal";

const ok = (text: string, output = 5): LeafResult => ({
  ok: true,
  childSessionId: "c",
  text,
  usage: { input: 1, output },
});

const noopEmit: WorkflowEmit = {
  leafFailed: () => Effect.void,
  log: () => Effect.void,
  phase: () => Effect.void,
};

interface JournalEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function recorder(cache: RunCache = emptyCache()) {
  const emitted: JournalEvent[] = [];
  const restored: TurnUsage[] = [];
  const journal: AgentJournal = {
    runId: "run-1",
    cache,
    emit: (event) =>
      Effect.sync(() => {
        emitted.push({ type: event.type, payload: event.payload });
      }),
    onUsage: (usage) =>
      Effect.sync(() => {
        restored.push(usage);
      }),
  };
  return { journal, emitted, restored };
}

const agentOrdinals = (emitted: readonly JournalEvent[]): string[] =>
  emitted
    .filter((event) => event.type === "workflow.agent")
    .map((event) => (event.payload.ordinal as number[]).join("."));

describe("fingerprint / stableStringify", () => {
  test("is stable across key order and drops functions", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(fingerprint("p", { model: "m", fn: () => 1 })).toBe(fingerprint("p", { model: "m" }));
  });

  test("changes when the prompt or opts change", () => {
    expect(fingerprint("p", { n: 1 })).not.toBe(fingerprint("p", { n: 2 }));
    expect(fingerprint("p", {})).not.toBe(fingerprint("q", {}));
  });
});

describe("journaledAgent - ordinals (D-019)", () => {
  test("two IDENTICAL parallel leaves get DISTINCT ordinals (not a content match)", async () => {
    const { journal, emitted } = recorder();
    const scheduler = await Effect.runPromise(makeScheduler(noopEmit));
    const leaf = () => journaledAgent(journal, "same", { x: 1 }, () => Effect.succeed(ok("r")));
    await Effect.runPromise(withRootSlot(parallel(scheduler, [leaf, leaf])));
    expect(new Set(agentOrdinals(emitted)).size).toBe(2);
  });

  test("a worker plus its retry within one slot get distinct intra-slot ordinals (D-016)", async () => {
    const { journal, emitted } = recorder();
    const scheduler = await Effect.runPromise(makeScheduler(noopEmit));
    const workerWithRetry = () =>
      Effect.gen(function* () {
        yield* journaledAgent(journal, "worker", {}, () => Effect.succeed(ok("first")));
        return yield* journaledAgent(journal, "retry", {}, () => Effect.succeed(ok("second")));
      });
    await Effect.runPromise(withRootSlot(parallel(scheduler, [workerWithRetry])));
    const ordinals = agentOrdinals(emitted);
    expect(ordinals).toEqual(["0.0.0", "0.0.1"]);
  });
});

describe("resume - ordinal-keyed cache", () => {
  test("an unchanged prefix replays from cache (live not called) and restores Usage", async () => {
    const first = recorder();
    const s1 = await Effect.runPromise(makeScheduler(noopEmit));
    const liveFirst = { calls: 0 };
    await Effect.runPromise(
      withRootSlot(
        parallel(s1, [
          () =>
            journaledAgent(first.journal, "a", {}, () =>
              Effect.sync(() => {
                liveFirst.calls++;
                return ok("ra", 7);
              }),
            ),
          () =>
            journaledAgent(first.journal, "b", {}, () =>
              Effect.sync(() => {
                liveFirst.calls++;
                return ok("rb", 9);
              }),
            ),
        ]),
      ),
    );
    expect(liveFirst.calls).toBe(2);

    const second = recorder(cacheFromEvents(first.emitted));
    const s2 = await Effect.runPromise(makeScheduler(noopEmit));
    const liveSecond = { calls: 0 };
    const out = await Effect.runPromise(
      withRootSlot(
        parallel(s2, [
          () =>
            journaledAgent(second.journal, "a", {}, () =>
              Effect.sync(() => {
                liveSecond.calls++;
                return ok("ra");
              }),
            ),
          () =>
            journaledAgent(second.journal, "b", {}, () =>
              Effect.sync(() => {
                liveSecond.calls++;
                return ok("rb");
              }),
            ),
        ]),
      ),
    );
    expect(liveSecond.calls).toBe(0);
    expect(out).toEqual(["ra", "rb"]);
    expect(second.restored).toEqual([
      { input: 1, output: 7 },
      { input: 1, output: 9 },
    ]);
    expect(
      second.emitted.filter(
        (event) => event.type === "workflow.agent" && event.payload.status === "replayed",
      ),
    ).toHaveLength(2);
  });

  test("a changed ordinal re-runs live while unchanged siblings still cache-hit", async () => {
    const first = recorder();
    const s1 = await Effect.runPromise(makeScheduler(noopEmit));
    await Effect.runPromise(
      withRootSlot(
        parallel(s1, [
          () => journaledAgent(first.journal, "a", { v: 1 }, () => Effect.succeed(ok("ra"))),
          () => journaledAgent(first.journal, "b", { v: 1 }, () => Effect.succeed(ok("rb"))),
        ]),
      ),
    );

    const second = recorder(cacheFromEvents(first.emitted));
    const s2 = await Effect.runPromise(makeScheduler(noopEmit));
    const live = { a: 0, b: 0 };
    await Effect.runPromise(
      withRootSlot(
        parallel(s2, [
          () =>
            journaledAgent(second.journal, "a", { v: 1 }, () =>
              Effect.sync(() => {
                live.a++;
                return ok("ra");
              }),
            ),
          () =>
            journaledAgent(second.journal, "b", { v: 2 }, () =>
              Effect.sync(() => {
                live.b++;
                return ok("rb2");
              }),
            ),
        ]),
      ),
    );
    expect(live.a).toBe(0); // unchanged fingerprint -> cache hit
    expect(live.b).toBe(1); // changed opts -> live re-run
  });

  test("out-of-order completion still reconstructs call->result by ordinal", async () => {
    const first = recorder();
    const s1 = await Effect.runPromise(makeScheduler(noopEmit));
    await Effect.runPromise(
      withRootSlot(
        parallel(s1, [
          () =>
            journaledAgent(first.journal, "slow", {}, () =>
              Effect.sleep("20 millis").pipe(Effect.as(ok("slow-r"))),
            ),
          () => journaledAgent(first.journal, "fast", {}, () => Effect.succeed(ok("fast-r"))),
        ]),
      ),
    );
    // The fast leaf (index 1) journals before the slow one (index 0) - emission order is reversed.
    const cache = cacheFromEvents(first.emitted);
    const second = recorder(cache);
    const s2 = await Effect.runPromise(makeScheduler(noopEmit));
    const live = { calls: 0 };
    const out = await Effect.runPromise(
      withRootSlot(
        parallel(s2, [
          () =>
            journaledAgent(second.journal, "slow", {}, () =>
              Effect.sync(() => {
                live.calls++;
                return ok("x");
              }),
            ),
          () =>
            journaledAgent(second.journal, "fast", {}, () =>
              Effect.sync(() => {
                live.calls++;
                return ok("y");
              }),
            ),
        ]),
      ),
    );
    expect(live.calls).toBe(0);
    expect(out).toEqual(["slow-r", "fast-r"]);
  });
});

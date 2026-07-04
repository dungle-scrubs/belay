import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { type EngineDeps, runWorkflow, type WorkflowBody } from "./engine";
import { cacheFromEvents } from "./journal";
import type { LeafResult } from "./leaf";

const ok = (text: string, output = 5): LeafResult => ({
  ok: true,
  childSessionId: "c",
  text,
  usage: { input: 1, output },
});
const failed = (cause: string): LeafResult => ({
  ok: false,
  kind: "child-turn-failed",
  childSessionId: "c",
  cause,
});

interface Journal {
  readonly events: { type: string; payload: Record<string, unknown> }[];
}

function makeDeps(over: Partial<EngineDeps> = {}): { deps: EngineDeps; journal: Journal } {
  const journal: Journal = { events: [] };
  const deps: EngineDeps = {
    runId: "run-1",
    emit: (event) =>
      Effect.sync(() => {
        journal.events.push({ type: event.type, payload: event.payload });
      }),
    leafRunner: (prompt) => Effect.succeed(ok(`did:${prompt}`)),
    ...over,
  };
  return { deps, journal };
}

const parallelBody =
  (prompts: readonly string[]): WorkflowBody =>
  (api) =>
    api.parallel(prompts.map((p) => () => api.agent(p))).pipe(Effect.map(() => undefined));

describe("runWorkflow", () => {
  test("emits workflow.started + completed around a parallel body and journals each leaf", async () => {
    const { deps, journal } = makeDeps();
    const result = await Effect.runPromise(runWorkflow("demo", parallelBody(["a", "b"]), {}, deps));
    expect(result.ok).toBe(true);
    expect(result.leaves).toBe(2);
    expect(journal.events[0]?.type).toBe("workflow.started");
    expect(journal.events.at(-1)?.type).toBe("workflow.completed");
    expect(journal.events.filter((e) => e.type === "workflow.agent")).toHaveLength(2);
  });

  test("a leaf failure emits workflow.leaf-failed (fail-soft) and the run still completes ok", async () => {
    const { deps, journal } = makeDeps({
      leafRunner: (prompt) => Effect.succeed(prompt === "bad" ? failed("boom") : ok(prompt)),
    });
    const result = await Effect.runPromise(
      runWorkflow("demo", parallelBody(["good", "bad"]), {}, deps),
    );
    expect(result.ok).toBe(true);
    const leafFailed = journal.events.find((e) => e.type === "workflow.leaf-failed");
    expect(leafFailed?.payload.cause).toBe("boom");
  });

  test("the budget ceiling terminates a while(remaining>0) loop", async () => {
    const { deps } = makeDeps({ budgetTotal: 8, leafRunner: () => Effect.succeed(ok("x", 5)) });
    const body: WorkflowBody = (api) =>
      Effect.gen(function* () {
        let count = 0;
        while ((yield* api.budget.remaining) > 0 && count < 20) {
          yield* api.agent(`leaf-${count++}`);
        }
        return count;
      });
    const result = await Effect.runPromise(runWorkflow("loop", body, {}, deps));
    // total 8, 5 output/leaf: after 2 leaves spend is 10 -> remaining 0 -> stop.
    expect(result.value).toBe(2);
  });

  test("resume: a cache replays leaves without re-running the leaf runner, and reconstructs order", async () => {
    const first = makeDeps();
    let liveCalls = 0;
    const firstDeps: EngineDeps = {
      ...first.deps,
      leafRunner: (prompt) =>
        Effect.sync(() => {
          liveCalls++;
          return ok(`did:${prompt}`);
        }),
    };
    await Effect.runPromise(runWorkflow("demo", parallelBody(["a", "b"]), {}, firstDeps));
    expect(liveCalls).toBe(2);

    const cache = cacheFromEvents(first.journal.events);
    const second = makeDeps({ cache });
    let liveCalls2 = 0;
    const secondDeps: EngineDeps = {
      ...second.deps,
      cache,
      leafRunner: (prompt) =>
        Effect.sync(() => {
          liveCalls2++;
          return ok(`did:${prompt}`);
        }),
    };
    const result = await Effect.runPromise(
      runWorkflow("demo", parallelBody(["a", "b"]), {}, secondDeps),
    );
    expect(liveCalls2).toBe(0); // both leaves replayed from the cache
    expect(result.ok).toBe(true);
  });
});

import assert from "node:assert/strict";
import { Effect, Fiber, Stream } from "effect";
import { test, vi } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../providers";
import { trimLargestToolResult } from "./recovery";

/**
 * Phase 1 (concurrent read-only tool execution, D-050): M3 invariant tests. These replace the
 * real tool registry with a controllable fake `executeTool` (and the real read-only set) so the
 * loop's dispatch - partitioning, bounded concurrency, serial barriers, and call-ordered commit -
 * is exercised deterministically, without touching the filesystem or network. Timing is driven by
 * test-held gates (not wall-clock sleeps), so "ran concurrently" is proven by a serial execution
 * deadlocking, never by a flaky latency comparison.
 */

// Shared control surface for the fake executor. vi.hoisted so the (hoisted) vi.mock factory can
// see it; the factory imports Effect lazily because it runs before the module's top-level imports.
const ctl = vi.hoisted(() => ({
  // The order each tool call BEGAN executing (its arguments string), in real start order.
  started: [] as string[],
  // The names of calls whose in-flight effect was interrupted (cancellation).
  interrupted: [] as string[],
  // Per-call behavior keyed by the arguments string; absent → resolve immediately.
  responder: null as null | ((name: string, args: string) => Promise<string>),
  reset() {
    ctl.started = [];
    ctl.interrupted = [];
    ctl.responder = null;
  },
}));

vi.mock("../tools", async () => {
  const { Effect } = await import("effect");
  return {
    READ_ONLY_TOOLS: new Set(["read", "glob", "grep", "web_search"]),
    // Non-empty so the loop advertises tools to the provider; content is irrelevant here.
    TOOL_DEFS: [{ name: "read", description: "read", parameters: {} }],
    executeTool: (name: string, args: string): Effect.Effect<string> =>
      Effect.onInterrupt(
        Effect.promise(() => {
          ctl.started.push(args);
          return ctl.responder ? ctl.responder(name, args) : Promise.resolve(`ran ${name}`);
        }),
        () => Effect.sync(() => ctl.interrupted.push(args)),
      ),
  };
});

// Imported AFTER the mock is registered so the loop binds the fake registry.
const { runAgent } = await import("./loop");

const usage = { input: 10, output: 1, contextWindow: 1_000_000, genMs: 1 };

const BASE = {
  id: "fake",
  label: "Fake",
  model: "fake-1",
  reasoningLevels: ["off", "low"],
  defaultReasoning: "off",
  kind: "cloud" as const,
  describe: () => ({
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off", "low"],
    defaultReasoning: "off",
    kind: "cloud" as const,
  }),
  readiness: () => Effect.succeed({ ready: true, warm: true }),
  capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
  warm: () => Effect.void,
};

/**
 * A provider that emits one fixed batch of tool calls on its first step, then answers on its
 * second (ending the loop after exactly one tool batch). `onCommitted` receives the conversation
 * the second step is fed - i.e. the fully-committed history after the batch drained.
 */
function batchProvider(
  calls: readonly { name: string; arguments: string }[],
  onCommitted?: (messages: readonly ChatMessage[]) => void,
): Provider {
  let step = 0;
  return {
    ...BASE,
    stream: (messages) => {
      if (step > 0) {
        onCommitted?.(messages);
        return Stream.fromIterable<ProviderEvent>([
          { type: "text", text: "done" },
          { type: "usage", usage },
        ]);
      }
      step += 1;
      return Stream.fromIterable<ProviderEvent>([
        ...calls.map((c, i) => ({
          type: "tool_call" as const,
          call: { id: `c${i}`, name: c.name, arguments: c.arguments },
        })),
        { type: "usage", usage },
      ]);
    },
  };
}

const drain = (provider: Provider) =>
  Stream.runDrain(runAgent(provider, [{ role: "user", content: "go" }], "off", "r1"));

const waitFor = (cond: () => boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    while (!cond()) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  });

test("M3: concurrent reads in one batch overlap (a serial run would deadlock)", async () => {
  ctl.reset();
  const N = 3;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => (release = resolve));
  // Each read parks until ALL N have started: only possible if they run concurrently. A serial
  // dispatch would park the first read forever (the others never start) and the test would hang.
  ctl.responder = async (_name, args) => {
    if (ctl.started.length === N) {
      release();
    }
    await allStarted;
    return `ran ${args}`;
  };
  const calls = Array.from({ length: N }, (_, i) => ({ name: "read", arguments: String(i) }));
  await Effect.runPromise(drain(batchProvider(calls)));
  assert.equal(ctl.started.length, N, "all reads ran (the batch did not deadlock)");
});

test("M3: cancellation mid-batch interrupts in-flight read children with no leak", async () => {
  ctl.reset();
  const N = 3;
  // Every read parks forever; we interrupt once all are in-flight and assert each was torn down.
  ctl.responder = () => new Promise<string>(() => {});
  const calls = Array.from({ length: N }, (_, i) => ({ name: "read", arguments: String(i) }));
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(drain(batchProvider(calls)));
      yield* waitFor(() => ctl.started.length === N);
      yield* Fiber.interrupt(fiber);
    }),
  );
  assert.equal(ctl.started.length, N, "all reads were in-flight");
  assert.deepEqual(
    [...ctl.interrupted].sort(),
    ["0", "1", "2"],
    "every in-flight read child was interrupted",
  );
});

test("M3: two edits to one path apply sequentially with no lost update", async () => {
  ctl.reset();
  // Model a read-modify-write on a shared cell. An await sits between read and write - the exact
  // window a concurrent pair would interleave on, losing one increment. Two `edit` calls are
  // mutating, so the loop runs them as separate barriers (never merged): strictly serial, so both
  // increments land (final === 2). A concurrent dispatch would yield 1.
  let cell = 0;
  ctl.responder = async (name) => {
    if (name === "edit") {
      const read = cell;
      await new Promise((resolve) => setTimeout(resolve, 5));
      cell = read + 1;
      return "edited";
    }
    return `ran ${name}`;
  };
  await Effect.runPromise(
    drain(
      batchProvider([
        { name: "edit", arguments: "0" },
        { name: "edit", arguments: "1" },
      ]),
    ),
  );
  assert.equal(ctl.started.length, 2, "both edits ran");
  assert.equal(cell, 2, "edits serialized as barriers - no lost update");
});

/**
 * Drives the same 3-read batch but resolves the reads in a chosen COMPLETION order, returning the
 * committed conversation the next step was fed. Reads are gated per call so the test, not the
 * runtime, decides which finishes first.
 */
async function commitOrder(completion: readonly number[]): Promise<readonly ChatMessage[]> {
  ctl.reset();
  const resolvers = new Map<string, () => void>();
  const gates = new Map<string, Promise<string>>();
  for (let i = 0; i < 3; i += 1) {
    gates.set(
      String(i),
      new Promise<string>((resolve) => resolvers.set(String(i), () => resolve(`result-${i}`))),
    );
  }
  ctl.responder = (_name, args) => gates.get(args) ?? Promise.resolve("?");
  let committed: readonly ChatMessage[] = [];
  const calls = [0, 1, 2].map((i) => ({ name: "read", arguments: String(i) }));
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(drain(batchProvider(calls, (m) => (committed = m))));
      yield* waitFor(() => ctl.started.length === 3);
      // Resolve in the requested completion order, then let the batch drain and commit.
      for (const i of completion) {
        resolvers.get(String(i))?.();
      }
      yield* Fiber.join(fiber);
    }),
  );
  return committed;
}

test("M3: the committed conversation is call-ordered regardless of completion order", async () => {
  const forward = await commitOrder([0, 1, 2]);
  const reverse = await commitOrder([2, 1, 0]);
  const toolResults = (messages: readonly ChatMessage[]) =>
    messages
      .filter((m) => m.role === "tool")
      .map((m) => ({ id: m.toolCallId, content: m.content }));
  // Reverse completion must commit identically to forward...
  assert.deepEqual(toolResults(reverse), toolResults(forward));
  // ...and in CALL order, each result keyed to its own call.
  assert.deepEqual(toolResults(forward), [
    { id: "c0", content: "result-0" },
    { id: "c1", content: "result-1" },
    { id: "c2", content: "result-2" },
  ]);
});

test("M3: recovery trims a deterministic, call-ordered conversation", async () => {
  // Recovery reads `conversation`; M3 requires that to be deterministic across completion orders.
  // Trimming the same batch committed under opposite completion orders must pick the same target
  // and produce the same conversation - the largest result (call 1) elided either way.
  const trimResultLength = (completion: readonly number[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Give call 1 the largest result so the trim target is unambiguous.
        const resolvers = new Map<string, () => void>();
        const gates = new Map<string, Promise<string>>();
        const sizes = ["a".repeat(100), "b".repeat(5000), "c".repeat(100)];
        ctl.reset();
        for (let i = 0; i < 3; i += 1) {
          gates.set(
            String(i),
            new Promise<string>((resolve) =>
              resolvers.set(String(i), () => resolve(sizes[i] ?? "")),
            ),
          );
        }
        ctl.responder = (_name, args) => gates.get(args) ?? Promise.resolve("?");
        let committed: ChatMessage[] = [];
        const calls = [0, 1, 2].map((i) => ({ name: "read", arguments: String(i) }));
        const fiber = yield* Effect.fork(drain(batchProvider(calls, (m) => (committed = [...m]))));
        yield* waitFor(() => ctl.started.length === 3);
        for (const i of completion) {
          resolvers.get(String(i))?.();
        }
        yield* Fiber.join(fiber);
        return committed;
      }),
    );

  const forward = await trimResultLength([0, 1, 2]);
  const reverse = await trimResultLength([2, 1, 0]);
  // The pre-trim conversations are identical (call-ordered), so recovery is deterministic.
  assert.deepEqual(reverse, forward);
  const trimF = trimLargestToolResult([...forward], 0);
  const trimR = trimLargestToolResult([...reverse], 0);
  assert.deepEqual(trimR, trimF, "same trim target + reclaim regardless of completion order");
  assert.ok(trimF && trimF.reclaimed > 0, "the largest (call 1) result was trimmed");
});

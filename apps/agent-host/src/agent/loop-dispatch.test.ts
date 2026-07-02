import assert from "node:assert/strict";
import type { PreToolUseOutcome } from "@host/hooks/runtime";
import { Effect, Fiber, Stream } from "effect";
import { test, vi } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../providers";
import { trimLargestToolResult } from "./overflow-recovery";

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
  // The read-only partition is the cross-surface vocabulary (D-031), not a re-spelled literal,
  // so the mock can't drift from the real classification the loop dispatches against.
  const { READ_ONLY_TOOL_NAMES } = await import("@trevor/session");
  // Non-empty so the loop advertises tools to the provider; content is irrelevant here.
  const TOOL_DEFS = [{ name: "read", description: "read", parameters: {} }];
  return {
    READ_ONLY_TOOLS: READ_ONLY_TOOL_NAMES,
    TOOL_DEFS,
    offeredToolDefs: (
      useTools: boolean,
      toolNames: ReadonlySet<string> | undefined,
      delegateDefs: readonly { name: string }[] | undefined,
    ) => {
      const registry = useTools ? TOOL_DEFS : [];
      const allowed = toolNames ? registry.filter((t) => toolNames.has(t.name)) : registry;
      return delegateDefs ? [...allowed, ...delegateDefs] : allowed;
    },
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

type AgentEvent = import("./loop").AgentEvent;
type TurnHooks = import("./loop").TurnHooks;

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

// --- plan 25 simplify pass: hook gating at the batch boundary ---------------------------------

const ALLOW_OUTCOME: PreToolUseOutcome = { decision: "allow", contexts: [], diagnostics: [] };

test("25 C3: a mid-batch PreToolUse halt drains in-flight reads and skips later members", async () => {
  ctl.reset();
  // Three reads, concurrency 2: c0's gate allows and its execute PARKS (in flight); c1's gate is
  // held open until c0 is executing, then resolves halt; c2 (queued behind the concurrency cap)
  // must be skipped without ever reaching hook dispatch. c0 is released only AFTER c2's skip is
  // observable, proving an in-flight read past its gate drains and publishes before the stop.
  let releaseC0!: () => void;
  const c0Gate = new Promise<string>((resolve) => {
    releaseC0 = () => resolve("ran read 0");
  });
  ctl.responder = (_name, args) => (args === "0" ? c0Gate : Promise.resolve(`ran read ${args}`));

  const dispatched: string[] = [];
  let resolveHalt!: (outcome: PreToolUseOutcome) => void;
  const hooks: TurnHooks = {
    dispatchPreToolUse: (payload) => {
      const arg = String(payload.toolInput);
      dispatched.push(arg);
      if (arg === "1") {
        return new Promise((resolve) => {
          resolveHalt = resolve;
        });
      }
      return Promise.resolve(ALLOW_OUTCOME);
    },
    identity: { sessionId: "s", callerKind: "main", cwd: "/w" },
  };

  const events: AgentEvent[] = [];
  const calls = [0, 1, 2].map((i) => ({ name: "read", arguments: String(i) }));
  let committed = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Stream.runForEach(
          runAgent(
            batchProvider(calls, () => {
              committed = true;
            }),
            [{ role: "user", content: "go" }],
            "off",
            "r1",
            true,
            { hooks, loop: { toolConcurrency: 2 } },
          ),
          (event) => Effect.sync(() => void events.push(event)),
        ),
      );
      // c0 is executing and c1's gate has dispatched (and is pending).
      yield* waitFor(() => ctl.started.includes("0") && dispatched.includes("1"));
      resolveHalt({
        decision: "halt",
        hook: "project:/w:gate",
        reason: "stop the line",
        contexts: [],
        diagnostics: [],
      });
      // c2's skip publishes while c0 is STILL in flight - the halt never waits on c0.
      yield* waitFor(() =>
        events.some((event) => event.type === "tool_end" && event.call.id === "c2"),
      );
      releaseC0();
      yield* Fiber.join(fiber);
    }),
  );

  // Later batch members are skipped BEFORE dispatch: c2's gate never ran.
  assert.deepEqual(dispatched, ["0", "1"]);
  // Only the allowed in-flight read actually executed.
  assert.deepEqual(ctl.started, ["0"]);

  const end = (id: string) =>
    events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> =>
        event.type === "tool_end" && event.call.id === id,
    );
  assert.equal(end("c0")?.result, "ran read 0");
  assert.equal(end("c0")?.skipped, undefined, "the drained read is a real execution");
  assert.equal(end("c1")?.skipped, true);
  assert.match(end("c1")?.result ?? "", /halted by PreToolUse hook/);
  assert.equal(end("c2")?.skipped, true);
  assert.match(end("c2")?.result ?? "", /not executed - the turn was halted/);

  // The in-flight read's result publishes BEFORE the terminal stop, and the turn never opens a
  // second model step past the halt.
  const stopIndex = events.findIndex((event) => event.type === "stop");
  const c0Index = events.findIndex((event) => event.type === "tool_end" && event.call.id === "c0");
  assert.ok(stopIndex > c0Index, "the drained result precedes the stop");
  const stop = events[stopIndex];
  assert.equal(stop?.type === "stop" ? stop.stop.cause : "?", "hook_halt");
  assert.equal(committed, false, "no next model step ran after the halt");
});

test("25 E1: hasHooks=false skips PreToolUse dispatch (and payload construction) entirely", async () => {
  ctl.reset();
  const dispatched: string[] = [];
  const hooks: TurnHooks = {
    dispatchPreToolUse: (payload) => {
      dispatched.push(payload.toolName);
      return Promise.resolve(ALLOW_OUTCOME);
    },
    hasHooks: () => false,
    identity: { sessionId: "s", callerKind: "main", cwd: "/w" },
  };
  await Effect.runPromise(
    Stream.runDrain(
      runAgent(
        batchProvider([{ name: "read", arguments: "0" }]),
        [{ role: "user", content: "go" }],
        "off",
        "r1",
        true,
        { hooks },
      ),
    ),
  );
  assert.deepEqual(dispatched, [], "no dispatch on an unhooked host");
  assert.deepEqual(ctl.started, ["0"], "the tool still executed normally");
});

test("25 E1: an absent hasHooks keeps dispatching (conservative default for hand-built hooks)", async () => {
  ctl.reset();
  const dispatched: string[] = [];
  const hooks: TurnHooks = {
    dispatchPreToolUse: (payload) => {
      dispatched.push(payload.toolName);
      return Promise.resolve(ALLOW_OUTCOME);
    },
    identity: { sessionId: "s", callerKind: "main", cwd: "/w" },
  };
  await Effect.runPromise(
    Stream.runDrain(
      runAgent(
        batchProvider([{ name: "read", arguments: "0" }]),
        [{ role: "user", content: "go" }],
        "off",
        "r1",
        true,
        { hooks },
      ),
    ),
  );
  assert.deepEqual(dispatched, ["read"]);
  assert.deepEqual(ctl.started, ["0"]);
});

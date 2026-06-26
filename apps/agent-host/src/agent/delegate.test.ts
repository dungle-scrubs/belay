import assert from "node:assert/strict";
import type { PublishInput, SessionTransport } from "@trevor/session";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { AgentDefinition } from "../agents";
import type { Provider, ProviderEvent } from "../providers";
import { ProviderUnavailable } from "../providers/errors";
import {
  buildDelegateCapability,
  buildDelegationDefs,
  type DelegationContext,
  runDelegatedChild,
} from "./delegate";
import { type AgentEvent, type DelegateCapability, runAgent } from "./loop";

const USAGE = { input: 10, output: 5, contextWindow: 1000, genMs: 1 } as const;

/**
 * Subagent delegation mechanism (M2 / D-046): a delegation runs the child in its OWN isolated
 * session, seeded with ONLY the parent task, linked to the parent by a `delegated.to` event, and
 * folds the child's final message back as the result. Driven with a fake transport that records
 * publishes per session and a fake provider that answers - no store, no model.
 */

/** A fake transport recording ensured sessions and the events published to each. */
function fakeTransport() {
  const ensured: string[] = [];
  const published = new Map<string, PublishInput[]>();
  const transport: SessionTransport = {
    ensureSession: async (id) => {
      ensured.push(id);
      return id;
    },
    publishEvent: async (id, input) => {
      const list = published.get(id) ?? [];
      list.push(input);
      published.set(id, list);
    },
    connectSession: () => ({ close: () => {} }),
  };
  return { ensured, published, transport };
}

/** A provider that answers in one step with a fixed final message (no tool calls). */
function answeringProvider(text: string): Provider {
  const descriptor = {
    label: "Fake",
    model: "fake-1",
    reasoningLevels: [] as const,
    defaultReasoning: "off",
    kind: "cloud" as const,
  };
  return {
    id: "qwen",
    ...descriptor,
    describe: () => descriptor,
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: () =>
      Stream.fromIterable<ProviderEvent>([
        { type: "text", text },
        { type: "usage", usage: { input: 10, output: 5, contextWindow: 1000, genMs: 1 } },
      ]),
  };
}

const EXPLORER: AgentDefinition = {
  id: "explorer",
  description: "read-only explorer",
  tools: ["*"],
  readOnly: true,
  body: "You are a read-only explorer.",
  source: "built-in",
};

const GENERAL: AgentDefinition = {
  id: "general-purpose",
  description: "full tool set",
  tools: ["*"],
  body: "You are general-purpose.",
  source: "built-in",
};

function context(transport: SessionTransport): DelegationContext {
  let n = 0;
  return {
    transport,
    parentSessionId: "parent-session",
    producerId: "trevor-host",
    mintChildSessionId: () => `child-${n++}`,
  };
}

test("a delegation creates an isolated child session seeded with only the task", async () => {
  const t = fakeTransport();
  const out = await runDelegatedChild(context(t.transport), {
    agent: EXPLORER,
    task: "find the auth code",
    provider: answeringProvider("auth lives in src/auth.ts"),
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });

  assert.equal(out.childSessionId, "child-0");
  assert.equal(out.failed, false);
  assert.equal(out.result, "auth lives in src/auth.ts", "the child's final message folds back");
  assert.ok(t.ensured.includes("child-0"), "the child session was ensured");

  const childLog = t.published.get("child-0") ?? [];
  const first = childLog[0];
  assert.equal(first?.type, "user.message", "the child's first event is the seeded task");
  assert.equal((first?.payload as { text?: string }).text, "find the auth code");
  // The child ran its own turn in its own session.
  assert.ok(
    childLog.some((e) => e.type === "assistant.completed"),
    "the child's turn lifecycle is in the child session",
  );
});

test("the child log shares NO parent transcript events (isolation)", async () => {
  const t = fakeTransport();
  await runDelegatedChild(context(t.transport), {
    agent: EXPLORER,
    task: "investigate",
    provider: answeringProvider("done"),
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });

  const childLog = t.published.get("child-0") ?? [];
  // Nothing on the child carries the parent run id, and no delegation link rides the child log.
  assert.ok(
    !childLog.some((e) => (e.payload as { runId?: string }).runId === "run-parent"),
    "no parent-run-correlated event leaks into the child",
  );
  assert.ok(!childLog.some((e) => e.type === "delegated.to"), "the link lives only on the parent");
});

test("the parent session gets a running then a done delegated.to link with the result", async () => {
  const t = fakeTransport();
  await runDelegatedChild(context(t.transport), {
    agent: EXPLORER,
    task: "look",
    provider: answeringProvider("the result"),
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });

  const parentLog = (t.published.get("parent-session") ?? []).filter(
    (e) => e.type === "delegated.to",
  );
  assert.equal(parentLog.length, 2, "a running link then a terminal link");
  const running = parentLog[0]?.payload as Record<string, unknown>;
  const done = parentLog[1]?.payload as Record<string, unknown>;
  assert.equal(running.status, "running");
  assert.equal(running.childSessionId, "child-0");
  assert.equal(running.agent, "explorer");
  assert.equal(done.status, "done");
  assert.equal(done.result, "the result", "the terminal link carries the frozen distilled result");
});

test("a child turn that errors folds back as a failed link, never throwing into the parent", async () => {
  const t = fakeTransport();
  // A provider whose stream fails: publishTurn surfaces it as an error completion, not an exception.
  const failing: Provider = {
    ...answeringProvider(""),
    stream: () => Stream.fail(new ProviderUnavailable({ provider: "qwen", detail: "down" })),
  };
  const out = await runDelegatedChild(context(t.transport), {
    agent: EXPLORER,
    task: "x",
    provider: failing,
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });
  assert.equal(out.failed, true);
  const done = (t.published.get("parent-session") ?? [])
    .filter((e) => e.type === "delegated.to")
    .at(-1)?.payload as Record<string, unknown>;
  assert.equal(done.status, "failed", "the terminal link marks the failure");
});

// --- M3: the delegation tool surface (loop interception, depth-1, validation) ---

const collect = (stream: ReturnType<typeof runAgent>): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  return Effect.runPromise(
    Stream.runForEach(stream, (e) => Effect.sync(() => void events.push(e))),
  ).then(() => events);
};

test("the loop routes a delegate_inline call to the capability and folds the result back", async () => {
  let offeredFirstStep: string[] = [];
  let step = 0;
  const provider: Provider = {
    ...answeringProvider(""),
    stream: (_messages, tools) => {
      step += 1;
      if (step === 1) {
        offeredFirstStep = tools.map((t) => t.name);
        return Stream.fromIterable<ProviderEvent>([
          {
            type: "tool_call",
            call: {
              id: "d1",
              name: "delegate_inline",
              arguments: JSON.stringify({ agent: "explorer", task: "find X" }),
            },
          },
          { type: "usage", usage: USAGE },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([
        { type: "text", text: "the subagent reported the answer" },
        { type: "usage", usage: USAGE },
      ]);
    },
  };
  // A stub capability returns a canned child result, isolating the loop-interception path.
  const delegate: DelegateCapability = {
    defs: buildDelegationDefs([EXPLORER]),
    names: new Set(["delegate_inline"]),
    run: async () => "FOUND X in src/x.ts",
  };
  const events = await collect(
    runAgent(provider, [{ role: "user", content: "go" }], "off", "r1", true, { delegate }),
  );
  assert.ok(offeredFirstStep.includes("delegate_inline"), "delegation is offered to the parent");
  const toolEnd = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_end" }> =>
      e.type === "tool_end" && e.call.name === "delegate_inline",
  );
  assert.ok(toolEnd, "the loop ran the delegation as a tool");
  assert.equal(toolEnd.result, "FOUND X in src/x.ts", "the child's result folds in as the result");
});

test("a child turn is offered NO delegation tool (depth-1)", async () => {
  const t = fakeTransport();
  let childOffered: string[] = [];
  const provider: Provider = {
    ...answeringProvider("done"),
    stream: (_messages, tools) => {
      childOffered = tools.map((tt) => tt.name);
      return Stream.fromIterable<ProviderEvent>([
        { type: "text", text: "done" },
        { type: "usage", usage: USAGE },
      ]);
    },
  };
  await runDelegatedChild(context(t.transport), {
    agent: GENERAL, // even general-purpose (tools: ['*']) never gets the delegation tools
    task: "x",
    provider,
    parentRunId: "rp",
    childRunId: "rc",
    mode: "inline",
  });
  assert.ok(!childOffered.includes("delegate_inline"), "a child cannot see/invoke delegation");
});

test("the capability validates the agent id and a non-empty task with structured errors", async () => {
  const cap = buildDelegateCapability(context(fakeTransport().transport), {
    provider: answeringProvider(""),
    parentRunId: "rp",
    agents: [EXPLORER],
    mintRunId: () => "rc",
  });
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ task: "x" })),
    /requires an "agent"/,
  );
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ agent: "nope", task: "x" })),
    /unknown agent "nope"/,
  );
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ agent: "explorer", task: "  " })),
    /non-empty "task"/,
  );
});

// --- M5: ephemeral model-minted agents (D-049) ---

function capability(transport: SessionTransport, provider: Provider) {
  return buildDelegateCapability(context(transport), {
    provider,
    parentRunId: "rp",
    agents: [EXPLORER],
    mintRunId: () => "rc",
  });
}

test("an inline ephemeral `define` runs a one-off agent and folds its result back", async () => {
  const t = fakeTransport();
  const cap = capability(t.transport, answeringProvider("ephemeral did it"));
  const out = await cap.run(
    "delegate_inline",
    JSON.stringify({
      define: { description: "one-off", instructions: "do the thing", tools: ["read", "grep"] },
      task: "go",
    }),
  );
  assert.equal(out, "ephemeral did it");
  const link = (t.published.get("parent-session") ?? []).find((e) => e.type === "delegated.to")
    ?.payload as Record<string, unknown>;
  assert.equal(link.agent, "ephemeral", "the link records it as an ephemeral agent");
});

test("an ephemeral define is validated strictly against the registry", async () => {
  const cap = capability(fakeTransport().transport, answeringProvider(""));
  assert.match(
    await cap.run(
      "delegate_inline",
      JSON.stringify({
        define: { description: "x", instructions: "y", tools: ["read", "nope"] },
        task: "go",
      }),
    ),
    /unknown tool\(s\).*nope/,
    "an unknown tool is rejected, not silently dropped",
  );
  assert.match(
    await cap.run(
      "delegate_inline",
      JSON.stringify({
        define: { description: "x", instructions: "y", tools: ["delegate_inline"] },
        task: "go",
      }),
    ),
    /may not use delegation tools/,
    "an ephemeral agent cannot re-enable delegation (depth-1)",
  );
  assert.match(
    await cap.run(
      "delegate_inline",
      JSON.stringify({
        define: { description: "x", instructions: "y", skills: ["no-such-skill"] },
        task: "go",
      }),
    ),
    /unknown skill\(s\).*no-such-skill/,
    "an unknown skill is rejected",
  );
});

test("an ephemeral define needs a description and instructions", async () => {
  const cap = capability(fakeTransport().transport, answeringProvider(""));
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ define: { instructions: "y" }, task: "go" })),
    /needs a "description"/,
  );
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ define: { description: "x" }, task: "go" })),
    /needs "instructions"/,
  );
});

test("a call with neither agent nor define is a structured error", async () => {
  const cap = capability(fakeTransport().transport, answeringProvider(""));
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ task: "go" })),
    /requires an "agent" id or an inline "define"/,
  );
});

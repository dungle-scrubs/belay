import assert from "node:assert/strict";
import type { AgentDefinition } from "@host/subagents/discovery";
import { events, type SessionEvent, type SessionTransport } from "@trevor/session";
import { recordingTransport, storedEvent } from "@trevor/test-kit";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderEvent } from "../providers";
import { ProviderUnavailable } from "../providers";
import {
  type BackgroundDelegator,
  buildDelegateCapability,
  buildDelegationDefs,
  type DelegationContext,
  type DelegationRequest,
  orphanedSubagentReaps,
  runDelegatedChild,
  seedChildSession,
} from "./delegate";
import { type AgentEvent, type DelegateCapability, runAgent } from "./loop";

const USAGE = { input: 10, output: 5, contextWindow: 1000, genMs: 1 } as const;

/**
 * Subagent delegation mechanism (M2 / D-046): a delegation runs the child in its OWN isolated
 * session, seeded with ONLY the parent task, linked to the parent by a `delegated.to` event, and
 * folds the child's final message back as the result. Driven with a fake transport that records
 * publishes per session and a fake provider that answers - no store, no model.
 */

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

/** The verifier variant (plan 45 M2): a read-only independent reviewer. Modeled here like the other
 *  built-ins so the delegation-seam test drives the same shape discovery ships. */
const VERIFIER: AgentDefinition = {
  id: "verifier",
  description: "independent read-only adversarial reviewer",
  tools: ["*"],
  readOnly: true,
  body: "You are an independent adversarial reviewer. Open with `VERDICT: PASS` or `VERDICT: FAIL`.",
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
  const t = recordingTransport();
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

  const childLog = t.publishedBy("child-0");
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
  const t = recordingTransport();
  await runDelegatedChild(context(t.transport), {
    agent: EXPLORER,
    task: "investigate",
    provider: answeringProvider("done"),
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });

  const childLog = t.publishedBy("child-0");
  // Nothing on the child carries the parent run id, and no delegation link rides the child log.
  assert.ok(
    !childLog.some((e) => (e.payload as { runId?: string }).runId === "run-parent"),
    "no parent-run-correlated event leaks into the child",
  );
  assert.ok(!childLog.some((e) => e.type === "delegated.to"), "the link lives only on the parent");
});

test("the parent session gets a running then a done delegated.to link with the result", async () => {
  const t = recordingTransport();
  await runDelegatedChild(context(t.transport), {
    agent: EXPLORER,
    task: "look",
    provider: answeringProvider("the result"),
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });

  const parentLog = t.publishedBy("parent-session").filter((e) => e.type === "delegated.to");
  assert.ok(parentLog.length >= 2, "a running link then a terminal link");
  const running = parentLog[0]?.payload as Record<string, unknown>;
  const done = parentLog.at(-1)?.payload as Record<string, unknown>;
  assert.equal(running.status, "running");
  assert.equal(running.childSessionId, "child-0");
  assert.equal(running.agent, "explorer");
  assert.equal(done.status, "done");
  assert.equal(done.result, "the result", "the terminal link carries the frozen distilled result");
});

test("inline seed link stamps model and actual reasoning while background seed links stay unchanged", async () => {
  const inline = recordingTransport();
  const provider = { ...answeringProvider("done"), model: "qwen3.6-27b-mlx" };
  await seedChildSession(
    context(inline.transport),
    {
      agent: EXPLORER,
      task: "look",
      provider,
      parentRunId: "run-parent",
      childRunId: "run-child",
      mode: "inline",
      reasoningLevel: "high",
    },
    "child-inline",
  );

  const inlineLink = inline.publishedBy("parent-session")[0]?.payload as Record<string, unknown>;
  assert.equal(inlineLink.status, "running");
  assert.equal(inlineLink.model, "qwen3.6-27b-mlx");
  assert.equal(inlineLink.reasoningLevel, "high");

  const background = recordingTransport();
  await seedChildSession(
    context(background.transport),
    {
      agent: EXPLORER,
      task: "look",
      provider,
      parentRunId: "run-parent",
      childRunId: "run-child",
      mode: "background",
      reasoningLevel: "high",
    },
    "child-background",
  );

  const backgroundLink = background.publishedBy("parent-session")[0]?.payload as Record<
    string,
    unknown
  >;
  assert.equal(backgroundLink.status, "running");
  assert.ok(!("model" in backgroundLink), "background link keeps its old payload shape");
  assert.ok(
    !("reasoningLevel" in backgroundLink),
    "background link does not expose live inline metadata",
  );
});

test("inline child output tokens mirror to parent links while background links stay unchanged", async () => {
  const inline = recordingTransport();
  const baseProvider = answeringProvider("done");
  let childReasoning: string | undefined;
  const provider: Provider = {
    ...baseProvider,
    model: "qwen3.6-27b-mlx",
    stream: (messages, tools, reasoning) => {
      childReasoning = reasoning;
      return baseProvider.stream(messages, tools, reasoning);
    },
  };
  await runDelegatedChild(context(inline.transport), {
    agent: EXPLORER,
    task: "look",
    provider,
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
    reasoningLevel: "high",
  });
  assert.equal(childReasoning, "high", "the stamped reasoning is what the child turn ran with");

  const inlineLinks = inline
    .publishedBy("parent-session")
    .filter((e) => e.type === "delegated.to")
    .map((e) => e.payload as Record<string, unknown>);
  assert.equal(inlineLinks.length, 3, "seed link, running token mirror, terminal fold-back");
  assert.equal(inlineLinks[0]?.status, "running");
  assert.ok(!("tokens" in (inlineLinks[0] ?? {})), "the seed link has no token count yet");
  assert.equal(inlineLinks[1]?.status, "running");
  assert.equal(inlineLinks[1]?.tokens, 5);
  assert.equal(inlineLinks[1]?.model, "qwen3.6-27b-mlx");
  assert.equal(inlineLinks[1]?.reasoningLevel, "high");
  assert.equal(inlineLinks[2]?.status, "done");
  assert.equal(inlineLinks[2]?.tokens, 5);

  const background = recordingTransport();
  await runDelegatedChild(context(background.transport), {
    agent: EXPLORER,
    task: "look",
    provider,
    parentRunId: "run-parent",
    childRunId: "run-child",
    childSessionId: "child-background",
    mode: "background",
    reasoningLevel: "high",
  });

  const backgroundLinks = background
    .publishedBy("parent-session")
    .filter((e) => e.type === "delegated.to")
    .map((e) => e.payload as Record<string, unknown>);
  assert.equal(backgroundLinks.length, 2, "background keeps only running + terminal links");
  assert.deepEqual(
    backgroundLinks.map((link) => link.status),
    ["running", "done"],
  );
  for (const link of backgroundLinks) {
    assert.ok(!("model" in link), "background link carries no inline model metadata");
    assert.ok(!("reasoningLevel" in link), "background link carries no inline reasoning metadata");
    assert.ok(!("tokens" in link), "background link carries no token mirror");
  }
});

test("a child turn that errors folds back as a failed link, never throwing into the parent", async () => {
  const t = recordingTransport();
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
  const done = t
    .publishedBy("parent-session")
    .filter((e) => e.type === "delegated.to")
    .at(-1)?.payload as Record<string, unknown>;
  assert.equal(done.status, "failed", "the terminal link marks the failure");
});

// --- plan 45 M2: the verifier variant runs over the SAME delegation isolation, verdict parent-visible ---

test("the verifier reviews in an isolated child and its verdict folds back to the parent (plan 45 M2)", async () => {
  const t = recordingTransport();
  let offered: string[] = [];
  // A provider that captures the verifier's offered tools, then returns an explicit verdict.
  const provider: Provider = {
    ...answeringProvider(""),
    stream: (_messages, tools) => {
      offered = tools.map((tt) => tt.name);
      return Stream.fromIterable<ProviderEvent>([
        { type: "text", text: "VERDICT: FAIL\n- the edge case at src/x.ts:12 is unhandled" },
        { type: "usage", usage: USAGE },
      ]);
    },
  };
  const out = await runDelegatedChild(context(t.transport), {
    agent: VERIFIER,
    task: "verify the change in src/x.ts",
    provider,
    parentRunId: "run-parent",
    childRunId: "run-child",
    mode: "inline",
  });

  // Independent review, not self-validation: it ran in its OWN isolated child session seeded with
  // ONLY the task (no parent transcript), and read-only so it could never edit the work it judged.
  const childLog = t.publishedBy("child-0");
  assert.equal((childLog[0]?.payload as { text?: string }).text, "verify the change in src/x.ts");
  assert.ok(offered.includes("read"), "the verifier keeps read-only tools");
  for (const mut of ["write", "edit", "bash"]) {
    assert.ok(!offered.includes(mut), `the verifier cannot mutate via ${mut}`);
  }

  // Parent-visible verdict: the distilled verdict is BOTH the returned result the parent acts on AND
  // the terminal delegated.to link on the PARENT session.
  assert.equal(out.failed, false, "a FAIL verdict is a completed review, not a delegation failure");
  assert.match(out.result, /^VERDICT: FAIL/);
  const done = t
    .publishedBy("parent-session")
    .filter((e) => e.type === "delegated.to")
    .at(-1)?.payload as Record<string, unknown>;
  assert.equal(done.agent, "verifier");
  assert.equal(done.status, "done");
  assert.match(String(done.result), /^VERDICT: FAIL/, "the parent link carries the frozen verdict");
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
  const t = recordingTransport();
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
  const cap = buildDelegateCapability(context(recordingTransport().transport), {
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
  const t = recordingTransport();
  const cap = capability(t.transport, answeringProvider("ephemeral did it"));
  const out = await cap.run(
    "delegate_inline",
    JSON.stringify({
      define: { description: "one-off", instructions: "do the thing", tools: ["read", "grep"] },
      task: "go",
    }),
  );
  assert.equal(out, "ephemeral did it");
  const link = t.publishedBy("parent-session").find((e) => e.type === "delegated.to")
    ?.payload as Record<string, unknown>;
  assert.equal(link.agent, "ephemeral", "the link records it as an ephemeral agent");
});

test("an ephemeral define is validated strictly against the registry", async () => {
  const cap = capability(recordingTransport().transport, answeringProvider(""));
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
  const cap = capability(recordingTransport().transport, answeringProvider(""));
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
  const cap = capability(recordingTransport().transport, answeringProvider(""));
  assert.match(
    await cap.run("delegate_inline", JSON.stringify({ task: "go" })),
    /requires an "agent" id or an inline "define"/,
  );
});

// --- M3/M4: background delegation (D-048): async, read-only, capped ---

/** A recording background delegator: captures started requests and runs them through the same
 *  runDelegatedChild the host would, but synchronously awaitable so the test can assert the result. */
function recordingDelegator(transport: SessionTransport, cap = 4) {
  const started: DelegationRequest[] = [];
  const ran: Promise<unknown>[] = [];
  let available = true;
  const delegator: BackgroundDelegator = {
    cap,
    canStart: () => available,
    start: (req) => {
      started.push(req);
      ran.push(runDelegatedChild(context(transport), req));
    },
  };
  return {
    started,
    delegator,
    drain: () => Promise.all(ran),
    setAvailable: (v: boolean) => {
      available = v;
    },
  };
}

function capabilityWithBackground(
  transport: SessionTransport,
  provider: Provider,
  delegator: BackgroundDelegator,
) {
  return buildDelegateCapability(context(transport), {
    provider,
    parentRunId: "rp",
    agents: [EXPLORER],
    mintRunId: () => "rc",
    background: delegator,
  });
}

test("both delegation tools are offered, and delegate_background advertises its async/read-only/cap", () => {
  const defs = buildDelegationDefs([EXPLORER], 4);
  const names = defs.map((d) => d.name);
  assert.deepEqual(names, ["delegate_inline", "delegate_background"]);
  const bg = defs.find((d) => d.name === "delegate_background");
  assert.match(bg?.description ?? "", /ASYNCHRONOUSLY/);
  assert.match(bg?.description ?? "", /READ-ONLY/);
  assert.match(bg?.description ?? "", /Up to 4 run at once/);
});

test("delegate_background returns immediately with an ack and starts a tracked child", async () => {
  const t = recordingTransport();
  const bg = recordingDelegator(t.transport);
  const cap = capabilityWithBackground(t.transport, answeringProvider("found it"), bg.delegator);
  const ack = await cap.run(
    "delegate_background",
    JSON.stringify({ agent: "explorer", task: "scan" }),
  );
  assert.match(ack, /Started background subagent "explorer"/);
  assert.match(ack, /arrive later as a delegation update/);
  assert.equal(
    bg.started.length,
    1,
    "the host's background delegator was asked to start one child",
  );
  assert.equal(bg.started[0]?.mode, "background");
  // The child runs to completion and lands a terminal link on the parent (the late result).
  await bg.drain();
  const links = t.publishedBy("parent-session").filter((e) => e.type === "delegated.to");
  assert.equal((links.at(-1)?.payload as Record<string, unknown>).status, "done");
  assert.equal((links.at(-1)?.payload as Record<string, unknown>).result, "found it");
});

test("delegate_background is rejected past the cap (and does not start a child)", async () => {
  const t = recordingTransport();
  const bg = recordingDelegator(t.transport, 4);
  bg.setAvailable(false); // cap reached
  const cap = capabilityWithBackground(t.transport, answeringProvider("x"), bg.delegator);
  const out = await cap.run(
    "delegate_background",
    JSON.stringify({ agent: "explorer", task: "scan" }),
  );
  assert.match(out, /too many background subagents already running \(max 4\)/);
  assert.equal(bg.started.length, 0, "no child is started when the cap is full");
});

test("delegate_background is unavailable when the host wires no background delegator", async () => {
  const cap = capability(recordingTransport().transport, answeringProvider(""));
  assert.match(
    await cap.run("delegate_background", JSON.stringify({ agent: "explorer", task: "scan" })),
    /background delegation is not available/,
  );
});

test("a background child is clamped to READ-ONLY tools (even general-purpose / tools:['*'])", async () => {
  const t = recordingTransport();
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
    agent: GENERAL, // tools: ['*'] - inline this would be every tool
    task: "x",
    provider,
    parentRunId: "rp",
    childRunId: "rc",
    childSessionId: "child-bg",
    mode: "background",
  });
  assert.ok(childOffered.includes("read"), "a read-only tool is still offered");
  assert.ok(!childOffered.includes("edit"), "edit is clamped out of a background child");
  assert.ok(!childOffered.includes("write"), "write is clamped out of a background child");
  assert.ok(!childOffered.includes("bash"), "bash is clamped out of a background child");
});

test("an ephemeral agent cannot allow-list delegate_background either (depth-1 covers both tools)", async () => {
  const cap = capability(recordingTransport().transport, answeringProvider(""));
  assert.match(
    await cap.run(
      "delegate_inline",
      JSON.stringify({
        define: { description: "x", instructions: "y", tools: ["delegate_background"] },
        task: "go",
      }),
    ),
    /may not use delegation tools/,
  );
});

/**
 * Host-side subagent reap on leadership takeover (plan 52 / D-001): the subagent analogue of the turn
 * `reapExcept`. A new/reconnecting leader derives orphaned `delegated.to{running}` links from the replayed
 * PARENT log and closes them to `interrupted`, excluding children THIS host is itself running. Pure over
 * the log, so the reap policy is tested without a store or a leader election.
 */
const parentLink = (childSessionId: string, status: string): SessionEvent =>
  storedEvent(
    events.delegatedTo({
      runId: "r1",
      childSessionId,
      agent: "explorer",
      task: "scan the repo",
      mode: "background",
      status: status as "running" | "done" | "failed" | "interrupted",
    }),
  );

test("reap closes an orphaned running subagent to interrupted (no terminal link, not active)", () => {
  const reaps = orphanedSubagentReaps([parentLink("s::sub::bg", "running")], new Set());
  assert.equal(reaps.length, 1);
  assert.equal(reaps[0]?.type, "delegated.to");
  assert.equal(reaps[0]?.payload.childSessionId, "s::sub::bg");
  assert.equal(reaps[0]?.payload.status, "interrupted", "recovered, not a genuine failed");
  assert.equal(
    reaps[0]?.payload.agent,
    "explorer",
    "carries the original link fields for the reducer",
  );
  assert.equal(reaps[0]?.payload.mode, "background");
});

test("reap does NOT close a subagent this host is itself running (backgroundChildren exclusion)", () => {
  // The subagent analogue of reapExcept excluding the active run: an in-flight child is not an orphan.
  const reaps = orphanedSubagentReaps(
    [parentLink("s::sub::mine", "running")],
    new Set(["s::sub::mine"]),
  );
  assert.deepEqual(reaps, []);
});

test("reap is idempotent: a second takeover after the interrupted link is in the log emits nothing", () => {
  const afterFirstReap = [
    parentLink("s::sub::bg", "running"),
    parentLink("s::sub::bg", "interrupted"),
  ];
  assert.deepEqual(
    orphanedSubagentReaps(afterFirstReap, new Set()),
    [],
    "any terminal status (incl. interrupted) closes the link",
  );
});

test("reap treats a done or failed fold-back as closing the link (no double-close)", () => {
  assert.deepEqual(
    orphanedSubagentReaps([parentLink("s::a", "running"), parentLink("s::a", "done")], new Set()),
    [],
  );
  assert.deepEqual(
    orphanedSubagentReaps([parentLink("s::b", "running"), parentLink("s::b", "failed")], new Set()),
    [],
  );
});

test("reap closes only the genuinely-orphaned child when several are in flight", () => {
  const log = [
    parentLink("s::orphan", "running"),
    parentLink("s::mine", "running"),
    parentLink("s::done", "running"),
    parentLink("s::done", "done"),
  ];
  const reaps = orphanedSubagentReaps(log, new Set(["s::mine"]));
  assert.deepEqual(
    reaps.map((r) => r.payload.childSessionId),
    ["s::orphan"],
    "s::mine is active, s::done already folded back; only s::orphan is reaped",
  );
});

test("hermetic failover: two leadership takeovers reap an orphaned subagent exactly once (M5)", () => {
  // A leader started a background child (running link) then died before fold-back.
  let log: SessionEvent[] = [parentLink("s::sub::bg", "running")];
  // Takeover #1 on a second host: exactly one terminal interrupted link is emitted; the store durably
  // appends it (as `emit` would).
  const first = orphanedSubagentReaps(log, new Set());
  assert.equal(first.length, 1, "the new leader closes the orphan once");
  const firstLink = first[0];
  assert.ok(firstLink);
  log = [...log, storedEvent(firstLink)];
  // Takeover #2 (a later reconnect / re-election): the interrupted link is already terminal in the log,
  // so nothing further is emitted - no duplicate close.
  assert.deepEqual(orphanedSubagentReaps(log, new Set()), [], "a second takeover emits nothing");
});

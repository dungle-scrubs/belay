import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { fakeProvider, runTurn } from "./support/fake-provider";

/**
 * The plan 22.2 characterization net for the `main.ts` split: pins `handleEvent`'s routing
 * completeness (every protocol event kind is CONSCIOUSLY routed or ignored), the startup wiring
 * order, and the loop's text-only outcome grammar - the behaviors typecheck and the existing
 * suites do not assert. Static source pins are deliberate: they survive the M2 extraction only if
 * the routing table and startup narrative stay visible in main.ts (D-003).
 *
 * Responsible for: characterizing main.ts routing/startup and the turn loop's plain-answer
 * outcome before and after the god-file decomposition.
 * Not for: behavioral turn coverage - test/turn.test.ts owns the loop's outcome matrix.
 */

const HOST_ROOT = join(import.meta.dirname, "..");
const MAIN = readFileSync(join(HOST_ROOT, "src", "main.ts"), "utf8");
const PROTOCOL_DECODE = readFileSync(
  join(HOST_ROOT, "..", "..", "packages", "session", "src", "protocol", "decode.ts"),
  "utf8",
);

/**
 * The characterized protocol: every event kind `decodeTrevorEvent` can produce, split by whether
 * `handleEvent` routes it. A NEW protocol kind must be added to one of these sets - the
 * completeness test below fails until it is consciously categorized.
 */
const ROUTED: readonly string[] = [
  "assistant.completed",
  "assistant.overflow",
  "assistant.progress",
  "assistant.started",
  "command.result",
  "context.compacted",
  "editor.open",
  "file.index.requested",
  "handoff.accepted",
  "handoff.approved",
  "handoff.failed",
  "handoff.generated",
  "handoff.rejected",
  "host.beat",
  "host.hello",
  "model.switch.requested",
  "provider.question.answer",
  "tasks.current",
  "tool.completed",
  "tool.started",
  "user.cancel",
  "user.command",
  "user.message",
  "user.shell",
  // The durable follow-up queue retraction (plan 47 D-003): handleEvent routes it to the scheduler
  // (drop from the queue) and admits it so the projection excludes the superseded prompt.
  "user.supersede",
];

const UNROUTED: readonly string[] = [
  "admission.status",
  "assistant.continued",
  "assistant.delta",
  // A provider usage-limit signal (plan 44.4): host-emitted from the turn pipeline, web-rendered +
  // read by the SDK harness projection; handleEvent never consumes it (detection only, D-004).
  "assistant.limit",
  "assistant.reconnecting",
  "assistant.recovered",
  "assistant.thinking",
  "context.compacting",
  "delegated.to",
  // The `@`-file-mention index (plan 30): the leader emits it as a read model; handleEvent never
  // consumes it (the browser derives the index from the stream).
  "file.index.result",
  "handoff.generating",
  "handoff.requested",
  // A visible hook decision (plan 25 M9): host-emitted from the turn pipeline, web-rendered;
  // handleEvent never consumes it.
  "hook.decision",
  "host.internet",
  "host.online",
  "host.role",
  "loop.status",
  // Located Lucid review events (plan 27): the human's feedback + review lifecycle. handleEvent never
  // consumes them; the turn's history projection (history-projection.ts) folds `lucid.feedback` into a
  // safely-framed prompt turn, and the web derives the panel/review state from the stream.
  "lucid.feedback",
  "lucid.published",
  "lucid.review",
  "model.switched",
  "provider.question.requested",
  "provider.question.resolved",
  // The supervisor side-channel (plan 44.1): launch / folder-pick / projects-list requests + results
  // ride the reserved control session, which the agent-host never subscribes to - the supervisor daemon
  // (apps/supervisor) handles them, not handleEvent.
  "folder.pick.requested",
  "folder.pick.result",
  "projects.list.requested",
  "projects.list.result",
  // The project-registry side-channel (plan 58 M2): add/rename/collapse/remove requests + results
  // ride the reserved control session, handled by the supervisor daemon - never by handleEvent.
  "project.add.requested",
  "project.add.result",
  "project.collapse.requested",
  "project.collapse.result",
  "project.remove.requested",
  "project.remove.result",
  "project.rename.requested",
  "project.rename.result",
  "session.launch.requested",
  "session.launch.result",
  "session.archived",
  "session.deleted",
  "session.project",
  "session.switch",
  "session.title",
  "shell.result",
  "tool.guardrail",
  // Workflow journal events are host-emitted by the workflow engine and consumed by resume/projection
  // helpers, not by the main session ingress router.
  "workflow.agent",
  "workflow.completed",
  "workflow.leaf-failed",
  "workflow.log",
  "workflow.phase",
  "workflow.started",
];

/** The `handleEvent` function body, extracted by brace counting from its declaration. */
function handleEventBody(): string {
  const start = MAIN.indexOf("function handleEvent(");
  assert.ok(start >= 0, "main.ts no longer declares handleEvent");
  let depth = 0;
  for (let i = MAIN.indexOf("{", start); i < MAIN.length; i++) {
    if (MAIN[i] === "{") depth++;
    if (MAIN[i] === "}") depth--;
    if (depth === 0) {
      return MAIN.slice(start, i + 1);
    }
  }
  assert.fail("unbalanced braces scanning handleEvent");
}

test("the characterized protocol snapshot matches decodeTrevorEvent's actual event kinds", () => {
  const actual = new Set(
    [...PROTOCOL_DECODE.matchAll(/type: "([a-z][a-z.-]*[a-z])"/g)].map((m) => m[1] as string),
  );
  const characterized = new Set([...ROUTED, ...UNROUTED]);

  const unknown = [...characterized].filter((t) => !actual.has(t)).sort();
  assert.deepEqual(unknown, [], `characterized kinds the protocol no longer decodes: ${unknown}`);

  const uncategorized = [...actual].filter((t) => !characterized.has(t)).sort();
  assert.deepEqual(
    uncategorized,
    [],
    `new protocol kinds - categorize as ROUTED or UNROUTED: ${uncategorized}`,
  );
});

test("handleEvent routes every ROUTED kind and none of the UNROUTED kinds", () => {
  const body = handleEventBody();

  const missing = ROUTED.filter((t) => !body.includes(`"${t}"`));
  assert.deepEqual(missing, [], `handleEvent lost its route for: ${missing}`);

  const leaked = UNROUTED.filter((t) => body.includes(`"${t}"`));
  assert.deepEqual(
    leaked,
    [],
    `kinds newly referenced by handleEvent - move them to ROUTED: ${leaked}`,
  );
});

test("the startup narrative wires in the characterized order", () => {
  const order = [
    "configureRecall();",
    "refreshCatalog();",
    "ensureSessionWithRetry(",
    ".then(() => connect())",
  ];
  let last = -1;

  // lastIndexOf: the startup narrative is main.ts's tail; earlier occurrences (e.g. the
  // /catalog-refresh command handler calling refreshCatalog) are not the wiring being pinned.
  for (const marker of order) {
    const at = MAIN.lastIndexOf(marker);
    assert.ok(at > last, `startup order drifted: ${marker} out of sequence`);
    last = at;
  }

  const connectAt = MAIN.indexOf("function connect()");
  const connectBody = MAIN.slice(connectAt, MAIN.indexOf("\n}", connectAt));
  assert.ok(
    connectBody.includes("mainWorker.connect();"),
    "connect() no longer delegates stream wiring to the main session worker",
  );

  const workerAt = MAIN.indexOf("const mainWorker = makeSessionWorker(");
  const workerBody = MAIN.slice(workerAt, MAIN.indexOf("\n});", workerAt));
  assert.ok(workerBody.includes("onEvent: (message) => handleEvent(message)"));
  const liveAt = workerBody.indexOf("live = true;");
  const goLiveAt = workerBody.indexOf("goLive();");
  assert.ok(
    liveAt >= 0 && liveAt < goLiveAt,
    "worker replay completion must set live before goLive() runs",
  );
});

test("loop outcome grammar: a text-only turn is started -> progress -> one completed, no tools", async () => {
  const provider = fakeProvider({
    step: () => [
      { type: "text", text: "Plain answer, no tools. " },
      { type: "usage", usage: { input: 10, output: 5, contextWindow: 1000, genMs: 1 } },
    ],
  });
  const events = await runTurn(provider, [{ role: "user", content: "Just answer." }], {
    runId: "r-plain",
  });
  const types = events.map((e) => e.type);

  assert.equal(types[0], "assistant.started");
  assert.ok(!types.includes("tool.started") && !types.includes("tool.completed"), types.join());
  assert.equal(types.filter((t) => t === "assistant.completed").length, 1);
  assert.equal(types[types.length - 1], "assistant.completed");

  const final = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(final?.error, undefined);
  assert.ok(String(final?.text ?? "").includes("Plain answer"), String(final?.text));
});

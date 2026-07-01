import type { PublishInput, SessionEvent } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { buildHistory } from "./agent/history-projection";
import { type ForkFlowDeps, forkSession } from "./fork-flow";

function ev(
  seq: number,
  type: string,
  producerId: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    sessionId: "parent",
    seq,
    eventId: `e${seq}`,
    type,
    producerId,
    payload,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

/** A parent log with two full turns + a session-local control event in the middle. */
const PARENT: SessionEvent[] = [
  ev(1, "user.message", "trevor-web", { text: "first question" }),
  ev(2, "assistant.completed", "trevor-host", { runId: "r1", text: "first answer" }),
  ev(3, "session.title", "trevor-host", { title: "chat" }),
  ev(4, "user.message", "trevor-web", { text: "second question" }),
  ev(5, "assistant.completed", "trevor-host", { runId: "r2", text: "second answer" }),
];

/** An in-memory store: reads the parent log, records appends to the child assigning seq/eventId. */
function makeStore(parent: SessionEvent[]): { deps: ForkFlowDeps; child: SessionEvent[] } {
  const child: SessionEvent[] = [];
  let seq = 0;
  const deps: ForkFlowDeps = {
    readSession: (id) => Promise.resolve(id === "parent" ? parent : child),
    newSessionId: () => "child",
    ensureSession: () => Promise.resolve(),
    append: (sessionId, input: PublishInput) => {
      seq += 1;
      child.push({
        sessionId,
        seq,
        eventId: `c${seq}`,
        type: input.type,
        producerId: input.producerId,
        payload: input.payload,
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      return Promise.resolve();
    },
  };
  return { deps, child };
}

describe("host fork operation over the normal append API (M2)", () => {
  it("appends the copied prefix + a trailing forkedFrom marker to a fresh child", async () => {
    const { deps, child } = makeStore(PARENT);
    const result = await forkSession(deps, { parentSessionId: "parent", forkSeq: 2 });
    expect(result.childSessionId).toBe("child");
    expect(result.copied).toBe(2); // seq 1 (user) + 2 (assistant); seq 3 (title) is not forkable
    expect(result.forkReady).toBe(true);
    expect(child.map((e) => e.type)).toEqual([
      "user.message",
      "assistant.completed",
      "session.forkedFrom",
    ]);
    // The lineage marker records the parent + fork point.
    expect(child.at(-1)?.payload).toEqual({ parentSessionId: "parent", forkSeq: 2 });
  });

  it("produces a SELF-CONTAINED child: replaying only the child log reconstructs the prefix conversation", async () => {
    const { deps, child } = makeStore(PARENT);
    await forkSession(deps, { parentSessionId: "parent", forkSeq: 4 });
    // Replaying ONLY the child's own log (no access to the parent) yields the same conversation as
    // replaying the parent up to the fork point.
    const fromChild = buildHistory(child);
    const fromParentPrefix = buildHistory(PARENT.filter((e) => e.seq <= 4));
    expect(fromChild).toEqual(fromParentPrefix);
    // Sanity: the reconstructed conversation is the first user turn + answer + the second user turn.
    expect(fromChild.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(fromChild.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "second question",
    ]);
  });

  it("preserves a /clear boundary so a fork does not resurrect explicitly-cleared context", async () => {
    // The parent cleared its context mid-session; the fork must NOT replay the pre-clear turn.
    const withClear: SessionEvent[] = [
      ev(1, "user.message", "trevor-web", { text: "secret old context" }),
      ev(2, "assistant.completed", "trevor-host", { runId: "r1", text: "old answer" }),
      ev(3, "user.command", "trevor-web", { command: "/clear", args: "" }),
      ev(4, "user.message", "trevor-web", { text: "fresh question" }),
      ev(5, "assistant.completed", "trevor-host", { runId: "r2", text: "fresh answer" }),
    ];
    const { deps, child } = makeStore(withClear);
    await forkSession(deps, { parentSessionId: "parent", forkSeq: 5 });
    const history = buildHistory(child);
    // Only the post-/clear turn survives the projection - the cleared context is gone.
    expect(history.map((m) => m.content)).toEqual(["fresh question", "fresh answer"]);
    expect(JSON.stringify(history)).not.toContain("secret old context");
  });

  it("carries the ACTIVE post-switch model as the child's inherited resume model (M4, D-002)", async () => {
    // A parent whose turn switched model mid-flight: the fork must resume on the switched-to model.
    const withSwitch: SessionEvent[] = [
      ev(1, "user.message", "trevor-web", { text: "q", provider: "qwen", reasoning: "low" }),
      ev(2, "model.switched", "trevor-host", {
        runId: "r1",
        from: { model: "qwen" },
        to: { model: "opus", reasoning: "high" },
        initiator: "manual",
        outcome: "applied",
      }),
      ev(3, "assistant.completed", "trevor-host", { runId: "r1", text: "a" }),
    ];
    const { deps } = makeStore(withSwitch);
    const result = await forkSession(deps, { parentSessionId: "parent", forkSeq: 3 });
    // The switch moved the model id to opus; the source stays qwen (the active source at the switch).
    expect(result.inheritedModel).toEqual({ sourceId: "qwen", modelId: "opus", reasoning: "high" });
  });
});

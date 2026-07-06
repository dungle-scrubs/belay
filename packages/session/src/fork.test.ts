import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./event";
import { hasForkOrigin, isForkReady, planFork } from "./fork";
import { PRODUCER_IDS } from "./identity";
import { events } from "./protocol";
import { decodeTrevorEvent } from "./protocol-decode";

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): SessionEvent {
  return {
    sessionId: "parent",
    seq,
    eventId: `e${seq}`,
    type,
    producerId: "host",
    payload,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

const PARENT: SessionEvent[] = [
  ev(1, "user.message", { text: "hi" }),
  ev(2, "assistant.completed", { runId: "r1", text: "hello" }),
  ev(3, "session.title", { title: "chat" }),
  ev(4, "model.switched", { runId: "r2", to: { model: "opus", reasoning: "high" } }),
  ev(5, "user.message", { text: "again" }),
  ev(6, "host.beat", { instanceId: "abc" }),
  ev(7, "assistant.completed", { runId: "r2", text: "sure" }),
];

describe("session.forkedFrom lineage event", () => {
  it("round-trips through the event constructor + decoder", () => {
    const input = events.sessionForkedFrom({ parentSessionId: "parent", forkSeq: 5 });

    expect(input.type).toBe("session.forkedFrom");
    expect(decodeTrevorEvent(ev(1, "session.forkedFrom", input.payload))).toEqual({
      type: "session.forkedFrom",
      parentSessionId: "parent",
      forkSeq: 5,
    });
  });
});

describe("fork plan over normal append APIs", () => {
  it("copies only the forkable prefix, tags origins, and appends the marker last", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: PARENT,
      forkSeq: 5,
      childSessionId: "child",
    });

    expect(plan.childSessionId).toBe("child");
    expect(plan.copied).toBe(4);
    expect(plan.events.map((e) => e.type)).toEqual([
      "user.message",
      "assistant.completed",
      "model.switched",
      "user.message",
      "session.forkedFrom",
    ]);

    expect(plan.events[0]?.payload._forkOrigin).toEqual({ sessionId: "parent", seq: 1 });
    expect(plan.events[2]?.payload.to).toEqual({ model: "opus", reasoning: "high" });
    expect(plan.events[2]?.payload._forkOrigin).toEqual({ sessionId: "parent", seq: 4 });

    const marker = plan.events.at(-1);
    expect(marker?.producerId).toBe(PRODUCER_IDS.host);
    expect(marker?.payload).toEqual({ parentSessionId: "parent", forkSeq: 5 });
  });

  it("overwrites any inherited origin with the immediate parent", () => {
    const childEvent = {
      ...ev(2, "user.message", {
        text: "hi",
        _forkOrigin: { sessionId: "grandparent", seq: 9 },
      }),
      sessionId: "child",
    };

    const plan = planFork({
      parentSessionId: "child",
      parentEvents: [childEvent],
      forkSeq: 2,
      childSessionId: "grandchild",
    });

    expect(plan.events[0]?.payload._forkOrigin).toEqual({ sessionId: "child", seq: 2 });
  });

  it("marks a child fork-ready only once the forkedFrom marker is present", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: PARENT,
      forkSeq: 5,
      childSessionId: "child",
    });
    const partial = plan.events.slice(0, -1).map((e) => ({ type: e.type }));

    expect(isForkReady(partial)).toBe(false);
    expect(isForkReady(plan.events.map((e) => ({ type: e.type })))).toBe(true);
  });
});

describe("active model inherited by a fork", () => {
  const userMsg = (seq: number, provider: string, reasoning?: string) =>
    ev(seq, "user.message", { text: "q", provider, ...(reasoning ? { reasoning } : {}) });
  const switched = (
    seq: number,
    to: { model: string; reasoning?: string },
    outcome: "applied" | "blocked",
  ) =>
    ev(seq, "model.switched", {
      runId: `r${seq}`,
      from: { model: "qwen" },
      to,
      initiator: "manual",
      outcome,
    });

  it("seeds source+model from a structured ModelRef user.message", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [
        ev(1, "user.message", {
          text: "q",
          model: { sourceId: "openai", modelId: "gpt-4o", reasoning: "high" },
        }),
      ],
      forkSeq: 1,
      childSessionId: "child",
    });

    expect(plan.inheritedModel).toEqual({
      sourceId: "openai",
      modelId: "gpt-4o",
      reasoning: "high",
    });
  });

  it("seeds from a legacy bare-provider user.message", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [userMsg(1, "qwen", "low")],
      forkSeq: 1,
      childSessionId: "child",
    });

    expect(plan.inheritedModel).toEqual({
      sourceId: "qwen",
      modelId: "qwen",
      reasoning: "low",
    });
  });

  it("resumes on the applied post-switch model while keeping the active source", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [
        userMsg(1, "qwen", "low"),
        switched(2, { model: "opus", reasoning: "high" }, "applied"),
      ],
      forkSeq: 2,
      childSessionId: "child",
    });

    expect(plan.inheritedModel).toEqual({
      sourceId: "qwen",
      modelId: "opus",
      reasoning: "high",
    });
  });

  it("ignores a blocked switch", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [userMsg(1, "qwen", "low"), switched(2, { model: "opus" }, "blocked")],
      forkSeq: 2,
      childSessionId: "child",
    });

    expect(plan.inheritedModel).toEqual({
      sourceId: "qwen",
      modelId: "qwen",
      reasoning: "low",
    });
  });

  it("lets a later user.message re-establish the active model", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [
        userMsg(1, "qwen"),
        switched(2, { model: "opus" }, "applied"),
        userMsg(3, "deepseek", "medium"),
      ],
      forkSeq: 3,
      childSessionId: "child",
    });

    expect(plan.inheritedModel).toEqual({
      sourceId: "deepseek",
      modelId: "deepseek",
      reasoning: "medium",
    });
  });

  it("is null when the prefix carries no model information", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [ev(1, "assistant.completed", { runId: "r1", text: "hi" })],
      forkSeq: 1,
      childSessionId: "child",
    });

    expect(plan.inheritedModel).toBeNull();
  });
});

describe("hasForkOrigin", () => {
  it("is false for an authored event, true for a fork-copied one", () => {
    expect(hasForkOrigin(ev(1, "user.message", { text: "hi" }))).toBe(false);
    expect(hasForkOrigin(ev(1, "user.message", { _forkOrigin: { sessionId: "p", seq: 1 } }))).toBe(
      true,
    );
  });

  it("recognizes every non-marker seed planFork produces (the writer + predicate agree)", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: [ev(1, "user.message", { text: "seed" })],
      forkSeq: 1,
      childSessionId: "child",
    });
    // The copied seed carries the origin; the appended session.forkedFrom marker does not.
    expect(hasForkOrigin(plan.events[0] as { payload: Record<string, unknown> })).toBe(true);
    expect(hasForkOrigin(plan.events.at(-1) as { payload: Record<string, unknown> })).toBe(false);
  });
});

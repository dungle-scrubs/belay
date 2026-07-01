import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./event";
import {
  buildForkPrefix,
  dedupeByOrigin,
  FORK_ORIGIN_KEY,
  forkOriginOf,
  isForkableEvent,
  isForkReady,
  MODEL_SELECTION_INHERITANCE,
  messageId,
  planFork,
  reconstructActiveModel,
  selectForkPrefix,
} from "./fork";
import { PRODUCER_IDS } from "./identity";
import { events } from "./protocol";
import { decodeTrevorEvent } from "./protocol-decode";

/** Builds a minimal SessionEvent for the prefix tests. */
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

/** A realistic parent log: two turns of conversation interleaved with session-local control events. */
const PARENT: SessionEvent[] = [
  ev(1, "user.message", { text: "hi" }),
  ev(2, "assistant.completed", { runId: "r1", text: "hello" }),
  ev(3, "session.title", { title: "chat" }), // session-local control - not forkable
  ev(4, "model.switched", { runId: "r2", to: { model: "opus", reasoning: "high" } }),
  ev(5, "user.message", { text: "again" }),
  ev(6, "host.beat", { instanceId: "abc" }), // transport/presence - not forkable
  ev(7, "assistant.completed", { runId: "r2", text: "sure" }),
];

describe("stable per-message identity (M1)", () => {
  it("derives a stable, deterministic id from (sessionId, seq) - not the store-minted eventId", () => {
    const a = ev(5, "user.message");
    expect(messageId(a)).toBe("parent:5");
    expect(messageId(a)).toBe(messageId(ev(5, "user.message")));
    // The id does not depend on the store-minted eventId (which a fork COPY would reassign).
    expect(messageId({ sessionId: "parent", seq: 5 })).toBe("parent:5");
  });
});

describe("forkable event classification (M1)", () => {
  it("copies durable conversation/turn/model/task/context state, not session-local control", () => {
    for (const t of [
      "user.message",
      "assistant.completed",
      "tool.started",
      "tool.completed",
      "model.switched",
      "context.compacted",
      "tasks.current",
    ]) {
      expect(isForkableEvent(t)).toBe(true);
    }
    for (const t of [
      "session.switch",
      "session.title",
      "session.archived",
      "session.deleted",
      "host.online",
      "host.beat",
      "presence",
      "handoff.requested",
      "delegated.to",
      "assistant.delta", // ephemeral streaming - superseded by assistant.completed
    ]) {
      expect(isForkableEvent(t)).toBe(false);
    }
  });
});

describe("prefix selection (M1)", () => {
  it("selects forkable events up to AND INCLUDING the fork seq, dropping later + non-forkable ones", () => {
    const prefix = selectForkPrefix(PARENT, 5);
    // seq 1,2,4,5 are forkable and <= 5; seq 3 (session.title) is excluded; seq 6,7 are after 5.
    expect(prefix.map((e) => e.seq)).toEqual([1, 2, 4, 5]);
  });

  it("includes the fork-point event itself", () => {
    expect(selectForkPrefix(PARENT, 7).map((e) => e.seq)).toEqual([1, 2, 4, 5, 7]);
  });
});

describe("fork prefix builder (M1)", () => {
  it("produces PublishInputs preserving type/producer/payload, each tagged with its parent origin", () => {
    const seeds = buildForkPrefix({ parentSessionId: "parent", parentEvents: PARENT, forkSeq: 5 });
    expect(seeds.map((s) => s.type)).toEqual([
      "user.message",
      "assistant.completed",
      "model.switched",
      "user.message",
    ]);
    // The first seed keeps the original payload PLUS an origin tag pointing at parent seq 1.
    const first = seeds[0];
    expect(first?.producerId).toBe("host");
    expect(first?.payload.text).toBe("hi");
    expect(first?.payload[FORK_ORIGIN_KEY]).toEqual({ sessionId: "parent", seq: 1 });
    // The model.switched carries its "to" model through the copy (M4 reconstructs the active model from it).
    const switched = seeds[2];
    expect(switched?.payload.to).toEqual({ model: "opus", reasoning: "high" });
    expect(switched?.payload[FORK_ORIGIN_KEY]).toEqual({ sessionId: "parent", seq: 4 });
  });

  it("reads the origin back off a copied event, and returns null for a native (untagged) event", () => {
    const seeds = buildForkPrefix({ parentSessionId: "parent", parentEvents: PARENT, forkSeq: 5 });
    // A seed is a PublishInput; wrap its payload to read the origin.
    expect(forkOriginOf({ payload: seeds[0]?.payload ?? {} })).toEqual({
      sessionId: "parent",
      seq: 1,
    });
    expect(forkOriginOf(ev(1, "user.message"))).toBeNull();
  });

  it("re-forking overwrites any inherited origin tag with the IMMEDIATE parent (single-parent lineage)", () => {
    // A child event that was itself copied (carries grandparent origin) is forked again from "child".
    const childEvent = ev(2, "user.message", {
      text: "hi",
      [FORK_ORIGIN_KEY]: { sessionId: "grandparent", seq: 9 },
    });
    const child = { ...childEvent, sessionId: "child" };
    const seeds = buildForkPrefix({ parentSessionId: "child", parentEvents: [child], forkSeq: 2 });
    expect(seeds[0]?.payload[FORK_ORIGIN_KEY]).toEqual({ sessionId: "child", seq: 2 });
  });
});

describe("session.forkedFrom lineage event (M2)", () => {
  it("round-trips through the event constructor + decoder", () => {
    const input = events.sessionForkedFrom({ parentSessionId: "parent", forkSeq: 5 });
    expect(input.type).toBe("session.forkedFrom");
    const decoded = decodeTrevorEvent(ev(1, "session.forkedFrom", input.payload));
    expect(decoded).toEqual({ type: "session.forkedFrom", parentSessionId: "parent", forkSeq: 5 });
  });
});

describe("fork plan over normal append APIs (M2)", () => {
  it("appends the copied prefix FIRST, then the forkedFrom marker LAST", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: PARENT,
      forkSeq: 5,
      childSessionId: "child",
    });
    expect(plan.childSessionId).toBe("child");
    expect(plan.copied).toBe(4); // seq 1,2,4,5 forkable
    // The last event is the lineage marker; everything before it is the copied prefix.
    const types = plan.events.map((e) => e.type);
    expect(types[types.length - 1]).toBe("session.forkedFrom");
    expect(types.slice(0, -1)).toEqual([
      "user.message",
      "assistant.completed",
      "model.switched",
      "user.message",
    ]);
    // The marker records the parent + fork point and is host-produced.
    const marker = plan.events[plan.events.length - 1];
    expect(marker?.producerId).toBe(PRODUCER_IDS.host);
    expect(marker?.payload).toEqual({ parentSessionId: "parent", forkSeq: 5 });
  });

  it("marks a child fork-ready only once the forkedFrom marker is present", () => {
    const plan = planFork({
      parentSessionId: "parent",
      parentEvents: PARENT,
      forkSeq: 5,
      childSessionId: "child",
    });
    // A partial copy (prefix only, no marker yet) is NOT ready; the full plan IS.
    const partial = plan.events.slice(0, -1).map((e) => ({ type: e.type }));
    expect(isForkReady(partial)).toBe(false);
    expect(isForkReady(plan.events.map((e) => ({ type: e.type })))).toBe(true);
  });
});

describe("active model reconstruction across a fork (M4, D-002)", () => {
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

  it("seeds from the last user.message model when no switch occurred", () => {
    expect(reconstructActiveModel([userMsg(1, "qwen", "low")])).toEqual({
      model: "qwen",
      reasoning: "low",
    });
  });

  it("resumes on the ACTIVE post-switch model, not the pre-switch or a reset default", () => {
    const prefix = [
      userMsg(1, "qwen", "low"),
      switched(2, { model: "opus", reasoning: "high" }, "applied"),
    ];
    expect(reconstructActiveModel(prefix)).toEqual({ model: "opus", reasoning: "high" });
  });

  it("ignores a BLOCKED switch (the active model stays the pre-switch selection)", () => {
    const prefix = [userMsg(1, "qwen", "low"), switched(2, { model: "opus" }, "blocked")];
    expect(reconstructActiveModel(prefix)).toEqual({ model: "qwen", reasoning: "low" });
  });

  it("a later user.message re-establishes the baseline over an earlier switch", () => {
    const prefix = [
      userMsg(1, "qwen"),
      switched(2, { model: "opus" }, "applied"),
      userMsg(3, "deepseek", "medium"),
    ];
    expect(reconstructActiveModel(prefix)).toEqual({ model: "deepseek", reasoning: "medium" });
  });

  it("returns null for a legacy prefix carrying no model information", () => {
    expect(
      reconstructActiveModel([ev(1, "assistant.completed", { runId: "r1", text: "hi" })]),
    ).toBeNull();
  });
});

describe("participant inheritance is opt-in + dedupes by origin (M4)", () => {
  it("the model selection is an inherited stateful participant seeded from the fork point", () => {
    expect(MODEL_SELECTION_INHERITANCE.participant).toBe("model-selection");
    const prefix = [
      ev(1, "user.message", { text: "q", provider: "qwen", reasoning: "low" }),
      ev(2, "model.switched", {
        runId: "r2",
        from: { model: "qwen" },
        to: { model: "opus", reasoning: "high" },
        initiator: "manual",
        outcome: "applied",
      }),
    ];
    expect(MODEL_SELECTION_INHERITANCE.inherit(prefix)).toEqual({
      model: "opus",
      reasoning: "high",
    });
  });

  it("dedupes inherited events by their origin, keeping the first occurrence", () => {
    // Two copies carrying the SAME origin (a re-inherited message) collapse to one.
    const a = ev(10, "user.message", { text: "a", [FORK_ORIGIN_KEY]: { sessionId: "p", seq: 1 } });
    const b = ev(11, "user.message", { text: "b", [FORK_ORIGIN_KEY]: { sessionId: "p", seq: 1 } });
    const c = ev(12, "user.message", { text: "c" }); // native (no origin) - distinct by its own id
    expect(dedupeByOrigin([a, b, c]).map((e) => e.payload.text)).toEqual(["a", "c"]);
  });
});

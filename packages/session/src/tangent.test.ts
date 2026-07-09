import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./event";
import { PRODUCER_IDS } from "./identity";
import { events } from "./protocol";
import { decodeTrevorEvent } from "./protocol-decode";
import { isTangentReady, planTangent, seedTangentPrompt } from "./tangent";

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): SessionEvent {
  return {
    sessionId: "parent",
    seq,
    eventId: `e${seq}`,
    type,
    producerId: "host",
    payload,
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

// A parent with real transcript content the tangent must NEVER copy.
const PARENT: SessionEvent[] = [
  ev(1, "user.message", { text: "explain the blob store" }),
  ev(2, "assistant.completed", { runId: "r1", text: "blobs are content-addressed by sha256" }),
  ev(3, "tool.started", { runId: "r1", callId: "c1", name: "read", arguments: "{}" }),
  ev(4, "tool.completed", {
    runId: "r1",
    callId: "c1",
    name: "read",
    result: "secret parent data",
  }),
  ev(5, "user.message", { text: "and the session log?" }),
];

describe("tangent lineage + fold-back events", () => {
  it("session.tangentOf round-trips through the constructor + decoder", () => {
    const input = events.sessionTangentOf({
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "blobs are content-addressed",
      label: "blob naming",
    });

    expect(input.type).toBe("session.tangentOf");
    expect(decodeTrevorEvent(ev(1, "session.tangentOf", input.payload))).toEqual({
      type: "session.tangentOf",
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "blobs are content-addressed",
      label: "blob naming",
    });
  });

  it("session.tangentOf decodes without an optional label", () => {
    const input = events.sessionTangentOf({
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "snippet",
    });
    const decoded = decodeTrevorEvent(ev(1, "session.tangentOf", input.payload));
    expect(decoded).toEqual({
      type: "session.tangentOf",
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "snippet",
    });
  });

  it("tangent.foldedBack round-trips through the constructor + decoder", () => {
    const input = events.tangentFoldedBack({
      tangentSessionId: "tangent-1",
      parentSessionId: "parent",
      mode: "summary",
      preview: "the tangent concluded X",
    });

    expect(input.type).toBe("tangent.foldedBack");
    expect(decodeTrevorEvent(ev(9, "tangent.foldedBack", input.payload))).toEqual({
      type: "tangent.foldedBack",
      tangentSessionId: "tangent-1",
      parentSessionId: "parent",
      mode: "summary",
      preview: "the tangent concluded X",
    });
  });

  it("tangent.created round-trips as a parent-session wake-up hint", () => {
    const input = events.tangentCreated({
      tangentSessionId: "tangent-1",
      sourceMessageId: "e2",
    });

    expect(input.type).toBe("tangent.created");
    expect(decodeTrevorEvent(ev(10, "tangent.created", input.payload))).toEqual({
      type: "tangent.created",
      tangentSessionId: "tangent-1",
      sourceMessageId: "e2",
    });
    expect(JSON.stringify(input.payload)).not.toContain("blobs are content-addressed");
  });
});

describe("planTangent seeds an ISOLATED tangent (no parent copy)", () => {
  it("appends ONLY the session.tangentOf marker - never a copied parent event", () => {
    const plan = planTangent({
      anchor: {
        parentSessionId: "parent",
        sourceMessageId: "e2",
        quote: "blobs are content-addressed by sha256",
      },
      tangentSessionId: "tangent-1",
    });

    expect(plan.tangentSessionId).toBe("tangent-1");
    expect(plan.parentSessionId).toBe("parent");
    expect(plan.sourceMessageId).toBe("e2");
    // The whole isolation guarantee: exactly one seed event, and it is the marker - unlike a fork,
    // which copies the parent prefix.
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]?.type).toBe("session.tangentOf");
    expect(plan.events[0]?.producerId).toBe(PRODUCER_IDS.web);
    expect(plan.events[0]?.payload).toEqual({
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "blobs are content-addressed by sha256",
    });
    // No parent transcript text and no fork-copy tag leaked into the seed.
    const serialized = JSON.stringify(plan.events);
    expect(serialized).not.toContain("secret parent data");
    expect(serialized).not.toContain("_forkOrigin");
    for (const parentEvent of PARENT) {
      expect(
        plan.events.some((e) => e.type === parentEvent.type && e.type !== "session.tangentOf"),
      ).toBe(false);
    }
  });

  it("carries an optional label onto the marker", () => {
    const plan = planTangent({
      anchor: { parentSessionId: "p", sourceMessageId: "e1", quote: "q", label: "why sha256?" },
      tangentSessionId: "t",
    });
    expect(plan.events[0]?.payload.label).toBe("why sha256?");
  });

  it("isTangentReady is true only once the marker is present", () => {
    const plan = planTangent({
      anchor: { parentSessionId: "p", sourceMessageId: "e1", quote: "q" },
      tangentSessionId: "t",
    });
    expect(isTangentReady([])).toBe(false);
    expect(isTangentReady(plan.events)).toBe(true);
  });
});

describe("seedTangentPrompt folds the selection into the first prompt", () => {
  it("quotes the snapshot above the user's first question, one message", () => {
    expect(seedTangentPrompt("blobs are content-addressed", "why sha256 and not a uuid?")).toBe(
      "> blobs are content-addressed\n\nwhy sha256 and not a uuid?",
    );
  });

  it("keeps a multi-line quote as one contiguous blockquote", () => {
    expect(seedTangentPrompt("line one\n\nline two", "expand")).toBe(
      "> line one\n>\n> line two\n\nexpand",
    );
  });

  it("stands the quote alone when there is no question yet", () => {
    expect(seedTangentPrompt("just the snapshot", "")).toBe("> just the snapshot");
  });

  it("returns just the question when there is no quote", () => {
    expect(seedTangentPrompt("   ", "a bare question")).toBe("a bare question");
  });
});

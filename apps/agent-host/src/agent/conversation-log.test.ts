import { events, type SessionEvent, type TrevorEventInput } from "@trevor/session";
import { describe, expect, test } from "vitest";
import { ConversationLog } from "./conversation-log";
import { buildHistory } from "./history-projection";

const SELF = "trevor-host";

function ev(event: TrevorEventInput, seq: number, producerId = "trevor-web") {
  return {
    ...event,
    createdAt: `t${seq}`,
    eventId: `e${seq}`,
    producerId,
    seq,
    sessionId: "s",
  } satisfies SessionEvent;
}

describe("ConversationLog", () => {
  test("keeps admitted history paired with its durable events", () => {
    const log = new ConversationLog({ selfProducerId: SELF });
    const first = ev(events.userMessage({ text: "first", provider: "qwen" }), 1);
    const second = ev(events.userMessage({ text: "after clear", provider: "qwen" }), 2);

    log.admit(first);
    expect(log.history()).toEqual(buildHistory(log.events(), { selfProducerId: SELF }));

    log.admit(second);
    expect(log.history()).toEqual(buildHistory(log.events(), { selfProducerId: SELF }));
    expect(log.debugInfo()).toEqual({ eventCount: 2, historyLength: 1, lastSeq: 2 });
  });

  test("records delayed events without rebuilding until the next admit", () => {
    const log = new ConversationLog({ selfProducerId: SELF });
    const first = ev(events.userMessage({ text: "first", provider: "qwen" }), 1);
    const delayed = ev(
      events.assistantCompleted({
        runId: "r1",
        text: "delayed answer",
      }),
      2,
      SELF,
    );
    const next = ev(events.userMessage({ text: "next", provider: "qwen" }), 3);

    log.admit(first);
    log.record(delayed);

    expect(log.events()).toHaveLength(2);
    expect(log.history().map((message) => message.content)).toEqual(["first"]);

    log.admit(next);
    expect(log.history()).toEqual(buildHistory(log.events(), { selfProducerId: SELF }));
    expect(log.history().map((message) => message.content)).toEqual([
      "first",
      "delayed answer",
      "next",
    ]);
  });

  test("labels the session from the first user message", () => {
    const log = new ConversationLog({ selfProducerId: SELF });

    expect(log.label("fallback")).toBe("fallback");
    log.admit(ev(events.userMessage({ text: "  first   prompt  ", provider: "qwen" }), 1));

    expect(log.label("fallback")).toBe("first prompt");
  });

  test("snapshots are owned copies", () => {
    const log = new ConversationLog({ selfProducerId: SELF });
    log.admit(ev(events.userMessage({ text: "first", provider: "qwen" }), 1));

    const history = log.historySnapshot();
    const durableEvents = log.eventsSnapshot();

    history.length = 0;
    durableEvents.length = 0;

    expect(log.history()).toHaveLength(1);
    expect(log.events()).toHaveLength(1);
  });
});

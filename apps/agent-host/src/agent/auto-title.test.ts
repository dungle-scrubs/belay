import assert from "node:assert/strict";
import {
  events,
  PRODUCER_IDS,
  type ProducerId,
  type SessionEvent,
  type TrevorEventInput,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderEvent } from "../providers";
import {
  autoTitleEvent,
  buildTitlePrompt,
  distillTitle,
  needsAutoTitle,
  sanitizeTitle,
} from "./auto-title";

/**
 * Session auto-titling (plan 58.6.4 A13). The gate (needsAutoTitle) is pure over a synthetic log:
 * fire once on the first real assistant turn, only when no manual rename exists, and yield to a
 * rename past or future. The emit decision (autoTitleEvent) and the tool-less job (distillTitle over
 * a fake provider) pin the failed/empty-title behavior.
 */

const SELF: ProducerId = PRODUCER_IDS.host;
const WEB: ProducerId = PRODUCER_IDS.web;

let seq = 0;
const ev = (input: TrevorEventInput, producerId: ProducerId = WEB): SessionEvent =>
  storedEvent(input, { seq: seq++, producerId });

/** A completed turn: a user prompt + the assistant's reply (host-authored), as two log events. */
function turn(userText: string, assistantText: string): [SessionEvent, SessionEvent] {
  return [
    ev(events.userMessage({ text: userText, provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r", text: assistantText }), SELF),
  ];
}

test("needsAutoTitle fires exactly once on the first real assistant turn", () => {
  assert.equal(needsAutoTitle([]), false, "no turns yet");
  assert.equal(needsAutoTitle([...turn("hi", "hello there")]), true, "first completed turn");
});

test("needsAutoTitle does not fire once a manual rename exists (rename wins, latest-wins)", () => {
  const rename = ev(events.sessionTitle({ title: "My Own Name" }));
  // A rename already present blocks the auto-title even on the first turn...
  assert.equal(
    needsAutoTitle([...turn("hi", "hello"), rename]),
    false,
    "rename before/with the turn",
  );
  // ...and a later rename (after the first turn) still blocks a re-title.
  assert.equal(needsAutoTitle([...turn("hi", "hello"), rename]), false, "rename after the turn");
});

test("needsAutoTitle does not fire on the second completed turn", () => {
  const log = [...turn("one", "first reply"), ...turn("two", "second reply")];
  assert.equal(needsAutoTitle(log), false, "two completed turns → not the first turn anymore");
});

test("needsAutoTitle ignores a blank/errored first completion", () => {
  const blank = [...turn("hi", "   ")];
  assert.equal(needsAutoTitle(blank), false, "an empty completion is not a real first turn");
  const real = [...blank, ...turn("again", "a real answer")];
  assert.equal(needsAutoTitle(real), true, "the first NON-empty completion is the first turn");
});

test("sanitizeTitle strips quotes, trailing punctuation, and collapses whitespace", () => {
  assert.equal(sanitizeTitle('"Parser Bug Fix."'), "Parser Bug Fix");
  assert.equal(sanitizeTitle("  Debugging   the   loop  "), "Debugging the loop");
  assert.equal(sanitizeTitle("First line title\nsecond line ignored"), "First line title");
  assert.equal(sanitizeTitle("   "), "", "whitespace-only → empty");
  assert.equal(sanitizeTitle(""), "", "empty → empty");
});

test("autoTitleEvent emits a session.title for a real title and nothing for an empty one", () => {
  const good = autoTitleEvent('"Fix The Compaction Gate"');
  assert.ok(good, "a real title yields an event");
  assert.equal(good?.type, "session.title");
  assert.equal(good?.payload.title, "Fix The Compaction Gate");
  assert.equal(autoTitleEvent("   "), null, "an empty/garbled title emits nothing");
  assert.equal(autoTitleEvent(""), null, "an empty title emits nothing");
});

test("buildTitlePrompt renders the transcript as a single tool-less user message", () => {
  const prompt = buildTitlePrompt([
    { role: "user", content: "build the parser" },
    { role: "assistant", content: "done the lexer" },
  ]);
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0]?.role, "user");
  assert.match(prompt[0]?.content ?? "", /build the parser/);
  assert.match(prompt[0]?.content ?? "", /done the lexer/);
});

function fakeProvider(titleText: string): Provider {
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off", "low"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: ["off", "low"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: () => Stream.fromIterable<ProviderEvent>([{ type: "text", text: titleText }]),
  };
}

test("distillTitle streams a title the emit decision then accepts", async () => {
  const raw = await Effect.runPromise(
    distillTitle(fakeProvider("Fix The Parser"), [
      { role: "user", content: "the parser is broken" },
      { role: "assistant", content: "fixed the off-by-one" },
    ]),
  );
  const event = autoTitleEvent(raw);
  assert.ok(event, "a streamed title yields an event");
  assert.equal(event?.payload.title, "Fix The Parser");
});

test("a whitespace-only model title emits nothing (failed/empty job)", async () => {
  const raw = await Effect.runPromise(
    distillTitle(fakeProvider("   \n  "), [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]),
  );
  assert.equal(autoTitleEvent(raw), null, "an empty title leaves the derived title untouched");
});

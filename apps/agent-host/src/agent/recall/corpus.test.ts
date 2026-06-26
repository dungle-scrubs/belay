import assert from "node:assert/strict";
import { events, type SessionEvent, type TrevorEventInput } from "@trevor/session";
import { test } from "vitest";
import { assembleCorpus, buildRecords } from "./corpus";
import type { RecallSessionRef } from "./types";

/**
 * D-044 M1: the recallable corpus model + the active-prompt exclusion. buildRecords is pure
 * over decoded events; assembleCorpus adds the load-bearing rule that the current session
 * contributes only its compacted-away detail (never the active-prompt tail or the fold
 * summary), while siblings contribute in full.
 */

const SELF = "trevor-host";
const WEB = "trevor-web";

function ev(
  input: TrevorEventInput,
  opts: { seq: number; producerId?: string; sessionId?: string },
): SessionEvent {
  return {
    createdAt: `2026-01-01T00:00:${String(opts.seq % 60).padStart(2, "0")}.000Z`,
    eventId: `e${opts.seq}`,
    payload: input.payload,
    producerId: opts.producerId ?? WEB,
    seq: opts.seq,
    sessionId: opts.sessionId ?? "s",
    type: input.type,
  };
}

const REF: RecallSessionRef = {
  sessionId: "s",
  label: "a session",
  project: "trevorV2",
  origin: "sibling-session",
};

test("buildRecords projects user/assistant/tool/fold events and drops lifecycle noise", () => {
  const log = [
    ev(events.userMessage({ text: "how does compaction work", provider: "qwen" }), { seq: 0 }),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "qwen", provider: "qwen" }), {
      seq: 1,
      producerId: SELF,
    }),
    ev(events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: "{}" }), {
      seq: 2,
      producerId: SELF,
    }),
    ev(events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "file body" }), {
      seq: 3,
      producerId: SELF,
    }),
    ev(events.assistantCompleted({ runId: "r1", text: "it folds older turns" }), {
      seq: 4,
      producerId: SELF,
    }),
  ];

  const records = buildRecords(log, REF);
  assert.deepEqual(
    records.map((r) => r.kind),
    ["user", "tool", "assistant"],
    "started/lifecycle events make no record",
  );

  const [userRec, toolRec, asstRec] = records;
  assert.ok(userRec);
  assert.ok(toolRec);
  assert.ok(asstRec);
  assert.equal(userRec.text, "how does compaction work");
  assert.equal(toolRec.tool, "read", "a tool record carries its tool name");
  assert.equal(toolRec.text, "read: file body");
  assert.equal(asstRec.runId, "r1", "an assistant record carries its run id");
  assert.equal(userRec.id, "s#0", "record id is sessionId#seq");
});

test("buildRecords skips a cancelled/blank assistant reply", () => {
  const log = [
    ev(events.userMessage({ text: "stop", provider: "qwen" }), { seq: 0 }),
    ev(events.assistantCompleted({ runId: "r1", text: "", cancelled: true }), {
      seq: 1,
      producerId: SELF,
    }),
  ];

  assert.deepEqual(
    buildRecords(log, REF).map((r) => r.kind),
    ["user"],
    "a cancelled empty reply is not recallable",
  );
});

test("buildRecords carries a fold's manifest turn range and fold id", () => {
  const log = [
    ev(
      events.contextCompacted({
        foldId: "f1",
        throughSeq: 12,
        summary: "earlier we set up the BM25 index",
        manifest: { turnRange: { fromSeq: 3, toSeq: 12 }, files: [], tools: [], topics: [] },
        tokensBefore: 9000,
        tokensAfter: 4000,
        model: "qwen",
      }),
      { seq: 13, producerId: SELF },
    ),
  ];

  const [fold] = buildRecords(log, REF);
  assert.ok(fold);
  assert.equal(fold.kind, "fold");
  assert.equal(fold.foldId, "f1");
  assert.deepEqual(fold.range, { fromSeq: 3, toSeq: 12 }, "a fold spans its manifest turn range");
});

test("assembleCorpus excludes the current session's active-prompt tail and fold summaries", () => {
  // Current session: turns 0..1 folded away (throughSeq=5), the seq-6 turn still in the prompt.
  const currentLog = [
    ev(events.userMessage({ text: "folded question", provider: "qwen" }), {
      seq: 0,
      sessionId: "cur",
    }),
    ev(events.assistantCompleted({ runId: "r1", text: "folded answer" }), {
      seq: 1,
      producerId: SELF,
      sessionId: "cur",
    }),
    ev(
      events.contextCompacted({
        foldId: "f1",
        throughSeq: 5,
        summary: "summary that already rides in the prompt",
        manifest: { turnRange: { fromSeq: 0, toSeq: 1 }, files: [], tools: [], topics: [] },
        tokensBefore: 9000,
        tokensAfter: 4000,
        model: "qwen",
      }),
      { seq: 2, producerId: SELF, sessionId: "cur" },
    ),
    ev(events.userMessage({ text: "recent prompt", provider: "qwen" }), {
      seq: 6,
      sessionId: "cur",
    }),
  ];

  const corpus = assembleCorpus([
    {
      session: {
        sessionId: "cur",
        label: "current",
        project: "trevorV2",
        origin: "current-compacted",
      },
      events: currentLog,
      currentFoldThroughSeq: 5,
    },
  ]);

  const texts = corpus.map((r) => r.text);
  assert.ok(texts.includes("folded question"), "compacted-away detail is recallable");
  assert.ok(texts.includes("folded answer"), "compacted-away reply is recallable");
  assert.ok(!texts.includes("recent prompt"), "active-prompt tail (seq > throughSeq) is excluded");
  assert.ok(
    !texts.includes("summary that already rides in the prompt"),
    "the fold summary is in the active prompt, not recallable",
  );
});

test("assembleCorpus yields nothing for a current session with no fold", () => {
  const log = [ev(events.userMessage({ text: "hi", provider: "qwen" }), { seq: 0 })];

  const corpus = assembleCorpus([
    {
      session: { sessionId: "cur", label: "current", project: "p", origin: "current-compacted" },
      events: log,
      currentFoldThroughSeq: null,
    },
  ]);

  assert.equal(corpus.length, 0, "with nothing compacted away, the active prompt holds it all");
});

test("assembleCorpus includes sibling sessions in full", () => {
  const log = [
    ev(events.userMessage({ text: "sibling question", provider: "qwen" }), { seq: 0 }),
    ev(events.assistantCompleted({ runId: "r1", text: "sibling answer" }), {
      seq: 1,
      producerId: SELF,
    }),
  ];

  const corpus = assembleCorpus([
    {
      session: { sessionId: "sib", label: "sibling", project: "p", origin: "sibling-session" },
      events: log,
    },
  ]);

  assert.equal(corpus.length, 2, "a sibling contributes its whole recallable log");
  const [first] = corpus;
  assert.ok(first);
  assert.equal(first.session.origin, "sibling-session");
});

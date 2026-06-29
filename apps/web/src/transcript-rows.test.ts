import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type Message, readOnlyToolBatches } from "./transcript";
import { buildTranscriptRows, type ToolBatchLookup, transcriptRowKey } from "./transcript-rows";

const user = (id: string, text = id): Message => ({
  kind: "user",
  id,
  text,
  artifacts: [],
});

const assistant = (id: string, text = id): Message => ({
  kind: "assistant",
  id,
  runId: id,
  text,
  thinking: "",
  done: true,
  warm: true,
  model: "qwen",
});

const tool = (id: string, name = "read"): Message => ({
  kind: "tool",
  id,
  name,
  args: `{"path":"${id}"}`,
  done: true,
  result: `result ${id}`,
});

function rows(transcript: readonly Message[], over: Partial<ToolBatchLookup> = {}) {
  return buildTranscriptRows({
    active: null,
    awaitingResponse: false,
    toolBatches: { ...readOnlyToolBatches(transcript), ...over },
    transcript,
    turnStartedAt: null,
  });
}

describe("buildTranscriptRows", () => {
  test("returns only renderable rows with stable keys", () => {
    const result = rows([user("u1"), assistant("a1")]);

    assert.deepEqual(
      result.map((row) => row.kind),
      ["message", "message"],
    );
    assert.deepEqual(result.map(transcriptRowKey), ["message:u1", "message:a1"]);
  });

  test("a resolved-question message is a real transcript row with a stable key (02.7)", () => {
    const question: Message = {
      kind: "question",
      id: "q-evt",
      questionId: "q1",
      runId: "r1",
      outcome: "answered",
      items: [{ id: "q1a", question: "Which?", answer: "This" }],
      summary: "This",
    };
    const result = rows([user("u1"), question, assistant("a1")]);
    assert.deepEqual(
      result.map((row) => row.kind),
      ["message", "message", "message"],
    );
    assert.deepEqual(result.map(transcriptRowKey), ["message:u1", "message:q-evt", "message:a1"]);
  });

  test("collapses consecutive read-only tools into one batch row and omits continuations", () => {
    const result = rows([user("u1"), tool("t1"), tool("t2"), tool("t3"), assistant("a1")]);

    assert.deepEqual(
      result.map((row) => row.kind),
      ["message", "tool_batch", "message"],
    );
    const batch = result[1];
    assert.equal(batch?.kind, "tool_batch");
    assert.deepEqual(batch?.kind === "tool_batch" ? batch.tools.map((t) => t.id) : [], [
      "t1",
      "t2",
      "t3",
    ]);
    assert.ok(!result.some((row) => row.id.includes("t2")), "continuation rows are omitted");
  });

  test("keeps mutating tools as ordinary message rows between read-only runs", () => {
    const result = rows([tool("r1"), tool("w1", "write"), tool("r2")]);

    assert.deepEqual(
      result.map((row) => row.kind),
      ["message", "message", "message"],
    );
    assert.deepEqual(result.map(transcriptRowKey), ["message:r1", "message:w1", "message:r2"]);
  });

  test("appends working rows at the live edge", () => {
    const transcript = [user("u1"), assistant("a1")];
    const result = buildTranscriptRows({
      active: "run-1",
      awaitingResponse: false,
      toolBatches: readOnlyToolBatches(transcript),
      transcript,
      turnStartedAt: 123,
    });

    assert.deepEqual(
      result.map((row) => row.kind),
      ["message", "message", "working"],
    );
    assert.equal(result[2]?.kind === "working" ? result[2].startedAt : null, 123);
  });
});

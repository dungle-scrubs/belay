import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type Message, readOnlyToolBatches } from "./transcript";
import { buildTranscriptRows, type ToolBatchLookup, transcriptRowKey } from "./transcript-rows";

const user = (id: string, text = id): Message => ({
  kind: "user",
  id,
  text,
  artifacts: [],
  pastes: [],
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
    toolBatches: { ...readOnlyToolBatches(transcript), ...over },
    transcript,
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

  test("appends a trailing working row carrying its metrics only when working data is set", () => {
    // A plain active turn (no task, no delegation) appends the inline "working…" row as the last item,
    // carrying its live metrics; task/delegation turns omit `working` and pin the TurnStatusHeader.
    const transcript = [user("u1"), assistant("a1")];
    const toolBatches = readOnlyToolBatches(transcript);

    const idle = buildTranscriptRows({ toolBatches, transcript });
    assert.deepEqual(
      idle.map((row) => row.kind),
      ["message", "message"],
      "no working row without the data",
    );

    const working = buildTranscriptRows({
      toolBatches,
      transcript,
      working: { startedAt: 1000, outputTokens: 340 },
    });
    assert.deepEqual(
      working.map((row) => row.kind),
      ["message", "message", "working"],
      "the working row trails the last message",
    );
    const workingRow = working[2];
    assert.equal(workingRow?.kind, "working");
    assert.equal(transcriptRowKey(workingRow as never), "working");
    assert.equal(workingRow?.kind === "working" ? workingRow.startedAt : null, 1000);
    assert.equal(workingRow?.kind === "working" ? workingRow.outputTokens : null, 340);
  });
});

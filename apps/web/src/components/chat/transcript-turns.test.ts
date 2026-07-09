import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { Message, ToolMessage } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
import {
  buildTranscriptTurns,
  estimateTranscriptTurnSize,
  transcriptTurnKey,
} from "./transcript-turns";

function messageRow(message: Message): TranscriptRow {
  return { kind: "message", id: `message:${message.id}`, message, compactAbove: false };
}

function userRow(id: string): TranscriptRow {
  return messageRow({ kind: "user", id, text: `prompt ${id}`, artifacts: [], pastes: [] });
}

function assistantRow(id: string): TranscriptRow {
  return messageRow({
    kind: "assistant",
    id,
    runId: "r1",
    text: "answer",
    thinking: "",
    done: true,
    warm: false,
    model: "glm",
  });
}

function toolRow(id: string, name = "bash"): TranscriptRow {
  const message: ToolMessage = {
    kind: "tool",
    id,
    name,
    args: "{}",
    done: true,
    result: "ok",
  };
  return messageRow(message);
}

describe("transcript turns", () => {
  test("groups each user row with following assistant and tool rows until the next user row", () => {
    const rows = [
      userRow("u1"),
      assistantRow("a1"),
      toolRow("t1"),
      messageRow({ kind: "shell", id: "s1", requestId: "r", command: "pnpm test", done: false }),
      messageRow({ kind: "result", id: "r1", command: "doctor", text: "ok", ok: true }),
      messageRow({
        kind: "recovered",
        id: "rec1",
        action: "trimmed",
        detail: "retry",
        reclaimed: 100,
      }),
      userRow("u2"),
      assistantRow("a2"),
    ];

    const turns = buildTranscriptTurns(rows);

    assert.deepEqual(
      turns.map((turn) => turn.rows.map((row) => row.id)),
      [
        ["message:u1", "message:a1", "message:t1", "message:s1", "message:r1", "message:rec1"],
        ["message:u2", "message:a2"],
      ],
    );
    assert.deepEqual(
      turns.map((turn) => turn.startIndex),
      [0, 6],
    );
  });

  test("handles empty transcripts and preface rows before the first user row", () => {
    assert.deepEqual(buildTranscriptTurns([]), []);

    const rows = [assistantRow("a-preface"), toolRow("t-preface"), userRow("u1")];
    const turns = buildTranscriptTurns(rows);

    assert.deepEqual(
      turns.map((turn) => turn.rows.map((row) => row.id)),
      [["message:a-preface", "message:t-preface"], ["message:u1"]],
    );
    assert.equal(
      transcriptTurnKey(turns[0] as (typeof turns)[number]),
      "turn:preface:message:a-preface",
    );
    assert.equal(transcriptTurnKey(turns[1] as (typeof turns)[number]), "turn:message:u1");
  });

  test("keeps read-only tool batches inside the surrounding turn", () => {
    const rows: TranscriptRow[] = [
      userRow("u1"),
      {
        kind: "tool_batch",
        id: "tool-batch:t1",
        compactAbove: false,
        tools: [
          { kind: "tool", id: "t1", name: "read", args: "{}", done: true },
          { kind: "tool", id: "t2", name: "glob", args: "{}", done: true },
        ],
      },
      assistantRow("a1"),
    ];

    const [turn] = buildTranscriptTurns(rows);

    assert.deepEqual(
      turn?.rows.map((row) => row.id),
      ["message:u1", "tool-batch:t1", "message:a1"],
    );
  });

  test("estimates compact expanded rows and compact gaps at global row indexes", () => {
    const rows = [userRow("u1"), toolRow("t1"), toolRow("t2"), assistantRow("a1")];
    const [turn] = buildTranscriptTurns(rows);
    const collapsed = estimateTranscriptTurnSize(turn, true, new Set(), [false, true, false, true]);
    const expanded = estimateTranscriptTurnSize(turn, true, new Set(["t1"]), [
      false,
      true,
      false,
      true,
    ]);

    assert.equal(collapsed, 72 + 20 + 28 + 28 + 20 + 75);
    assert.equal(expanded, 72 + 20 + 144 + 28 + 20 + 75);
  });
});

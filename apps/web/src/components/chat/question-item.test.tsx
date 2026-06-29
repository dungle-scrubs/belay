import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import type { QuestionMessage } from "@/transcript";
import { QuestionTranscriptItem } from "./question-item";

/**
 * The slim resolved-question transcript item (02.7): renders what Trevor asked and how the user
 * answered, compact by default and as a single line when `oneLine`. Runs in the jsdom `web` project.
 */

const msg = (over: Partial<QuestionMessage> = {}): QuestionMessage => ({
  kind: "question",
  id: "evt-1",
  questionId: "q1",
  runId: "r1",
  outcome: "answered",
  items: [{ id: "db", question: "Which database?", answer: "Postgres" }],
  summary: "Postgres",
  ...over,
});

test("renders the question, the answer, and the outcome in slim mode", () => {
  render(<QuestionTranscriptItem message={msg()} />);
  assert.ok(screen.getByText("Which database?"));
  assert.ok(screen.getByText("→ Postgres"));
  assert.ok(screen.getByText("answered"));
});

test("renders each question/answer pair for a grouped question", () => {
  render(
    <QuestionTranscriptItem
      message={msg({
        items: [
          { id: "db", question: "Database?", answer: "Postgres" },
          { id: "orm", question: "ORM?", answer: "Drizzle" },
        ],
      })}
    />,
  );
  assert.ok(screen.getByText("Database?"));
  assert.ok(screen.getByText("→ Postgres"));
  assert.ok(screen.getByText("ORM?"));
  assert.ok(screen.getByText("→ Drizzle"));
});

test("a declined outcome with no answer still shows the question and the outcome", () => {
  render(
    <QuestionTranscriptItem
      message={msg({
        outcome: "declined",
        items: [{ id: "x", question: "Proceed?", answer: "" }],
        summary: "Declined",
      })}
    />,
  );
  assert.ok(screen.getByText("Proceed?"));
  assert.ok(screen.getByText("declined"));
});

test("falls back to the summary when there are no contract items", () => {
  render(<QuestionTranscriptItem message={msg({ items: [], summary: "User cancelled" })} />);
  assert.ok(screen.getByText("User cancelled"));
});

test("oneLine mode compresses to a single row with full text in the title", () => {
  const { container } = render(
    <QuestionTranscriptItem
      message={msg({
        items: [
          { id: "db", question: "Database?", answer: "Postgres" },
          { id: "orm", question: "ORM?", answer: "Drizzle" },
        ],
      })}
      oneLine
    />,
  );
  const row = container.querySelector(".aui-question-item");
  assert.ok(row);
  // The single row shows the first pair and a "+N more" affordance.
  assert.match(row.textContent ?? "", /Database\?\s*→\s*Postgres/);
  assert.match(row.textContent ?? "", /\+1 more/);
  // Full text is exposed through the title for the truncated content.
  assert.match(row.getAttribute("title") ?? "", /Database\? → Postgres · ORM\? → Drizzle/);
});

test("long answer text truncates in oneLine mode", () => {
  const longAnswer = "x".repeat(200);
  const { container } = render(
    <QuestionTranscriptItem
      message={msg({ items: [{ id: "q", question: "Q?", answer: longAnswer }] })}
      oneLine
    />,
  );
  const row = container.querySelector(".aui-question-item");
  assert.ok(row);
  assert.ok((row.textContent ?? "").includes("…"), "truncated with an ellipsis");
});

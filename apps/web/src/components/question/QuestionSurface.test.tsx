import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  ProviderQuestionAccept,
  ProviderQuestionAnswer,
  ProviderQuestionContract,
} from "@trevor/session";
import { test, vi } from "vitest";
import * as fx from "./fixtures";
import { QuestionSurface } from "./QuestionSurface";

/**
 * The presentational QuestionSurface, under jsdom. It renders a contract and emits the wire answer;
 * these tests drive it the way a user would (click / type / keyboard) and assert the emitted payload
 * and the submit-gating, which is the contract the live wiring (Phase 3) depends on.
 */

function renderSurface(
  contract: ProviderQuestionContract,
  props: Partial<{ expired: boolean }> = {},
) {
  const onAnswer = vi.fn<(a: ProviderQuestionAnswer) => void>();
  render(<QuestionSurface contract={contract} onAnswer={onAnswer} expired={props.expired} />);
  return { onAnswer };
}

const lastAccept = (onAnswer: {
  mock: { calls: [ProviderQuestionAnswer][] };
}): ProviderQuestionAccept => {
  const arg = onAnswer.mock.calls.at(-1)?.[0];
  assert.ok(arg && arg.action === "accept", "expected an accept answer");
  return arg;
};

test("single-choice: starts on the recommended option and is ready to submit", () => {
  const { onAnswer } = renderSurface(fx.singleChoice);
  assert.ok(screen.getByText("Which database should the new service use?"));
  // PostgreSQL is recommended, so it begins selected and the surface is one click from done.
  assert.equal(
    screen.getByRole("radio", { name: /PostgreSQL/ }).getAttribute("aria-checked"),
    "true",
  );
  const submit = screen.getByRole("button", { name: /submit answer/i });
  assert.equal((submit as HTMLButtonElement).disabled, false);
  fireEvent.click(submit);
  assert.deepEqual(lastAccept(onAnswer).questions[0]?.selected, [
    { id: "postgres", label: "PostgreSQL" },
  ]);
});

test("single-choice: with no recommended option, starts unselected and gates submit", () => {
  const noRec = fx.contract([
    fx.question({
      id: "pick",
      question: "Pick one",
      answerShape: "single_choice",
      choices: [
        fx.choice({ id: "a", label: "Option A" }),
        fx.choice({ id: "b", label: "Option B" }),
      ],
    }),
  ]);
  const { onAnswer } = renderSurface(noRec);
  const submit = screen.getByRole("button", { name: /submit answer/i });
  assert.equal((submit as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("radio", { name: /Option B/ }));
  assert.equal((submit as HTMLButtonElement).disabled, false);
  fireEvent.click(submit);
  assert.deepEqual(lastAccept(onAnswer).questions[0]?.selected, [{ id: "b", label: "Option B" }]);
});

test("single-choice: arrow keys move the selection (ARIA radio pattern)", () => {
  renderSurface(fx.singleChoice);
  const first = screen.getByRole("radio", { name: /PostgreSQL/ });
  fireEvent.keyDown(first, { key: "ArrowDown" });
  assert.equal(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked"), "true");
});

test("single-choice: arrowing past the last choice lands on the custom-answer row", () => {
  const { onAnswer } = renderSurface(fx.singleChoice);
  // PostgreSQL(0) -> SQLite(1) -> MySQL(2) -> custom row. Arrow down from the last choice.
  fireEvent.keyDown(screen.getByRole("radio", { name: /MySQL/ }), { key: "ArrowDown" });
  const custom = screen.getByLabelText(/custom answer for/i);
  assert.equal(document.activeElement, custom);
  fireEvent.change(custom, { target: { value: "DuckDB" } });
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));
  assert.equal(lastAccept(onAnswer).questions[0]?.text, "DuckDB");
});

test("multi-select: picks several choices and submits all of them", () => {
  const { onAnswer } = renderSurface(fx.multiSelect);
  fireEvent.click(screen.getByRole("checkbox", { name: /macOS/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Linux/ }));
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));

  const answer = lastAccept(onAnswer);
  assert.deepEqual(answer.questions[0]?.selected, [
    { id: "macos", label: "macOS" },
    { id: "linux", label: "Linux" },
  ]);
});

test("custom answer: typing your own completes a single-choice question", () => {
  const { onAnswer } = renderSurface(fx.singleChoice);
  const custom = screen.getByLabelText(/custom answer for/i);
  fireEvent.change(custom, { target: { value: "CockroachDB" } });
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));

  const answer = lastAccept(onAnswer);
  assert.equal(answer.questions[0]?.text, "CockroachDB");
  assert.equal(answer.questions[0]?.selected, undefined);
});

test("free text: the answer is the typed text", () => {
  const { onAnswer } = renderSurface(fx.freeText);
  const box = screen.getByLabelText("What should we name the new package?");
  fireEvent.change(box, { target: { value: "trevor-kit" } });
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));

  assert.equal(lastAccept(onAnswer).questions[0]?.text, "trevor-kit");
});

test("required reason: submit stays disabled until a reason is entered", () => {
  renderSurface(fx.requiredReason);
  // "Incremental" is recommended → already selected; submit is still gated on the required reason.
  const submit = screen.getByRole("button", { name: /submit answer/i });
  assert.equal((submit as HTMLButtonElement).disabled, true);

  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "lower blast radius" } });
  assert.equal((submit as HTMLButtonElement).disabled, false);
});

test("notes: revealing and typing a note attaches it to the answer", () => {
  const { onAnswer } = renderSurface(fx.singleChoice);
  fireEvent.click(screen.getByRole("button", { name: /add a/i }));
  fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: "prefer managed infra" } });
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));

  assert.equal(lastAccept(onAnswer).questions[0]?.notes, "prefer managed infra");
});

test("notes: 'n' opens a note; Escape collapses it but keeps the text for next time", () => {
  renderSurface(fx.singleChoice);
  assert.equal(screen.queryByLabelText(/notes/i), null);
  // "n" on a non-input element (the radio) reveals + focuses the note.
  fireEvent.keyDown(screen.getByRole("radio", { name: /PostgreSQL/ }), { key: "n" });
  const note = screen.getByLabelText(/notes/i);
  fireEvent.change(note, { target: { value: "draft note" } });
  // Escape collapses it even with text entered.
  fireEvent.keyDown(note, { key: "Escape" });
  assert.equal(screen.queryByLabelText(/notes/i), null);
  // Reopening with "n" restores the saved text, caret at the end so the user keeps typing.
  fireEvent.keyDown(screen.getByRole("radio", { name: /PostgreSQL/ }), { key: "n" });
  const reopened = screen.getByLabelText(/notes/i) as HTMLTextAreaElement;
  assert.equal(reopened.value, "draft note");
  assert.equal(reopened.selectionStart, "draft note".length);
});

test("defer: skipping a deferrable question completes it as deferred", () => {
  const { onAnswer } = renderSurface(fx.deferrable);
  fireEvent.click(screen.getByRole("button", { name: /skip this for now/i }));
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));

  assert.equal(lastAccept(onAnswer).questions[0]?.defer, true);
});

test("decline emits a decline answer without building a payload", () => {
  const { onAnswer } = renderSurface(fx.singleChoice);
  fireEvent.click(screen.getByRole("button", { name: /decline/i }));
  assert.deepEqual(onAnswer.mock.calls.at(-1)?.[0], { action: "decline" });
});

test("Cmd/Ctrl+Enter submits when the draft is ready", () => {
  const { onAnswer } = renderSurface(fx.singleChoice); // recommended pre-selected → ready
  fireEvent.keyDown(screen.getByRole("region", { name: /question from trevor/i }), {
    key: "Enter",
    metaKey: true,
  });
  assert.equal(onAnswer.mock.calls.length, 1);
  assert.equal(lastAccept(onAnswer).action, "accept");
});

test("expired: every control is disabled and nothing can be submitted", () => {
  const { onAnswer } = renderSurface(fx.singleChoice, { expired: true });
  assert.ok(screen.getByText(/this question expired/i));
  assert.equal(
    (screen.getByRole("radio", { name: /PostgreSQL/ }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole("button", { name: /submit answer/i }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(screen.getByRole("radio", { name: /PostgreSQL/ }));
  assert.equal(onAnswer.mock.calls.length, 0);
});

test("grouped: a multi-question ask submits one answer entry per question", () => {
  const { onAnswer } = renderSurface(fx.grouped);
  // scope's "Minimal slice" is recommended (pre-selected); answer the remaining two.
  fireEvent.click(screen.getByRole("checkbox", { name: /Unit tests/ }));
  fireEvent.change(screen.getByLabelText("Anything else the reviewer should know?"), {
    target: { value: "ship behind a flag" },
  });
  fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));

  const answer = lastAccept(onAnswer);
  assert.deepEqual(
    answer.questions.map((a) => a.id),
    ["scope", "checks", "notes"],
  );
});

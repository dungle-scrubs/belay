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

// --- focus restoration on window/tab return (02.9) ---

const windowFocus = () => fireEvent(window, new Event("focus"));

test("restores focus to the active choice row when the window regains focus (D-001)", () => {
  renderSurface(fx.singleChoice);
  // Mount focuses the selected (recommended) row; simulate a tab switch dropping focus to the body.
  (document.activeElement as HTMLElement | null)?.blur();
  assert.notEqual(document.activeElement, screen.getByRole("radio", { name: /PostgreSQL/ }));

  windowFocus();
  assert.equal(
    document.activeElement,
    screen.getByRole("radio", { name: /PostgreSQL/ }),
    "focus returns to the selected roving row, so arrow keys work without a click",
  );
});

test("ArrowDown changes the selection immediately after focus return", () => {
  renderSurface(fx.singleChoice);
  (document.activeElement as HTMLElement | null)?.blur();
  windowFocus();
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
  assert.equal(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked"), "true");
});

test("free-text question: focus return lands on the textarea fallback", () => {
  renderSurface(fx.freeText);
  (document.activeElement as HTMLElement | null)?.blur();
  windowFocus();
  assert.equal((document.activeElement as HTMLElement | null)?.tagName, "TEXTAREA");
});

test("focus return does not steal focus from an in-surface field being typed in (D-004)", () => {
  renderSurface(fx.singleChoice);
  // The user is typing in the custom-answer input inside the surface.
  const custom = screen.getByLabelText(/custom answer for/i) as HTMLElement;
  custom.focus();
  assert.equal(document.activeElement, custom);

  windowFocus();
  assert.equal(document.activeElement, custom, "an active in-surface field keeps focus");
});

test("an expired question does not grab focus on window return (read-only)", () => {
  renderSurface(fx.singleChoice, { expired: true });
  (document.activeElement as HTMLElement | null)?.blur();
  const body = document.body;
  windowFocus();
  assert.equal(document.activeElement, body, "expired surface is read-only - it never pulls focus");
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

test("plain Enter submits when ready and focus is on a choice", () => {
  const { onAnswer } = renderSurface(fx.singleChoice); // recommended pre-selected → ready
  fireEvent.keyDown(screen.getByRole("radio", { name: /PostgreSQL/ }), { key: "Enter" });
  assert.equal(onAnswer.mock.calls.length, 1);
  assert.equal(lastAccept(onAnswer).action, "accept");
});

test("plain Enter inside a textarea is a newline, not a submit (Cmd+Enter still submits)", () => {
  const { onAnswer } = renderSurface(fx.singleChoice); // ready
  fireEvent.keyDown(screen.getByRole("radio", { name: /PostgreSQL/ }), { key: "n" });
  const note = screen.getByLabelText(/notes/i);
  fireEvent.keyDown(note, { key: "Enter" });
  assert.equal(onAnswer.mock.calls.length, 0); // newline in the note, not a submit
  fireEvent.keyDown(note, { key: "Enter", metaKey: true });
  assert.equal(onAnswer.mock.calls.length, 1); // the explicit escape hatch still submits
});

test("auto-focuses the selected choice on mount so arrow keys work immediately", () => {
  renderSurface(fx.singleChoice);
  assert.equal(document.activeElement, screen.getByRole("radio", { name: /PostgreSQL/ }));
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

// --- 02.18: the sequenced tab interface (multi-question only) ---

test("single-question keeps the single-pane layout: no tab strip, 'Submit answer' (D-001)", () => {
  renderSurface(fx.singleChoice);
  assert.equal(screen.queryByRole("tablist"), null, "no tabs for a single question");
  assert.ok(screen.getByRole("button", { name: /submit answer/i }));
});

test("grouped: one tab per question with a 1-based label, checkmark when valid, and a counter (M4)", () => {
  renderSurface(fx.grouped);
  const tabs = screen.getAllByRole("tab");
  assert.equal(tabs.length, 3);
  assert.match(tabs[0]?.textContent ?? "", /Planning/); // header label
  assert.match(tabs[1]?.textContent ?? "", /Question 2/); // no header -> "Question N" fallback (D-014)
  assert.match(tabs[2]?.textContent ?? "", /Question 3/);
  assert.ok(screen.getByText("Question 1 of 3"));
  // scope is pre-selected (valid) so its tab shows a checkmark; checks/notes are not answered yet.
  assert.ok(tabs[0]?.querySelector('[aria-label="answered"]'), "the valid tab is checked");
  assert.equal(tabs[1]?.querySelector('[aria-label="answered"]'), null, "an open tab is unchecked");
});

test("grouped: Next is gated on the current tab; Submit appears only on the final tab (M5)", () => {
  renderSurface(fx.grouped);
  // Tab 0 (scope) is valid -> Next enabled, no Submit yet.
  assert.equal(
    (screen.getByRole("button", { name: /next/i }) as HTMLButtonElement).disabled,
    false,
  );
  assert.equal(screen.queryByRole("button", { name: /submit answers/i }), null);
  // Advance to tab 1 (checks, multi-select) - now Next is disabled until a box is picked.
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  assert.ok(screen.getByText("Question 2 of 3"));
  assert.equal((screen.getByRole("button", { name: /next/i }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Unit tests/ }));
  assert.equal(
    (screen.getByRole("button", { name: /next/i }) as HTMLButtonElement).disabled,
    false,
  );
});

test("grouped: a multi-question ask advances through the tabs and submits ONE batched answer (M5/M6)", () => {
  const { onAnswer } = renderSurface(fx.grouped);
  // Tab 0 (scope) pre-selected: advance with Enter (confirm-and-advance, not submit).
  fireEvent.keyDown(screen.getByRole("region", { name: /question from trevor/i }), {
    key: "Enter",
  });
  assert.equal(onAnswer.mock.calls.length, 0, "Enter mid-flow advances, it does not submit");
  // Tab 1 (checks): pick a box, advance.
  fireEvent.click(screen.getByRole("checkbox", { name: /Unit tests/ }));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  // Tab 2 (notes, final): type, then a single Submit emits one accept for all three questions.
  fireEvent.change(screen.getByLabelText("Anything else the reviewer should know?"), {
    target: { value: "ship behind a flag" },
  });
  fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));
  assert.equal(onAnswer.mock.calls.length, 1, "exactly one batched answer event");
  const answer = lastAccept(onAnswer);
  assert.deepEqual(
    answer.questions.map((a) => a.id),
    ["scope", "checks", "notes"],
  );
});

test("grouped: on the final tab with an earlier tab incomplete, Submit is disabled + a jump appears (M5/D-011)", () => {
  renderSurface(fx.grouped);
  // Jump straight to the final tab via Right/Right (leaving checks unanswered).
  const region = screen.getByRole("region", { name: /question from trevor/i });
  fireEvent.keyDown(region, { key: "ArrowRight" });
  fireEvent.keyDown(region, { key: "ArrowRight" });
  assert.ok(screen.getByText("Question 3 of 3"));
  // Type the (optional-shape) notes so only `checks` is incomplete.
  fireEvent.change(screen.getByLabelText("Anything else the reviewer should know?"), {
    target: { value: "done" },
  });
  const submit = screen.getByRole("button", { name: /submit answers/i });
  assert.equal((submit as HTMLButtonElement).disabled, true, "Submit is disabled, never a no-op");
  // The jump points at the first incomplete tab (checks = Q2) and goes there.
  fireEvent.click(screen.getByRole("button", { name: /go to incomplete \(Q2\)/i }));
  assert.ok(screen.getByText("Question 2 of 3"));
});

test("grouped: Left/Right move between tabs; Up/Down still move the choice within a tab (M7/D-013)", () => {
  renderSurface(fx.grouped);
  const region = screen.getByRole("region", { name: /question from trevor/i });
  // Right advances the tab; Left goes back.
  fireEvent.keyDown(region, { key: "ArrowRight" });
  assert.ok(screen.getByText("Question 2 of 3"));
  fireEvent.keyDown(region, { key: "ArrowLeft" });
  assert.ok(screen.getByText("Question 1 of 3"));
  // Up/Down change the single-choice selection (NOT the tab).
  fireEvent.keyDown(screen.getByRole("radio", { name: /Minimal slice/ }), { key: "ArrowDown" });
  assert.equal(
    screen.getByRole("radio", { name: /Full feature/ }).getAttribute("aria-checked"),
    "true",
  );
  assert.ok(screen.getByText("Question 1 of 3"), "Up/Down did not change the tab");
});

test("grouped: Left/Right inside a text field move the caret, not the tab (M7/D-009)", () => {
  renderSurface(fx.grouped);
  const region = screen.getByRole("region", { name: /question from trevor/i });
  // Go to the free-text tab and focus the textarea.
  fireEvent.keyDown(region, { key: "ArrowRight" });
  fireEvent.keyDown(region, { key: "ArrowRight" });
  const box = screen.getByLabelText("Anything else the reviewer should know?");
  box.focus();
  fireEvent.keyDown(box, { key: "ArrowLeft" });
  assert.ok(screen.getByText("Question 3 of 3"), "Left in a textarea did not change the tab");
});

test("grouped: going back to an answered tab shows the already-chosen answer (M7)", () => {
  renderSurface(fx.grouped);
  const region = screen.getByRole("region", { name: /question from trevor/i });
  fireEvent.keyDown(region, { key: "ArrowRight" }); // to checks
  fireEvent.click(screen.getByRole("checkbox", { name: /Unit tests/ }));
  fireEvent.keyDown(region, { key: "ArrowLeft" }); // back to scope
  fireEvent.keyDown(region, { key: "ArrowRight" }); // forward to checks again
  assert.equal(
    screen.getByRole("checkbox", { name: /Unit tests/ }).getAttribute("aria-checked"),
    "true",
    "the earlier choice persisted across tab navigation",
  );
});

test("grouped: focus follows the active tab onto its first choice (M8)", () => {
  renderSurface(fx.grouped);
  fireEvent.keyDown(screen.getByRole("region", { name: /question from trevor/i }), {
    key: "ArrowRight",
  });
  // Tab 1 (checks) is active: focus landed on a choice row in the new panel, not <body>.
  assert.notEqual(document.activeElement, document.body);
  assert.equal(
    (document.activeElement as HTMLElement | null)?.getAttribute("role"),
    "checkbox",
    "focus moved into the newly active panel",
  );
});

test("grouped: Decline works from any tab and emits a single decline (M5)", () => {
  const { onAnswer } = renderSurface(fx.grouped);
  fireEvent.keyDown(screen.getByRole("region", { name: /question from trevor/i }), {
    key: "ArrowRight",
  });
  fireEvent.click(screen.getByRole("button", { name: /decline/i }));
  assert.deepEqual(onAnswer.mock.calls.at(-1)?.[0], { action: "decline" });
});

test("grouped + expired: tabs are navigable read-only but nothing submits or declines", () => {
  const { onAnswer } = renderSurface(fx.grouped, { expired: true });
  assert.ok(screen.getByText(/this question expired/i));
  // The strip still renders for review, but every action control is disabled.
  assert.equal(screen.getAllByRole("tab").length, 3);
  assert.equal(
    (screen.getByRole("button", { name: /decline/i }) as HTMLButtonElement).disabled,
    true,
  );
  // A disabled control cannot fire, so nothing is ever emitted from an expired grouped surface.
  fireEvent.click(screen.getByRole("button", { name: /decline/i }));
  assert.equal(onAnswer.mock.calls.length, 0);
});

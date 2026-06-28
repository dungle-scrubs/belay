import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type AnswerIssueCode,
  type ContractIssueCode,
  deriveAnswerShape,
  normalizeAskUserInput,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  type QuestionItemAnswer,
  validateAnswer,
  validateContract,
} from "./provider-question";

/**
 * The shared ask_user contract: raw model input -> canonical contract (normalizeAskUserInput),
 * plus the two validators the host and web both depend on (validateContract / validateAnswer).
 * Pure functions, no transport - a bug here shows as a mis-rendered question or an accepted bad answer.
 */

const codes = (issues: readonly { code: string }[]) => issues.map((i) => i.code);

/** Narrow an indexed element to non-undefined (the repo runs noUncheckedIndexedAccess). */
function defined<T>(v: T | undefined, what = "element"): T {
  assert.ok(v !== undefined, `expected ${what} to be defined`);
  return v;
}

test("deriveAnswerShape: multiSelect wins, then choices, else free_text", () => {
  assert.equal(deriveAnswerShape({ multiSelect: true, choices: [] }), "multi_select");
  assert.equal(deriveAnswerShape({ choices: [{}, {}] }), "single_choice");
  assert.equal(deriveAnswerShape({}), "free_text");
  assert.equal(deriveAnswerShape({ choices: [] }), "free_text");
});

test("normalize: legacy single question becomes a one-question group", () => {
  const c = normalizeAskUserInput({
    question: "Pick a database",
    choices: [{ label: "Postgres" }, { label: "SQLite" }],
  });
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.questions.length, 1);
  const q = defined(c.questions[0]);
  assert.equal(q.id, "question_1");
  assert.equal(q.question, "Pick a database");
  assert.equal(q.answerShape, "single_choice");
  assert.equal(q.multiSelect, false);
  // Missing choice ids are filled deterministically.
  assert.deepEqual(
    q.choices.map((ch) => ch.id),
    ["choice_1", "choice_2"],
  );
});

test("normalize: rich grouped form wins over legacy fields and keeps per-question metadata", () => {
  const c = normalizeAskUserInput({
    question: "ignored legacy",
    questions: [
      { id: "scope", question: "Scope?", choices: [{ id: "all", label: "All" }] },
      { question: "Notes?", multiSelect: true, requiresReason: true, choices: [{ label: "A" }] },
    ],
  });
  assert.equal(c.questions.length, 2);
  assert.equal(defined(c.questions[0]).id, "scope");
  assert.equal(defined(c.questions[1]).id, "question_2");
  assert.equal(defined(c.questions[1]).answerShape, "multi_select");
  assert.equal(defined(c.questions[1]).requiresReason, true);
});

test("normalize: string preview becomes structured text, empty string drops", () => {
  const c = normalizeAskUserInput({
    questions: [
      {
        question: "Layout?",
        choices: [
          { label: "Wide", preview: "+-----+\n| wide |\n+-----+" },
          { label: "Empty", preview: "" },
          { label: "Struct", preview: { text: "x", viewport: "narrow" } },
        ],
      },
    ],
  });
  const choices = defined(c.questions[0]).choices;
  assert.equal(defined(choices[0]).preview?.text, "+-----+\n| wide |\n+-----+");
  assert.equal(defined(choices[1]).preview, undefined);
  assert.equal(defined(choices[2]).preview?.viewport, "narrow");
});

test("normalize: no question at all yields an empty contract (validation flags it)", () => {
  const c = normalizeAskUserInput({});
  assert.equal(c.questions.length, 0);
  assert.deepEqual(codes(validateContract(c)), ["no_questions"]);
});

// --- contract validation (negative fixtures, M1.3) ---

const single = (over: Partial<ProviderQuestionContract> = {}): ProviderQuestionContract => ({
  schemaVersion: 1,
  questions: [
    {
      id: "q1",
      question: "Pick one",
      answerShape: "single_choice",
      multiSelect: false,
      requiresReason: false,
      allowDefer: false,
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  ],
  ...over,
});

test("validateContract: a well-formed single-choice group has no issues", () => {
  assert.deepEqual(validateContract(single()), []);
});

test("validateContract: too many questions is flagged", () => {
  const q = defined(single().questions[0]);
  const six = single({ questions: Array.from({ length: 6 }, (_, i) => ({ ...q, id: `q${i}` })) });
  assert.ok(
    codes(validateContract(six)).includes("too_many_questions" satisfies ContractIssueCode),
  );
});

test("validateContract: empty text, missing choices, empty label, duplicate ids", () => {
  const bad: ProviderQuestionContract = {
    schemaVersion: 1,
    questions: [
      {
        id: "empty",
        question: "   ",
        answerShape: "single_choice",
        multiSelect: false,
        requiresReason: false,
        allowDefer: false,
        choices: [],
      },
      {
        id: "dupes",
        question: "Pick",
        answerShape: "multi_select",
        multiSelect: true,
        requiresReason: false,
        allowDefer: false,
        choices: [
          { id: "x", label: "" },
          { id: "x", label: "X2" },
        ],
      },
    ],
  };
  const found = codes(validateContract(bad));
  for (const code of [
    "empty_question",
    "missing_choices",
    "empty_choice_label",
    "duplicate_choice_id",
  ] satisfies ContractIssueCode[]) {
    assert.ok(found.includes(code), `expected ${code} in ${found.join(",")}`);
  }
});

// --- answer validation (negative fixtures, M1.3) ---

const accept = (questions: readonly QuestionItemAnswer[]): ProviderQuestionAnswer => ({
  action: "accept",
  answer: "summary",
  questions,
});

test("validateAnswer: decline and cancel are always valid", () => {
  assert.deepEqual(validateAnswer(single(), { action: "decline" }), []);
  assert.deepEqual(validateAnswer(single(), { action: "cancel" }), []);
});

test("validateAnswer: a valid single-choice accept passes", () => {
  const ok = validateAnswer(
    single(),
    accept([{ id: "q1", answer: "A", selected: [{ id: "a", label: "A" }] }]),
  );
  assert.deepEqual(ok, []);
});

test("validateAnswer: single-choice custom text (no choice) passes", () => {
  const ok = validateAnswer(single(), accept([{ id: "q1", answer: "custom", text: "my own" }]));
  assert.deepEqual(ok, []);
});

test("validateAnswer: single-choice with two selections is too_many_selected", () => {
  const issues = validateAnswer(
    single(),
    accept([
      {
        id: "q1",
        answer: "A,B",
        selected: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    ]),
  );
  assert.ok(codes(issues).includes("too_many_selected" satisfies AnswerIssueCode));
});

test("validateAnswer: a selection that isn't a real choice is unknown_choice", () => {
  const issues = validateAnswer(
    single(),
    accept([{ id: "q1", answer: "z", selected: [{ id: "z", label: "Z" }] }]),
  );
  assert.ok(codes(issues).includes("unknown_choice"));
});

test("validateAnswer: an unanswered question is flagged", () => {
  assert.deepEqual(codes(validateAnswer(single(), accept([]))), ["unanswered_question"]);
});

test("validateAnswer: requiresReason without a reason is missing_reason", () => {
  const contract = single({
    questions: [{ ...defined(single().questions[0]), requiresReason: true }],
  });
  const issues = validateAnswer(
    contract,
    accept([{ id: "q1", answer: "A", selected: [{ id: "a", label: "A" }] }]),
  );
  assert.ok(codes(issues).includes("missing_reason"));
});

test("validateAnswer: a deferred allowDefer question skips shape + reason checks", () => {
  const contract = single({
    questions: [{ ...defined(single().questions[0]), requiresReason: true, allowDefer: true }],
  });
  assert.deepEqual(
    validateAnswer(contract, accept([{ id: "q1", answer: "Deferred", defer: true }])),
    [],
  );
});

test("validateAnswer: a free-text question needs text and rejects selections", () => {
  const contract: ProviderQuestionContract = {
    schemaVersion: 1,
    questions: [
      {
        id: "ft",
        question: "Why?",
        answerShape: "free_text",
        multiSelect: false,
        requiresReason: false,
        allowDefer: false,
        choices: [],
      },
    ],
  };
  assert.ok(
    codes(validateAnswer(contract, accept([{ id: "ft", answer: "" }]))).includes("missing_text"),
  );
  assert.ok(
    codes(
      validateAnswer(
        contract,
        accept([{ id: "ft", answer: "x", text: "x", selected: [{ id: "a", label: "A" }] }]),
      ),
    ).includes("unexpected_selection"),
  );
});

test("validateAnswer: a multi-select accept with several valid choices passes", () => {
  const contract = single({
    questions: [
      { ...defined(single().questions[0]), answerShape: "multi_select", multiSelect: true },
    ],
  });
  const ok = validateAnswer(
    contract,
    accept([
      {
        id: "q1",
        answer: "A,B",
        selected: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    ]),
  );
  assert.deepEqual(ok, []);
});

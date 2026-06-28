import assert from "node:assert/strict";
import { test } from "vitest";
import * as fx from "./fixtures";
import {
  buildAnswer,
  contractFromRaw,
  draftErrors,
  emptyDraft,
  initialDraft,
  isComplete,
  selectCustom,
  setCustomText,
  setNotes,
  setReason,
  toggleChoice,
  toggleDefer,
} from "./view-model";

/**
 * The question surface's write-side view-model (view-model.ts) and the shared fixtures (fixtures.ts).
 * Pure - no DOM - so M2's component can stay a thin renderer over these transforms.
 */

/** Narrow an indexed element to non-undefined (the repo runs noUncheckedIndexedAccess). */
function defined<T>(v: T | undefined, what = "element"): T {
  assert.ok(v !== undefined, `expected ${what} to be defined`);
  return v;
}

// --- M1.1: the fixtures cover the full V1 case matrix ---

test("fixtures cover single, grouped, multi-select, free-text, reason, defer, preview, and metadata", () => {
  assert.equal(defined(fx.singleChoice.questions[0]).answerShape, "single_choice");
  assert.equal(defined(fx.multiSelect.questions[0]).answerShape, "multi_select");
  assert.equal(defined(fx.freeText.questions[0]).answerShape, "free_text");
  assert.equal(defined(fx.requiredReason.questions[0]).requiresReason, true);
  assert.equal(defined(fx.deferrable.questions[0]).allowDefer, true);
  assert.equal(fx.grouped.questions.length, 3); // a 1..5 group
  // Preview is structured ASCII text, never HTML.
  assert.match(
    defined(defined(fx.withPreviews.questions[0]).choices[0]).preview?.text ?? "",
    /\+--/,
  );
  // Choice metadata is present: recommended / impact / risk / badges.
  const db = defined(fx.singleChoice.questions[0]).choices;
  assert.equal(defined(db[0]).recommended, true);
  assert.ok(defined(db[1]).risk);
  assert.ok(defined(db[0]).impact);
  assert.deepEqual(defined(db[2]).badges, ["needs ops"]);
});

// --- M1.4: legacy raw input is coerced into the canonical view ---

test("contractFromRaw coerces a legacy single-question payload into a one-question group", () => {
  const c = contractFromRaw(fx.legacyRaw);
  assert.equal(c.questions.length, 1);
  assert.equal(defined(c.questions[0]).answerShape, "single_choice");
  assert.deepEqual(
    defined(c.questions[0]).choices.map((ch) => ch.id),
    ["choice_1", "choice_2"],
  );
});

// --- draft state machine ---

test("emptyDraft seeds one blank entry per question", () => {
  const d = emptyDraft(fx.grouped);
  assert.deepEqual(Object.keys(d.byId).sort(), ["checks", "notes", "scope"]);
  assert.deepEqual(d.byId.scope?.selectedIds, []);
});

test("initialDraft pre-selects the recommended single-choice option, none for multi/free-text", () => {
  const d = initialDraft(fx.grouped);
  assert.deepEqual(d.byId.scope?.selectedIds, ["minimal"]); // single-choice, "minimal" recommended
  assert.deepEqual(d.byId.checks?.selectedIds, []); // multi-select starts empty
  assert.deepEqual(d.byId.notes?.selectedIds, []); // free-text starts empty
});

test("initialDraft leaves a single-choice with no recommended option unselected", () => {
  const c = fx.contract([
    fx.question({
      id: "q",
      question: "Pick",
      answerShape: "single_choice",
      choices: [fx.choice({ id: "a", label: "A" })],
    }),
  ]);
  assert.deepEqual(initialDraft(c).byId.q?.selectedIds, []);
});

test("selectCustom: single-choice clears the chosen choice; multi-select toggles inclusion", () => {
  let d = initialDraft(fx.singleChoice); // postgres pre-selected
  d = selectCustom(d, defined(fx.singleChoice.questions[0]));
  assert.deepEqual(d.byId.db?.selectedIds, []);
  assert.equal(d.byId.db?.customSelected, true);

  const multiQ = defined(fx.multiSelect.questions[0]);
  let m = selectCustom(emptyDraft(fx.multiSelect), multiQ);
  assert.equal(m.byId.targets?.customSelected, true);
  m = selectCustom(m, multiQ);
  assert.equal(m.byId.targets?.customSelected, false);
});

test("single-choice replaces the selection and NEVER deselects (must choose one)", () => {
  const q = defined(fx.singleChoice.questions[0]);
  let d = emptyDraft(fx.singleChoice);
  d = toggleChoice(d, q, "postgres");
  assert.deepEqual(d.byId.db?.selectedIds, ["postgres"]);
  d = toggleChoice(d, q, "sqlite");
  assert.deepEqual(d.byId.db?.selectedIds, ["sqlite"]); // replaced, not appended
  d = toggleChoice(d, q, "sqlite");
  assert.deepEqual(d.byId.db?.selectedIds, ["sqlite"]); // re-selecting keeps it, never clears
});

test("multi-select toggle adds and removes ids", () => {
  const q = defined(fx.multiSelect.questions[0]);
  let d = emptyDraft(fx.multiSelect);
  d = toggleChoice(d, q, "macos");
  d = toggleChoice(d, q, "linux");
  assert.deepEqual(d.byId.targets?.selectedIds, ["macos", "linux"]);
  d = toggleChoice(d, q, "macos");
  assert.deepEqual(d.byId.targets?.selectedIds, ["linux"]);
});

test("typing a custom answer clears a single-choice selection but keeps multi-select choices", () => {
  const single = defined(fx.singleChoice.questions[0]);
  let ds = toggleChoice(emptyDraft(fx.singleChoice), single, "postgres");
  ds = setCustomText(ds, single, "CockroachDB");
  assert.deepEqual(ds.byId.db?.selectedIds, []);
  assert.equal(ds.byId.db?.customText, "CockroachDB");

  const multi = defined(fx.multiSelect.questions[0]);
  let dm = toggleChoice(emptyDraft(fx.multiSelect), multi, "macos");
  dm = setCustomText(dm, multi, "FreeBSD");
  assert.deepEqual(dm.byId.targets?.selectedIds, ["macos"]);
});

// --- buildAnswer ---

test("buildAnswer: single choice carries the selection and merges choice content", () => {
  const c = fx.contract([
    fx.question({
      id: "q",
      question: "Pick",
      answerShape: "single_choice",
      choices: [fx.choice({ id: "a", label: "A", content: { ref: 1 } })],
    }),
  ]);
  const d = toggleChoice(emptyDraft(c), defined(c.questions[0]), "a");
  const ans = buildAnswer(c, d);
  assert.equal(ans.action, "accept");
  assert.deepEqual(defined(ans.questions[0]).selected, [{ id: "a", label: "A" }]);
  assert.deepEqual(defined(ans.questions[0]).content, { ref: 1 });
  assert.equal(ans.answer, "A");
});

test("buildAnswer: free text carries text and no selection", () => {
  let d = emptyDraft(fx.freeText);
  d = setCustomText(d, defined(fx.freeText.questions[0]), "trevor-kit");
  const ans = buildAnswer(fx.freeText, d);
  assert.equal(defined(ans.questions[0]).text, "trevor-kit");
  assert.equal(defined(ans.questions[0]).selected, undefined);
});

test("buildAnswer: multi-select appends a custom entry alongside chosen choices", () => {
  const q = defined(fx.multiSelect.questions[0]);
  let d = toggleChoice(emptyDraft(fx.multiSelect), q, "macos");
  d = setCustomText(d, q, "FreeBSD");
  const ans = buildAnswer(fx.multiSelect, d);
  assert.deepEqual(defined(ans.questions[0]).selected, [
    { id: "macos", label: "macOS" },
    { label: "FreeBSD", custom: true },
  ]);
});

test("buildAnswer: notes and reason are attached when present", () => {
  const q = defined(fx.requiredReason.questions[0]);
  let d = toggleChoice(emptyDraft(fx.requiredReason), q, "incremental");
  d = setNotes(d, q.id, "  keep rollbacks cheap  ");
  d = setReason(d, q.id, "Lower blast radius");
  const ans = buildAnswer(fx.requiredReason, d);
  assert.equal(defined(ans.questions[0]).notes, "keep rollbacks cheap"); // trimmed
  assert.equal(defined(ans.questions[0]).reason, "Lower blast radius");
});

test("buildAnswer: a deferred question returns defer:true with no selection", () => {
  const d = toggleDefer(emptyDraft(fx.deferrable), "telemetry");
  const ans = buildAnswer(fx.deferrable, d);
  assert.equal(defined(ans.questions[0]).defer, true);
  assert.equal(defined(ans.questions[0]).selected, undefined);
  assert.equal(ans.answer, "Deferred");
});

// --- completeness / draftErrors (drives the disabled submit button) ---

test("an empty required draft is incomplete; selecting completes it", () => {
  let d = emptyDraft(fx.singleChoice);
  assert.equal(isComplete(fx.singleChoice, d), false);
  d = toggleChoice(d, defined(fx.singleChoice.questions[0]), "postgres");
  assert.equal(isComplete(fx.singleChoice, d), true);
});

test("requiresReason blocks completion until a reason is given", () => {
  const q = defined(fx.requiredReason.questions[0]);
  let d = toggleChoice(emptyDraft(fx.requiredReason), q, "incremental");
  assert.ok(draftErrors(fx.requiredReason, d).some((i) => i.code === "missing_reason"));
  d = setReason(d, q.id, "safer");
  assert.equal(isComplete(fx.requiredReason, d), true);
});

test("a deferrable question is complete once deferred without any selection", () => {
  const d = toggleDefer(emptyDraft(fx.deferrable), "telemetry");
  assert.equal(isComplete(fx.deferrable, d), true);
});

test("a grouped ask needs every question answered", () => {
  let d = emptyDraft(fx.grouped);
  d = toggleChoice(d, defined(fx.grouped.questions[0]), "minimal");
  assert.equal(isComplete(fx.grouped, d), false); // checks + notes still open
  d = toggleChoice(d, defined(fx.grouped.questions[1]), "unit");
  d = setCustomText(d, defined(fx.grouped.questions[2]), "ship behind a flag");
  assert.equal(isComplete(fx.grouped, d), true);
});

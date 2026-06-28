import assert from "node:assert/strict";
import { test } from "vitest";
import {
  APPROVE_CHOICE_ID,
  approvalDecision,
  approvalQuestion,
  REJECT_CHOICE_ID,
} from "./approval";
import type { ProviderQuestionAnswer } from "./provider-question";
import { validateContract } from "./provider-question";

/**
 * The approval-over-ask_user adapter (M7): an approval is just a single-choice ask_user question, so
 * the handoff plan reuses the one decision surface. These guard the round trip both ways - the built
 * contract is a valid ask_user contract, and an answer maps back to approve / edit / reject.
 */

const accept = (
  over: Partial<ProviderQuestionAnswer & { questions: unknown }>,
): ProviderQuestionAnswer =>
  ({ action: "accept", answer: "x", questions: [], ...over }) as ProviderQuestionAnswer;

test("approvalQuestion builds a valid ask_user contract with approve (recommended) + reject", () => {
  const contract = approvalQuestion({
    title: "Approve the handoff?",
    summary: "Hand off to a fresh session.",
  });
  assert.deepEqual(validateContract(contract), [], "the approval contract is structurally valid");
  const q = contract.questions[0];
  assert.equal(q?.answerShape, "single_choice");
  assert.equal(q?.choices[0]?.id, APPROVE_CHOICE_ID);
  assert.equal(q?.choices[0]?.recommended, true);
  assert.equal(q?.choices[0]?.description, "Hand off to a fresh session.");
  assert.equal(q?.choices[1]?.id, REJECT_CHOICE_ID);
});

test("approvalDecision: choosing approve returns an approve decision", () => {
  const decision = approvalDecision(
    accept({
      questions: [
        {
          id: "approval",
          answer: "Approve",
          selected: [{ id: APPROVE_CHOICE_ID, label: "Approve" }],
        },
      ],
    }),
  );
  assert.deepEqual(decision, { action: "approve" });
});

test("approvalDecision: choosing reject (with a note) returns a reject with the reason", () => {
  const decision = approvalDecision(
    accept({
      questions: [
        {
          id: "approval",
          answer: "Reject",
          selected: [{ id: REJECT_CHOICE_ID, label: "Reject" }],
          notes: "not yet",
        },
      ],
    }),
  );
  assert.deepEqual(decision, { action: "reject", reason: "not yet" });
});

test("approvalDecision: a custom-text answer is an edit carrying the amended proposal", () => {
  const decision = approvalDecision(
    accept({
      questions: [{ id: "approval", answer: "tweak", text: "hand off but keep the branch" }],
    }),
  );
  assert.deepEqual(decision, { action: "edit", edited: "hand off but keep the branch" });
});

test("approvalDecision: decline / cancel reads as reject", () => {
  assert.deepEqual(approvalDecision({ action: "decline" }), { action: "reject" });
  assert.deepEqual(approvalDecision({ action: "cancel" }), { action: "reject" });
});

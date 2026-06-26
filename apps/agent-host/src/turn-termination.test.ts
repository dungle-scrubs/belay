import assert from "node:assert/strict";
import { test } from "vitest";
import { type CompletionOutcome, terminationReason } from "./turn-termination";

/** A clean answered completion; each test overrides only the flag under test. */
const answered: CompletionOutcome = {
  cancelled: false,
  interrupted: false,
  noReply: false,
  stepLimit: 0,
  text: "here is the answer",
};

test("a normal completion reads 'answered'", () => {
  assert.equal(terminationReason(answered, false), "answered");
});

test("a user cancel outranks everything else", () => {
  assert.equal(
    terminationReason({ ...answered, cancelled: true, interrupted: true, stepLimit: 8 }, true),
    "cancelled",
  );
});

test("a host reap reads 'interrupted' (distinct from a user cancel)", () => {
  assert.equal(terminationReason({ ...answered, interrupted: true }, false), "interrupted");
});

test("a terminal error outranks a budget cut", () => {
  assert.equal(
    terminationReason({ ...answered, error: "stream failed", stepLimit: 8 }, false),
    "error",
  );
});

test("a budget-terminated turn reports the step count", () => {
  assert.equal(terminationReason({ ...answered, stepLimit: 12 }, false), "step_limit (12 steps)");
});

test("an exhausted-context overflow with no real answer reads 'overflow'", () => {
  assert.equal(terminationReason({ ...answered, noReply: true, text: "" }, true), "overflow");
});

test("an overflow that still produced an answer is 'answered' (recovery worked)", () => {
  assert.equal(terminationReason({ ...answered, text: "recovered answer" }, true), "answered");
});

test("a bare empty reply (no overflow) reads 'noReply'", () => {
  assert.equal(terminationReason({ ...answered, noReply: true, text: "" }, false), "noReply");
});

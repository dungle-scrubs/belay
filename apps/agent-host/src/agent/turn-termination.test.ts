import assert from "node:assert/strict";
import {
  type CompletionOutcome,
  countRestartResumes,
  MAX_RESTART_RESUMES,
  type ResumeInputs,
  resumeAfterStop,
  terminationReason,
} from "@host/session/session-lifecycle";
import { test } from "vitest";

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

test("typed stop data outranks legacy budget flags", () => {
  assert.equal(
    terminationReason(
      {
        ...answered,
        stepLimit: 32,
        stop: {
          cause: "step_backstop",
          action: "paused",
          summary: "Paused at the 32-step backstop before context pressure.",
          steps: 32,
        },
      },
      false,
    ),
    "step_backstop: Paused at the 32-step backstop before context pressure.",
  );
});

test("typed stop summaries are deterministic for all initial stop causes", () => {
  const causes = [
    "answered",
    "context_pressure",
    "step_backstop",
    "loop_stalled",
    "provider_protocol_anomaly",
    "overflow",
    "no_reply",
    "cancelled",
    "interrupted",
    "error",
  ] as const;
  for (const cause of causes) {
    assert.equal(
      terminationReason(
        {
          ...answered,
          stop: {
            cause,
            action: cause === "answered" ? "completed" : "paused",
            summary: `${cause} summary`,
          },
        },
        false,
      ),
      `${cause}: ${cause} summary`,
    );
  }
});

test("a budget-terminated turn reports the step count", () => {
  assert.equal(terminationReason({ ...answered, stepLimit: 12 }, false), "step_limit (12 steps)");
});

// Auto-resume policy (host restart/crash recovery): a turn killed by a restart is re-issued
// automatically, bounded so a crash-looping host falls back to a manual Resume.

/** A clean, no-resume baseline; each test flips only the field under test. */
const stable: ResumeInputs = {
  interrupted: false,
  cancelled: false,
  lastWasContinuation: false,
  restartResumesSpent: 0,
};

test("resume: a host-restart interrupt auto-resumes on the first attempt", () => {
  assert.deepEqual(resumeAfterStop({ ...stable, interrupted: true }), {
    kind: "resume",
    cause: "restart",
    attempt: 1,
  });
});

test("resume: a user ESC is final - never auto-resumed (cancel outranks interrupt)", () => {
  assert.deepEqual(
    resumeAfterStop({ ...stable, cancelled: true, interrupted: true }),
    { kind: "none" },
    "a cancel that also carries the interrupt flag must not resume",
  );
});

test("resume: the restart bound falls back to manual once the cap is spent", () => {
  // One below the cap still resumes (the final attempt); at the cap it asks for a manual Resume.
  assert.deepEqual(
    resumeAfterStop({ ...stable, interrupted: true, restartResumesSpent: MAX_RESTART_RESUMES - 1 }),
    { kind: "resume", cause: "restart", attempt: MAX_RESTART_RESUMES },
  );
  assert.deepEqual(
    resumeAfterStop({ ...stable, interrupted: true, restartResumesSpent: MAX_RESTART_RESUMES }),
    { kind: "manual", cause: "restart-exhausted" },
  );
});

test("resume: a step-budget pause auto-continues, but not when stacked on a continuation", () => {
  assert.deepEqual(resumeAfterStop({ ...stable, stopCause: "step_backstop" }), {
    kind: "resume",
    cause: "step-backstop",
  });
  assert.deepEqual(
    resumeAfterStop({ ...stable, stopCause: "step_backstop", lastWasContinuation: true }),
    { kind: "none" },
    "a continuation that pauses again is not auto-stacked",
  );
});

test("resume: a normal answer (no interrupt, no budget pause) is left alone", () => {
  assert.deepEqual(resumeAfterStop(stable), { kind: "none" });
  assert.deepEqual(resumeAfterStop({ ...stable, stopCause: "context_pressure" }), { kind: "none" });
});

test("countRestartResumes: counts the trailing restart streak, reset by any other marker", () => {
  assert.equal(countRestartResumes([]), 0);
  assert.equal(countRestartResumes(["user-prompt"]), 0);
  assert.equal(countRestartResumes(["user-prompt", "restart-resume", "restart-resume"]), 2);
  // A normal completion mid-stream breaks the streak: only the trailing run counts.
  assert.equal(
    countRestartResumes(["restart-resume", "normal-completion", "restart-resume"]),
    1,
    "progress between resumes resets the crash-loop window",
  );
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

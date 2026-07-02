import { describe, expect, test } from "vitest";
import { hookExecutionOutcome, hookTrustOutcome, isBlockingHookOutcome } from "./results";
import type { HookExecution } from "./runner";

function execution(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    stdout: { text: "", truncated: false },
    stderr: { text: "", truncated: false },
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    ...overrides,
  };
}

describe("hookExecutionOutcome - failures are diagnostics, never throws (D-007)", () => {
  test("a timeout is a timeout diagnostic", () => {
    const outcome = hookExecutionOutcome(
      execution({ timedOut: true, exitCode: null, signal: "SIGTERM", durationMs: 205 }),
    );
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "timeout" });
    expect(isBlockingHookOutcome(outcome)).toBe(false);
  });

  test("a spawn failure is a command_failed diagnostic", () => {
    const outcome = hookExecutionOutcome(
      execution({ exitCode: null, spawnError: "spawn /missing ENOENT" }),
    );
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
    if (outcome.kind === "diagnostic") {
      expect(outcome.detail).toContain("ENOENT");
    }
  });

  test("a non-zero exit is a command_failed diagnostic with a redacted stderr tail", () => {
    const outcome = hookExecutionOutcome(
      execution({ exitCode: 3, stderr: { text: "TOKEN=supersecret boom", truncated: false } }),
    );
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
    if (outcome.kind === "diagnostic") {
      expect(outcome.detail).toContain("3");
      expect(outcome.detail).toContain("boom");
      expect(outcome.detail).not.toContain("supersecret");
    }
  });

  test("a signal death without a timeout is a command_failed diagnostic", () => {
    const outcome = hookExecutionOutcome(execution({ exitCode: null, signal: "SIGKILL" }));
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
  });

  test("non-JSON stdout from a successful run is an invalid_json diagnostic", () => {
    const outcome = hookExecutionOutcome(
      execution({ stdout: { text: "looks good to me", truncated: false } }),
    );
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "invalid_json" });
  });

  test("an unknown decision verb is an invalid_decision diagnostic", () => {
    const outcome = hookExecutionOutcome(
      execution({ stdout: { text: '{"decision":"maybe"}', truncated: false } }),
    );
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "invalid_decision" });
  });

  test("valid deny JSON from a FAILED command is still command_failed - failed output is untrusted", () => {
    const outcome = hookExecutionOutcome(
      execution({ exitCode: 1, stdout: { text: '{"decision":"deny"}', truncated: false } }),
    );
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
  });

  test("the diagnostic detail is bounded", () => {
    const outcome = hookExecutionOutcome(
      execution({ exitCode: 1, stderr: { text: "e".repeat(10_000), truncated: false } }),
    );
    expect(outcome.kind).toBe("diagnostic");
    if (outcome.kind === "diagnostic") {
      expect(outcome.detail.length).toBeLessThan(600);
    }
  });
});

describe("hookExecutionOutcome - silent success is implicit allow (25 M5)", () => {
  test("exit 0 with empty stdout is an implicit allow decision, not a diagnostic", () => {
    const outcome = hookExecutionOutcome(execution());
    expect(outcome).toEqual({ kind: "decision", decision: { decision: "allow" } });
    expect(isBlockingHookOutcome(outcome)).toBe(false);
  });

  test("exit 0 with whitespace-only stdout is still an implicit allow", () => {
    const outcome = hookExecutionOutcome(execution({ stdout: { text: " \n", truncated: false } }));
    expect(outcome).toEqual({ kind: "decision", decision: { decision: "allow" } });
  });

  test("a FAILED run with empty stdout stays a command_failed diagnostic, never implicit allow", () => {
    const outcome = hookExecutionOutcome(execution({ exitCode: 1 }));
    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
  });
});

describe("hookExecutionOutcome - explicit decisions from successful runs are preserved (D-007)", () => {
  test("an allow decision passes through and does not block", () => {
    const outcome = hookExecutionOutcome(
      execution({ stdout: { text: '{"decision":"allow"}', truncated: false } }),
    );
    expect(outcome).toEqual({ kind: "decision", decision: { decision: "allow" } });
    expect(isBlockingHookOutcome(outcome)).toBe(false);
  });

  test("an explicit deny still blocks", () => {
    const outcome = hookExecutionOutcome(
      execution({
        stdout: { text: '{"decision":"deny","reason":"touches prod"}', truncated: false },
      }),
    );
    expect(outcome).toMatchObject({ kind: "decision", decision: { decision: "deny" } });
    expect(isBlockingHookOutcome(outcome)).toBe(true);
  });

  test("an explicit halt still blocks", () => {
    const outcome = hookExecutionOutcome(
      execution({ stdout: { text: '{"decision":"halt"}', truncated: false } }),
    );
    expect(isBlockingHookOutcome(outcome)).toBe(true);
  });
});

describe("hookTrustOutcome - the gate's diagnostic projection (D-006)", () => {
  test("an approved hook yields no diagnostic", () => {
    expect(hookTrustOutcome("approved")).toBeUndefined();
  });

  test("an unapproved hook is an unapproved diagnostic", () => {
    expect(hookTrustOutcome("unapproved")).toMatchObject({
      kind: "diagnostic",
      reason: "unapproved",
    });
  });

  test("a changed trust hash is a trust_changed diagnostic", () => {
    expect(hookTrustOutcome("changed")).toMatchObject({
      kind: "diagnostic",
      reason: "trust_changed",
    });
  });

  test("a missing script is a missing_script diagnostic", () => {
    expect(hookTrustOutcome("missing-script")).toMatchObject({
      kind: "diagnostic",
      reason: "missing_script",
    });
  });

  test("trust diagnostics never block the turn - they only keep the hook from running", () => {
    for (const status of ["unapproved", "changed", "missing-script"] as const) {
      const outcome = hookTrustOutcome(status);
      expect(outcome && isBlockingHookOutcome(outcome)).toBe(false);
    }
  });
});

import { describe, expect, test } from "vitest";
import {
  HOOK_DECISIONS,
  MAX_HOOK_CONTEXT_CHARS,
  MAX_HOOK_REASON_CHARS,
  parseHookDecision,
} from "./decision";

describe("parseHookDecision - valid decisions", () => {
  test("the decision vocabulary is exactly allow/deny/halt", () => {
    expect(HOOK_DECISIONS).toEqual(["allow", "deny", "halt"]);
  });

  test("a bare allow parses with no optional fields", () => {
    const parsed = parseHookDecision('{"decision":"allow"}');
    expect(parsed).toEqual({ ok: true, decision: { decision: "allow" } });
  });

  test("a deny with a reason parses", () => {
    const parsed = parseHookDecision('{"decision":"deny","reason":"tool touches prod"}');
    expect(parsed).toEqual({
      ok: true,
      decision: { decision: "deny", reason: "tool touches prod" },
    });
  });

  test("a halt with context parses", () => {
    const parsed = parseHookDecision('{"decision":"halt","reason":"stop","context":"details"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision.decision).toBe("halt");
      expect(parsed.decision.context).toBe("details");
    }
  });

  test("surrounding whitespace and trailing newline are tolerated", () => {
    const parsed = parseHookDecision('\n  {"decision":"allow"}\n');
    expect(parsed.ok).toBe(true);
  });

  test("updatedInput is carried through as unknown, unvalidated here (M6 validates per-tool)", () => {
    const parsed = parseHookDecision(
      '{"decision":"allow","updatedInput":{"command":"ls -la","nested":[1,2]}}',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision.updatedInput).toEqual({ command: "ls -la", nested: [1, 2] });
    }
  });
});

describe("parseHookDecision - bounds", () => {
  test("an oversized context is capped with a truncation marker", () => {
    const context = "c".repeat(MAX_HOOK_CONTEXT_CHARS + 500);
    const parsed = parseHookDecision(JSON.stringify({ decision: "allow", context }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.decision.context) {
      expect(parsed.decision.context.length).toBeLessThan(context.length);
      expect(parsed.decision.context).toContain("truncated");
    }
  });

  test("an oversized reason is clipped to one bounded line", () => {
    const reason = `multi\nline ${"r".repeat(MAX_HOOK_REASON_CHARS + 100)}`;
    const parsed = parseHookDecision(JSON.stringify({ decision: "deny", reason }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.decision.reason) {
      expect(parsed.decision.reason.length).toBeLessThanOrEqual(MAX_HOOK_REASON_CHARS + 1);
      expect(parsed.decision.reason).not.toContain("\n");
    }
  });

  test("a non-string context is dropped, not a crash", () => {
    const parsed = parseHookDecision('{"decision":"allow","context":{"not":"a string"}}');
    expect(parsed).toEqual({ ok: true, decision: { decision: "allow" } });
  });
});

describe("parseHookDecision - invalid output is data, never a throw", () => {
  test("non-JSON stdout is an invalid_json result", () => {
    const parsed = parseHookDecision("all checks passed!");
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  test("empty stdout is an invalid_json result", () => {
    const parsed = parseHookDecision("   \n");
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  test("a JSON array is an invalid_json result (decision must be an object)", () => {
    const parsed = parseHookDecision('["allow"]');
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  test("an unknown decision value is an invalid_decision result naming the supported set", () => {
    const parsed = parseHookDecision('{"decision":"block"}');
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_decision" });
    if (!parsed.ok) {
      expect(parsed.detail).toContain("block");
      expect(parsed.detail).toContain("allow");
    }
  });

  test("a missing decision field is an invalid_decision result", () => {
    const parsed = parseHookDecision('{"reason":"forgot the verb"}');
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_decision" });
  });

  test("the invalid_json detail preview is redacted and bounded", () => {
    const secret = `TOKEN=supersecret123 ${"x".repeat(500)}`;
    const parsed = parseHookDecision(secret);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.detail).not.toContain("supersecret123");
      expect(parsed.detail.length).toBeLessThan(300);
    }
  });
});

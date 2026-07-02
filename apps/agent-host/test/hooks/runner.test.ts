import { parseHookDecision } from "@host/hooks/decision";
import {
  DEFAULT_HOOK_OUTPUT_CAP_CHARS,
  type HookExecution,
  redactHookExecution,
  runHook,
} from "@host/hooks/runner";
import { describe, expect, test } from "vitest";
import { fixtureHook } from "./fixture-config";

/**
 * Hook runner integration tests (plan 25 M3): the command runner against the real fixture
 * child - no-shell argv fidelity (D-005), stdin payload delivery, the SIGTERM -> grace ->
 * SIGKILL timeout ladder, output caps, spawn hygiene (cwd + minimal env, D-004), and the
 * redacted execution projection (D-009).
 *
 * Responsible for: exercising runHook end to end over ./fixture-hook.
 * Not for: decision-parse and redaction unit cases - src/hooks/decision.test.ts and
 * src/hooks/redact.test.ts own those.
 */

const cwd = import.meta.dirname;

/** The context string the fixture's allow decision carries, or the test fails decoding. */
function contextOf(execution: HookExecution): string {
  const parsed = parseHookDecision(execution.stdout.text);
  expect(parsed.ok).toBe(true);
  return parsed.ok ? (parsed.decision.context ?? "") : "";
}

describe("runHook - no shell, args reach argv untouched (D-005)", () => {
  test("spaces, $HOME, semicolons, and && survive as literal argv entries", async () => {
    const args = ["has spaces", "$HOME", "a;b", "&& echo pwned", "`whoami`"];
    const execution = await runHook(fixtureHook("argv", args), {}, { cwd });

    expect(execution.spawnError).toBeUndefined();
    expect(execution.exitCode).toBe(0);
    expect(JSON.parse(contextOf(execution))).toEqual(args);
  });
});

describe("runHook - payload delivery on stdin", () => {
  test("the payload arrives as JSON on stdin and stdin is closed after the write", async () => {
    const payload = { event: "PreToolUse", tool: "bash", input: { command: "ls" } };
    const execution = await runHook(fixtureHook("stdin"), payload, { cwd });

    expect(execution.exitCode).toBe(0);
    // The fixture only answers on stdin's `end`, so a completed run proves the runner closed it.
    expect(JSON.parse(contextOf(execution))).toEqual(payload);
  });

  test("an undefined payload still closes stdin with a JSON body", async () => {
    const execution = await runHook(fixtureHook("stdin"), undefined, { cwd });
    expect(execution.exitCode).toBe(0);
    expect(contextOf(execution)).toBe("null");
  });
});

describe("runHook - timeout ladder (SIGTERM -> grace -> SIGKILL)", () => {
  test("a hanging hook is SIGTERMed at its configured timeout", async () => {
    const execution = await runHook(fixtureHook("hang", [], { timeoutMs: 200 }), {}, { cwd });

    expect(execution.timedOut).toBe(true);
    expect(execution.signal).toBe("SIGTERM");
    expect(execution.exitCode).toBeNull();
    expect(execution.durationMs).toBeGreaterThanOrEqual(150);
  });

  test("a hook that ignores SIGTERM is SIGKILLed after the grace window", async () => {
    const execution = await runHook(
      fixtureHook("hang", ["ignore-sigterm"], { timeoutMs: 200 }),
      {},
      { cwd, killGraceMs: 200 },
    );

    expect(execution.timedOut).toBe(true);
    expect(execution.signal).toBe("SIGKILL");
  });

  test("a fast hook does not time out", async () => {
    const execution = await runHook(fixtureHook("print", ["{}"]), {}, { cwd });
    expect(execution.timedOut).toBe(false);
    expect(execution.exitCode).toBe(0);
  });
});

describe("runHook - output caps", () => {
  test("stdout and stderr are hard-capped with a truncation marker", async () => {
    const spew = String(DEFAULT_HOOK_OUTPUT_CAP_CHARS + 40_000);
    const execution = await runHook(fixtureHook("spew", [spew, spew]), {}, { cwd });

    expect(execution.stdout.truncated).toBe(true);
    expect(execution.stderr.truncated).toBe(true);
    expect(execution.stdout.text).toContain("truncated");
    expect(execution.stdout.text.length).toBeLessThan(DEFAULT_HOOK_OUTPUT_CAP_CHARS + 100);
    expect(execution.stderr.text.length).toBeLessThan(DEFAULT_HOOK_OUTPUT_CAP_CHARS + 100);
  });

  test("an injected smaller cap bounds output for cheap tests", async () => {
    const execution = await runHook(
      fixtureHook("spew", ["500", "0"]),
      {},
      { cwd, maxOutputChars: 100 },
    );

    expect(execution.stdout.truncated).toBe(true);
    expect(execution.stdout.text.length).toBeLessThan(200);
    expect(execution.stderr.truncated).toBe(false);
  });

  test("output under the cap is untouched", async () => {
    const execution = await runHook(fixtureHook("print", ["small output"]), {}, { cwd });
    expect(execution.stdout).toEqual({ text: "small output", truncated: false });
  });
});

describe("runHook - spawn hygiene (D-004)", () => {
  test("the child runs in the given cwd", async () => {
    const execution = await runHook(fixtureHook("cwd"), {}, { cwd });
    expect(contextOf(execution)).toBe(cwd);
  });

  test("the child env is the minimal allowlist - host secrets never arrive", async () => {
    const hostEnv = { ...process.env, TREVOR_HOOK_TEST_SECRET: "boom" };
    const execution = await runHook(fixtureHook("env"), {}, { cwd, hostEnv });

    const keys = JSON.parse(contextOf(execution)) as string[];
    expect(keys).toContain("PATH");
    expect(keys).not.toContain("TREVOR_HOOK_TEST_SECRET");
  });

  test("a missing executable resolves as a spawn error, never a rejection", async () => {
    const execution = await runHook(
      fixtureHook("argv", [], { command: "/nonexistent/trevor-hook-binary" }),
      {},
      { cwd },
    );

    expect(execution.spawnError).toBeDefined();
    expect(execution.exitCode).toBeNull();
  });
});

describe("redactHookExecution - the stored/log projection (D-009)", () => {
  test("stdout/stderr are redacted in the log projection", async () => {
    const hook = fixtureHook("fail", ["API_KEY=topsecret at /Users/somebody/x", "3"]);
    const execution = await runHook(hook, {}, { cwd });
    const log = redactHookExecution(execution);

    expect(execution.exitCode).toBe(3);
    expect(log.stderr).not.toContain("topsecret");
    expect(log.stderr).not.toContain("/Users/somebody");
    expect(log.exitCode).toBe(3);
    expect(log.timedOut).toBe(false);
    expect(log.durationMs).toBe(execution.durationMs);
  });
});

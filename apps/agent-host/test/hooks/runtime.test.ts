import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import {
  type HooksRuntimeHarness,
  hooksRuntimeHarness,
  preToolUsePayload,
} from "./runtime-fixture";

/**
 * PreToolUse dispatch integration tests (plan 25 M5): the hooks runtime driven end to end over
 * real temp config roots and the real fixture child - payload delivery on stdin, allow
 * pass-through (explicit and implicit silent-success), deny/halt short-circuit in config order,
 * the approval gate (unapproved hooks are diagnostics that never execute, D-006), non-blocking
 * failure diagnostics (D-007), and the per-hook stats feed.
 *
 * Responsible for: exercising createHooksRuntime.dispatchPreToolUse over ./runtime-fixture.
 * Not for: single-hook runner mechanics (./runner.test.ts) or outcome derivation
 * (./outcomes.test.ts).
 */

const DENY = JSON.stringify({ decision: "deny", reason: "touches prod" });
const HALT = JSON.stringify({ decision: "halt", reason: "stop the line" });

let harness: HooksRuntimeHarness | undefined;

function using(built: HooksRuntimeHarness): HooksRuntimeHarness {
  harness = built;
  return built;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe("dispatchPreToolUse - payload and allow pass-through", () => {
  test("the full payload arrives on the hook's stdin as JSON", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("payload.json")] },
      ]),
    );

    const payload = preToolUsePayload({
      sessionId: "s-42",
      runId: "run-42",
      turnId: "run-42",
      cwd: h.workspaceRoot,
      callerKind: "subagent",
      toolName: "write",
      toolInput: { file_path: "x.txt", content: "hi" },
      toolMetadata: { readOnly: false },
    });
    const outcome = await h.runtime.dispatchPreToolUse(payload);

    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
    expect(JSON.parse(readFileSync(h.scratchPath("payload.json"), "utf8"))).toEqual(payload);
  });

  test("an explicit allow decision passes through with no diagnostics", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "ok", mode: "print", flags: ['{"decision":"allow"}'] }]),
    );
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
  });

  test("a silent exit-0 hook with no stdout is an implicit allow (25 M5)", async () => {
    const h = using(hooksRuntimeHarness([{ id: "quiet", mode: "print", flags: [""] }]));
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
  });

  test("no configured hooks means a transparent allow", async () => {
    const h = using(hooksRuntimeHarness([]));
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("dispatchPreToolUse - blocking decisions and config order", () => {
  test("a deny short-circuits: later hooks in config order never execute", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "guard", mode: "print", flags: [DENY] },
        { id: "rec", mode: "record", flags: [scratch("after-deny.json")] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("deny");
    expect(outcome.hook).toBe("project:guard");
    expect(outcome.reason).toBe("touches prod");
    expect(existsSync(h.scratchPath("after-deny.json"))).toBe(false);
  });

  test("project hooks run before user hooks: a project deny blocks a user hook", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "guard", mode: "print", flags: [DENY] }], (scratch) => [
        { id: "rec", mode: "record", flags: [scratch("user-after-deny.json")] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("deny");
    expect(outcome.hook).toBe("project:guard");
    expect(existsSync(h.scratchPath("user-after-deny.json"))).toBe(false);
  });

  test("a halt decision surfaces the halting hook and its reason", async () => {
    const h = using(hooksRuntimeHarness([{ id: "stopper", mode: "print", flags: [HALT] }]));
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("halt");
    expect(outcome.hook).toBe("project:stopper");
    expect(outcome.reason).toBe("stop the line");
  });
});

describe("dispatchPreToolUse - the approval gate (D-006)", () => {
  test("an unapproved hook never executes and surfaces only a diagnostic", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("unapproved.json")], approved: false },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: "project:rec", reason: "unapproved" }),
    ]);
    expect(existsSync(h.scratchPath("unapproved.json"))).toBe(false);
  });

  test("a disabled hook is skipped without executing", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("disabled.json")], enabled: false },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(existsSync(h.scratchPath("disabled.json"))).toBe(false);
  });

  test("a Stop hook is never dispatched for PreToolUse", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("stop-hook.json")], event: "Stop" },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
    expect(existsSync(h.scratchPath("stop-hook.json"))).toBe(false);
  });
});

describe("dispatchPreToolUse - non-blocking failures and stats (D-007)", () => {
  test("a failing hook is a diagnostic; the dispatch still allows", async () => {
    const h = using(hooksRuntimeHarness([{ id: "broken", mode: "fail", flags: ["boom", "2"] }]));
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: "project:broken", reason: "command_failed" }),
    ]);
  });

  test("diagnostics accumulate across hooks while allows pass through", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "broken", mode: "fail", flags: ["boom", "1"] },
        { id: "garbled", mode: "print", flags: ["not json"] },
        { id: "ok", mode: "print", flags: ['{"decision":"allow"}'] },
      ]),
    );
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics.map((d) => d.reason)).toEqual(["command_failed", "invalid_json"]);
  });

  test("executions land in the per-hook stats snapshot", async () => {
    const h = using(hooksRuntimeHarness([{ id: "broken", mode: "fail", flags: ["boom", "1"] }]));
    await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(h.runtime.statsSnapshot()).toEqual([
      expect.objectContaining({ key: "project:broken", runs: 1, failures: 1 }),
    ]);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveHook,
  EMPTY_HOOK_APPROVALS,
  hookApprovalKey,
  saveHookApprovals,
} from "@host/hooks/approval";
import { discoverHooks } from "@host/hooks/discovery";
import { createHooksRuntime } from "@host/hooks/runtime";
import { computeHookTrustFingerprint } from "@host/hooks/trust";
import { afterEach, describe, expect, test } from "vitest";
import { HOOK_FIXTURE_COMMAND, hookFixtureArgs } from "./fixture-config";
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
    expect(outcome.hook).toBe(h.projectKey("guard"));
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
    expect(outcome.hook).toBe(h.projectKey("guard"));
    expect(existsSync(h.scratchPath("user-after-deny.json"))).toBe(false);
  });

  test("a halt decision surfaces the halting hook and its reason", async () => {
    const h = using(hooksRuntimeHarness([{ id: "stopper", mode: "print", flags: [HALT] }]));
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("halt");
    expect(outcome.hook).toBe(h.projectKey("stopper"));
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
      expect.objectContaining({ hook: h.projectKey("rec"), reason: "unapproved" }),
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

describe("dispatchPreToolUse - bounded context (25 M6)", () => {
  test("context from allow hooks accumulates in config order with attribution", async () => {
    const h = using(
      hooksRuntimeHarness([
        {
          id: "a",
          mode: "print",
          flags: ['{"decision":"allow","context":"check the lockfile"}'],
        },
        { id: "b", mode: "print", flags: ['{"decision":"allow","context":"second note"}'] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.contexts).toEqual([
      { hook: h.projectKey("a"), context: "check the lockfile" },
      { hook: h.projectKey("b"), context: "second note" },
    ]);
  });

  test("an oversized context arrives bounded with a truncation marker", async () => {
    const huge = "c".repeat(6_000);
    const h = using(
      hooksRuntimeHarness([
        { id: "big", mode: "print", flags: [JSON.stringify({ decision: "allow", context: huge })] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.contexts).toHaveLength(1);
    expect(outcome.contexts[0]?.context.length).toBeLessThan(huge.length);
    expect(outcome.contexts[0]?.context).toContain("truncated");
  });

  test("a blocking decision still carries the contexts gathered before it", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "a", mode: "print", flags: ['{"decision":"allow","context":"heads up"}'] },
        { id: "guard", mode: "print", flags: [DENY] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("deny");
    expect(outcome.contexts).toEqual([{ hook: h.projectKey("a"), context: "heads up" }]);
  });
});

describe("dispatchPreToolUse - scoped updatedInput (25 M6, D-003)", () => {
  const rewrite = (command: string) =>
    JSON.stringify({ decision: "allow", updatedInput: { command } });

  test("an allowlisted bash.command rewrite rides through", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "rw", mode: "print", flags: [rewrite("echo rewritten")] }]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.updatedInput).toEqual({ command: "echo rewritten" });
    expect(outcome.diagnostics).toEqual([]);
  });

  test("later hooks override the same field in config order", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "first", mode: "print", flags: [rewrite("echo first")] },
        { id: "second", mode: "print", flags: [rewrite("echo second")] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.updatedInput).toEqual({ command: "echo second" });
  });

  test("the outcome attributes which hooks contributed the rewrite, in config order (25 M9)", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "first", mode: "print", flags: [rewrite("echo first")] },
        { id: "second", mode: "print", flags: [rewrite("echo second")] },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.updatedInputHooks).toEqual([h.projectKey("first"), h.projectKey("second")]);
  });

  test("an unsupported field is rejected with a diagnostic and no update", async () => {
    const h = using(
      hooksRuntimeHarness([
        {
          id: "sneaky",
          mode: "print",
          flags: ['{"decision":"allow","updatedInput":{"cwd":"/"}}'],
        },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.updatedInput).toBeUndefined();
    expect(outcome.updatedInputHooks).toBeUndefined();
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: h.projectKey("sneaky"), reason: "updated_input_rejected" }),
    ]);
  });

  test("an unsupported tool is rejected with a diagnostic and no update", async () => {
    const h = using(
      hooksRuntimeHarness([
        {
          id: "sneaky",
          mode: "print",
          flags: ['{"decision":"allow","updatedInput":{"file_path":"/etc/hosts"}}'],
        },
      ]),
    );

    const outcome = await h.runtime.dispatchPreToolUse(
      preToolUsePayload({ toolName: "read", toolInput: { file_path: "a.txt" } }),
    );
    expect(outcome.updatedInput).toBeUndefined();
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: h.projectKey("sneaky"), reason: "updated_input_rejected" }),
    ]);
  });
});

describe("dispatchPreToolUse - non-blocking failures and stats (D-007)", () => {
  test("a failing hook is a diagnostic; the dispatch still allows", async () => {
    const h = using(hooksRuntimeHarness([{ id: "broken", mode: "fail", flags: ["boom", "2"] }]));
    const outcome = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: h.projectKey("broken"), reason: "command_failed" }),
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
      expect.objectContaining({ key: h.projectKey("broken"), runs: 1, failures: 1 }),
    ]);
  });
});

describe("statusSnapshot - the doctor-facing hooks picture (25 M9)", () => {
  test("reports every configured hook with its freshly evaluated trust status", async () => {
    const h = using(
      hooksRuntimeHarness(
        [
          { id: "fmt", mode: "print", flags: ['{"decision":"allow"}'] },
          { id: "new", mode: "print", flags: ['{"decision":"allow"}'], approved: false },
        ],
        [{ id: "audit", mode: "print", flags: ['{"decision":"allow"}'], event: "Stop" }],
      ),
    );

    const snapshot = h.runtime.statusSnapshot();
    expect(snapshot.hooks).toEqual([
      expect.objectContaining({
        key: h.projectKey("fmt"),
        event: "PreToolUse",
        source: "project",
        enabled: true,
        trust: "approved",
      }),
      expect.objectContaining({ key: h.projectKey("new"), trust: "unapproved" }),
      expect.objectContaining({ key: h.userKey("audit"), event: "Stop", trust: "approved" }),
    ]);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.legacy).toEqual([]);
  });
});

describe("hasHooks - the hot-path predicate (25 simplify E1)", () => {
  test("reports per-event presence off the cached discovery", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "pre", mode: "print", flags: ['{"decision":"allow"}'] }]),
    );
    expect(h.runtime.hasHooks("PreToolUse")).toBe(true);
    expect(h.runtime.hasHooks("Stop")).toBe(false);
  });

  test("a disabled hook does not count", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "off", mode: "print", flags: ['{"decision":"allow"}'], enabled: false },
      ]),
    );
    expect(h.runtime.hasHooks("PreToolUse")).toBe(false);
  });
});

describe("per-workspace project approvals (25 simplify S1)", () => {
  test("a project hook approved under workspace A is unapproved under workspace B", async () => {
    const root = mkdtempSync(join(tmpdir(), "belay-hooks-s1-"));
    try {
      // Two workspaces with BYTE-IDENTICAL project config (and the same fixture command), one
      // shared approvals file. Approval is granted under workspace A's key only.
      const marker = join(root, "executed-marker");
      const hooksJson = JSON.stringify({
        hooks: {
          rec: {
            event: "PreToolUse",
            command: HOOK_FIXTURE_COMMAND,
            args: hookFixtureArgs("record", [marker]),
          },
        },
      });
      const approvalsPath = join(root, "hook-approvals.json");
      const userConfigDir = join(root, "user-home");
      mkdirSync(userConfigDir, { recursive: true });
      const workspaces = ["ws-a", "ws-b"].map((name) => {
        const workspaceRoot = join(root, name);
        mkdirSync(join(workspaceRoot, ".belay"), { recursive: true });
        const projectHooksPath = join(workspaceRoot, ".belay", "hooks.json");
        writeFileSync(projectHooksPath, hooksJson);
        return { workspaceRoot, projectHooksPath };
      });
      const [wsA, wsB] = workspaces as [(typeof workspaces)[number], (typeof workspaces)[number]];

      const hook = discoverHooks({
        projectHooksPath: wsA.projectHooksPath,
        userHooksPath: join(userConfigDir, "hooks.json"),
      }).hooks[0];
      expect(hook).toBeDefined();
      if (!hook) {
        return;
      }
      saveHookApprovals(
        approveHook(
          EMPTY_HOOK_APPROVALS,
          hookApprovalKey(hook, wsA.workspaceRoot),
          computeHookTrustFingerprint(hook, wsA.workspaceRoot).hash,
        ),
        approvalsPath,
      );

      const runtimeFor = (ws: (typeof workspaces)[number]) =>
        createHooksRuntime({
          roots: {
            projectHooksPath: ws.projectHooksPath,
            userHooksPath: join(userConfigDir, "hooks.json"),
          },
          approvalsPath,
          workspaceRoot: ws.workspaceRoot,
          userConfigDir,
          legacyUserHooksDir: join(root, "legacy-user-hooks"),
        });

      // Workspace B: same bytes, different workspace - the gate stays closed.
      const inB = await runtimeFor(wsB).dispatchPreToolUse(preToolUsePayload());
      expect(inB.decision).toBe("allow");
      expect(inB.diagnostics).toEqual([
        expect.objectContaining({
          hook: hookApprovalKey(hook, wsB.workspaceRoot),
          reason: "unapproved",
        }),
      ]);
      expect(existsSync(marker)).toBe(false);

      // Workspace A: the approval applies and the hook executes.
      const inA = await runtimeFor(wsA).dispatchPreToolUse(preToolUsePayload());
      expect(inA.diagnostics).toEqual([]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trust fingerprint cache preserves re-close semantics (25 simplify E2)", () => {
  test("editing a referenced file between dispatches re-closes the gate as trust_changed", async () => {
    const h = using(
      hooksRuntimeHarness(
        [{ id: "gate", mode: "print", flags: ['{"decision":"allow"}', "./policy.json"] }],
        [],
        { workspaceFiles: { "policy.json": '{"allow":[]}' } },
      ),
    );

    const first = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(first.decision).toBe("allow");
    expect(first.diagnostics).toEqual([]);

    // A repeat dispatch with nothing changed still executes (the cached fingerprint is valid).
    const repeat = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(repeat.diagnostics).toEqual([]);

    writeFileSync(join(h.workspaceRoot, "policy.json"), '{"allow":["bash"],"edited":true}');
    const afterEdit = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(afterEdit.decision).toBe("allow");
    expect(afterEdit.diagnostics).toEqual([
      expect.objectContaining({ hook: h.projectKey("gate"), reason: "trust_changed" }),
    ]);
  });
});

describe("approvals re-read per dispatch (25 simplify E3)", () => {
  test("a fresh grant takes effect on the next dispatch without a runtime restart", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("late-approval.json")], approved: false },
      ]),
    );

    const before = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(before.diagnostics).toEqual([
      expect.objectContaining({ hook: h.projectKey("rec"), reason: "unapproved" }),
    ]);
    expect(existsSync(h.scratchPath("late-approval.json"))).toBe(false);

    // Grant the approval on disk exactly as an approval surface would, then dispatch again.
    const hook = h.runtime.discoveryReport().hooks[0];
    expect(hook).toBeDefined();
    if (!hook) {
      return;
    }
    saveHookApprovals(
      approveHook(
        EMPTY_HOOK_APPROVALS,
        h.projectKey("rec"),
        computeHookTrustFingerprint(hook, h.workspaceRoot).hash,
      ),
      h.approvalsPath,
    );

    const after = await h.runtime.dispatchPreToolUse(preToolUsePayload());
    expect(after.diagnostics).toEqual([]);
    expect(existsSync(h.scratchPath("late-approval.json"))).toBe(true);
  });
});

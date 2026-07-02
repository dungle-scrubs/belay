import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approvedHashFor,
  approveHook,
  canExecuteHook,
  EMPTY_HOOK_APPROVALS,
  hookApprovalKey,
  hookApprovalsPath,
  loadHookApprovals,
  revokeHookApproval,
  saveHookApprovals,
} from "./approval";
import { discoverHooks } from "./discovery";
import { computeHookTrustFingerprint, evaluateHookTrust, type HookTrustIo } from "./trust";

const PATH = "/state/hooks-approvals.json";

function fakeIo(files: Record<string, string>): HookTrustIo {
  return {
    isFile: (path) => files[path] !== undefined,
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return contents;
    },
  };
}

describe("approval state - pure transitions", () => {
  test("approve then lookup roundtrips the hash", () => {
    const state = approveHook(EMPTY_HOOK_APPROVALS, "project:guard", "sha256:abc", "2026-07-02");
    expect(approvedHashFor(state, "project:guard")).toBe("sha256:abc");
    expect(state.approvals["project:guard"]).toEqual({
      hash: "sha256:abc",
      approvedAt: "2026-07-02",
    });
  });

  test("re-approving replaces the stored hash", () => {
    const first = approveHook(EMPTY_HOOK_APPROVALS, "project:guard", "sha256:old", "t1");
    const second = approveHook(first, "project:guard", "sha256:new", "t2");
    expect(approvedHashFor(second, "project:guard")).toBe("sha256:new");
  });

  test("revoke removes the approval; unknown keys look up as undefined", () => {
    const approved = approveHook(EMPTY_HOOK_APPROVALS, "user:review", "sha256:abc", "t");
    const revoked = revokeHookApproval(approved, "user:review");
    expect(approvedHashFor(revoked, "user:review")).toBeUndefined();
    expect(approvedHashFor(revoked, "never:seen")).toBeUndefined();
  });

  test("transitions never mutate the input state", () => {
    const state = approveHook(EMPTY_HOOK_APPROVALS, "project:guard", "sha256:abc", "t");
    revokeHookApproval(state, "project:guard");
    expect(approvedHashFor(state, "project:guard")).toBe("sha256:abc");
    expect(EMPTY_HOOK_APPROVALS.approvals).toEqual({});
  });

  test("the approval key is <source>:<id>", () => {
    expect(hookApprovalKey({ source: "project", id: "guard" })).toBe("project:guard");
    expect(hookApprovalKey({ source: "user", id: "review" })).toBe("user:review");
  });
});

describe("approval state - persistence", () => {
  test("save writes pretty JSON that load reads back", () => {
    const written: Record<string, string> = {};
    const state = approveHook(EMPTY_HOOK_APPROVALS, "project:guard", "sha256:abc", "t");
    saveHookApprovals(state, PATH, (path, content) => {
      written[path] = content;
    });
    expect(written[PATH]?.endsWith("\n")).toBe(true);

    const loaded = loadHookApprovals(PATH, (path) => {
      const contents = written[path];
      if (contents === undefined) {
        throw new Error("ENOENT");
      }
      return contents;
    });
    expect(loaded).toEqual(state);
  });

  test("a missing or malformed file loads as empty approvals", () => {
    expect(
      loadHookApprovals(PATH, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual(EMPTY_HOOK_APPROVALS);
    expect(loadHookApprovals(PATH, () => "{ not json")).toEqual(EMPTY_HOOK_APPROVALS);
  });

  test("junk shapes and entries without a hash are dropped tolerantly", () => {
    expect(loadHookApprovals(PATH, () => JSON.stringify({ approvals: "nope" }))).toEqual(
      EMPTY_HOOK_APPROVALS,
    );
    const loaded = loadHookApprovals(PATH, () =>
      JSON.stringify({
        approvals: {
          "project:guard": { hash: "sha256:abc", approvedAt: "t" },
          "project:junk": { approvedAt: "t" },
          "project:worse": "yes",
        },
      }),
    );
    expect(Object.keys(loaded.approvals)).toEqual(["project:guard"]);
  });

  test("the default approvals path lives under the state root", () => {
    expect(hookApprovalsPath().endsWith("hooks-approvals.json")).toBe(true);
  });
});

describe("the execution gate (D-006): project/user hooks never execute before approval", () => {
  test("only the approved status may execute", () => {
    expect(canExecuteHook("approved")).toBe(true);
    expect(canExecuteHook("unapproved")).toBe(false);
    expect(canExecuteHook("changed")).toBe(false);
    expect(canExecuteHook("missing-script")).toBe(false);
  });

  test("a freshly discovered hook is gated until approved, then gated again when it changes", () => {
    const roots = {
      projectHooksPath: "/repo/.trevor/hooks.json",
      userHooksPath: "/home/user/.config-home/hooks.json",
    };
    const report = discoverHooks(roots, (path) => {
      if (path !== roots.projectHooksPath) {
        throw new Error("ENOENT");
      }
      return JSON.stringify({
        hooks: { guard: { event: "PreToolUse", command: "./guard.sh" } },
      });
    });
    const hook = report.hooks[0];
    expect(hook).toBeDefined();
    if (!hook) {
      return;
    }

    const script = resolve("/repo", "./guard.sh");
    const io = fakeIo({ [script]: "#!/bin/sh\nexit 0\n" });
    const fingerprint = computeHookTrustFingerprint(hook, "/repo", io);
    const key = hookApprovalKey(hook);

    // Before approval: discovered and diagnosable, but the gate is closed.
    const before = evaluateHookTrust(fingerprint, approvedHashFor(EMPTY_HOOK_APPROVALS, key));
    expect(before).toBe("unapproved");
    expect(canExecuteHook(before)).toBe(false);

    // Approval opens the gate for exactly this hash.
    const approved = approveHook(EMPTY_HOOK_APPROVALS, key, fingerprint.hash, "t");
    const after = evaluateHookTrust(fingerprint, approvedHashFor(approved, key));
    expect(after).toBe("approved");
    expect(canExecuteHook(after)).toBe(true);

    // An edited script re-closes the gate until re-approval.
    const edited = computeHookTrustFingerprint(
      hook,
      "/repo",
      fakeIo({ [script]: "#!/bin/sh\nexit 1\n" }),
    );
    const changed = evaluateHookTrust(edited, approvedHashFor(approved, key));
    expect(changed).toBe("changed");
    expect(canExecuteHook(changed)).toBe(false);
  });
});

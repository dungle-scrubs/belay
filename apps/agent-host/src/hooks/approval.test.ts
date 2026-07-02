import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approvedHashFor,
  approveHook,
  EMPTY_HOOK_APPROVALS,
  hookApprovalKey,
  hookApprovalsPath,
  loadHookApprovals,
  saveHookApprovals,
} from "./approval";
import { discoverHooks } from "./discovery";
import { computeHookTrustFingerprint, evaluateHookTrust, type HookTrustIo } from "./trust";

const PATH = "/state/hooks-approvals.json";
const WORKSPACE = "/repo";

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
    const state = approveHook(EMPTY_HOOK_APPROVALS, "user:guard", "sha256:abc", "2026-07-02");
    expect(approvedHashFor(state, "user:guard")).toBe("sha256:abc");
    expect(state.approvals["user:guard"]).toEqual({
      hash: "sha256:abc",
      approvedAt: "2026-07-02",
    });
  });

  test("re-approving replaces the stored hash", () => {
    const first = approveHook(EMPTY_HOOK_APPROVALS, "user:guard", "sha256:old", "t1");
    const second = approveHook(first, "user:guard", "sha256:new", "t2");
    expect(approvedHashFor(second, "user:guard")).toBe("sha256:new");
  });

  test("unknown keys look up as undefined and transitions never mutate the input state", () => {
    const state = approveHook(EMPTY_HOOK_APPROVALS, "user:review", "sha256:abc", "t");
    expect(approvedHashFor(state, "never:seen")).toBeUndefined();
    expect(approvedHashFor(state, "user:review")).toBe("sha256:abc");
    expect(EMPTY_HOOK_APPROVALS.approvals).toEqual({});
  });

  test("a user hook's key is workspace-independent; a project hook's key embeds the workspace", () => {
    expect(hookApprovalKey({ source: "user", id: "review" }, WORKSPACE)).toBe("user:review");
    expect(hookApprovalKey({ source: "user", id: "review" }, "/elsewhere")).toBe("user:review");
    expect(hookApprovalKey({ source: "project", id: "guard" }, WORKSPACE)).toBe(
      "project:/repo:guard",
    );
  });
});

describe("approval keys are per-workspace for project hooks (S1)", () => {
  test("the same project hook approved under workspace A is unapproved under workspace B", () => {
    const hook = { source: "project" as const, id: "guard" };
    const script = resolve(WORKSPACE, "./guard.sh");
    const io = fakeIo({ [script]: "#!/bin/sh\nexit 0\n" });
    const definition = {
      id: "guard",
      event: "PreToolUse" as const,
      command: "./guard.sh",
      args: [],
      timeoutMs: 5_000,
      enabled: true,
      source: "project" as const,
    };
    const fingerprint = computeHookTrustFingerprint(definition, WORKSPACE, io);

    const approvedInA = approveHook(
      EMPTY_HOOK_APPROVALS,
      hookApprovalKey(hook, "/repo-a"),
      fingerprint.hash,
      "t",
    );

    // Workspace A: approved. Workspace B (byte-identical config + script): still unapproved.
    expect(
      evaluateHookTrust(
        fingerprint,
        approvedHashFor(approvedInA, hookApprovalKey(hook, "/repo-a")),
      ),
    ).toBe("approved");
    expect(
      evaluateHookTrust(
        fingerprint,
        approvedHashFor(approvedInA, hookApprovalKey(hook, "/repo-b")),
      ),
    ).toBe("unapproved");
  });
});

describe("approval state - persistence", () => {
  test("save writes pretty JSON that load reads back", () => {
    const written: Record<string, string> = {};
    const state = approveHook(EMPTY_HOOK_APPROVALS, "user:guard", "sha256:abc", "t");
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
          "user:guard": { hash: "sha256:abc", approvedAt: "t" },
          "user:junk": { approvedAt: "t" },
          "user:worse": "yes",
        },
      }),
    );
    expect(Object.keys(loaded.approvals)).toEqual(["user:guard"]);
  });

  test("the default approvals path lives under the state root", () => {
    expect(hookApprovalsPath().endsWith("hooks-approvals.json")).toBe(true);
  });
});

describe("the execution gate (D-006): project/user hooks never execute before approval", () => {
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

    const script = resolve(WORKSPACE, "./guard.sh");
    const io = fakeIo({ [script]: "#!/bin/sh\nexit 0\n" });
    const fingerprint = computeHookTrustFingerprint(hook, WORKSPACE, io);
    const key = hookApprovalKey(hook, WORKSPACE);

    // Before approval: discovered and diagnosable, but the gate is closed.
    expect(evaluateHookTrust(fingerprint, approvedHashFor(EMPTY_HOOK_APPROVALS, key))).toBe(
      "unapproved",
    );

    // Approval opens the gate for exactly this hash.
    const approved = approveHook(EMPTY_HOOK_APPROVALS, key, fingerprint.hash, "t");
    expect(evaluateHookTrust(fingerprint, approvedHashFor(approved, key))).toBe("approved");

    // An edited script re-closes the gate until re-approval.
    const edited = computeHookTrustFingerprint(
      hook,
      WORKSPACE,
      fakeIo({ [script]: "#!/bin/sh\nexit 1\n" }),
    );
    expect(evaluateHookTrust(edited, approvedHashFor(approved, key))).toBe("changed");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_SCRIPT_BUDGETS,
  decodeToolScriptResult,
  isRetryableFailure,
  TOOL_SCRIPT_FAILURE_CLASSES,
  TOOL_SCRIPT_TOOLSETS,
  TOOLSET_TOOLS,
  type ToolScriptResult,
  validateToolScriptRequest,
} from "./tool-script";

describe("tool_script V2 contract - toolsets + validation (M1)", () => {
  it("names the read-only toolsets and maps each to concrete bridge tools", () => {
    expect(TOOL_SCRIPT_TOOLSETS).toContain("safe_read");
    // safe_read is the first-cut default: workspace-confined read/search only.
    expect(TOOLSET_TOOLS.safe_read).toEqual(["read", "glob", "grep", "ast_grep"]);
    // Every toolset's tools are a subset of some known read-only tool set (no write/shell here).
    for (const toolset of TOOL_SCRIPT_TOOLSETS) {
      for (const tool of TOOLSET_TOOLS[toolset]) {
        expect(["write", "edit", "bash", "process", "clipboard_write"]).not.toContain(tool);
      }
    }
  });

  it("accepts a well-formed request (preserving the V1 language/script/toolsets shape)", () => {
    const r = validateToolScriptRequest({
      language: "typescript",
      script: "return await tools.read({ path: 'a.ts' });",
      permissions: { toolsets: ["safe_read"] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.language).toBe("typescript");
      expect(r.request.permissions.toolsets).toEqual(["safe_read"]);
      // Budgets default when unspecified.
      expect(r.request.budgets).toEqual(DEFAULT_TOOL_SCRIPT_BUDGETS);
    }
  });

  it("rejects a non-typescript language, empty script, or unknown/empty toolset as a validation failure", () => {
    const cases = [
      { language: "python", script: "x", permissions: { toolsets: ["safe_read"] } },
      { language: "typescript", script: "   ", permissions: { toolsets: ["safe_read"] } },
      { language: "typescript", script: "x", permissions: { toolsets: [] } },
      { language: "typescript", script: "x", permissions: { toolsets: ["bash"] } },
    ];
    for (const raw of cases) {
      const r = validateToolScriptRequest(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failureClass).toBe("validation");
      }
    }
  });
});

describe("tool_script V2 failure classes (M1)", () => {
  it("is a SUPERSET of V1's four failure kinds plus the V2 sandbox/bridge/budget additions", () => {
    // V1 had exactly these (in-process); V2 keeps them and adds the sandbox/bridge/budget classes.
    for (const v1 of ["timeout", "cancelled", "syntax_error", "runtime_error"]) {
      expect(TOOL_SCRIPT_FAILURE_CLASSES).toContain(v1);
    }
    for (const v2 of [
      "validation",
      "sandbox_launch",
      "bridge_denied",
      "bridge_failed",
      "output_too_large",
      "budget_exhausted",
    ]) {
      expect(TOOL_SCRIPT_FAILURE_CLASSES).toContain(v2);
    }
  });

  it("classifies transient failures as retryable and deterministic script/policy errors as not", () => {
    // Transient: a fresh attempt could succeed.
    for (const f of ["timeout", "cancelled", "bridge_failed", "sandbox_launch"] as const) {
      expect(isRetryableFailure(f)).toBe(true);
    }
    // Deterministic: retrying the same script/permissions fails identically.
    for (const f of [
      "validation",
      "syntax_error",
      "runtime_error",
      "bridge_denied",
      "output_too_large",
      "budget_exhausted",
    ] as const) {
      expect(isRetryableFailure(f)).toBe(false);
    }
  });
});

describe("tool_script V2 result decoder (M1)", () => {
  const completed: ToolScriptResult = {
    status: "completed",
    result: { files: 3 },
    bridgeCalls: [
      { tool: "read", inputHash: "abc", outputBytes: 120, status: "ok", durationMs: 4 },
    ],
    artifacts: [],
    counters: { bridgeCalls: 1, outputBytes: 120, durationMs: 12 },
    sandboxMode: "child-process",
  };

  it("round-trips a completed result through the decoder", () => {
    const decoded = decodeToolScriptResult(JSON.parse(JSON.stringify(completed)));
    expect(decoded?.status).toBe("completed");
    expect(decoded?.bridgeCalls[0]?.tool).toBe("read");
    expect(decoded?.counters.bridgeCalls).toBe(1);
  });

  it("round-trips a failed result carrying its typed failure class + retryable flag", () => {
    const failed: ToolScriptResult = {
      status: "failed",
      failureClass: "timeout",
      retryable: true,
      error: "script exceeded 30000ms",
      bridgeCalls: [],
      artifacts: [],
      counters: { bridgeCalls: 0, outputBytes: 0, durationMs: 30000 },
      sandboxMode: "child-process",
    };
    const decoded = decodeToolScriptResult(JSON.parse(JSON.stringify(failed)));
    expect(decoded?.status).toBe("failed");
    if (decoded?.status === "failed") {
      expect(decoded.failureClass).toBe("timeout");
      expect(decoded.retryable).toBe(true);
    }
  });

  it("returns null for a payload that is not a tool_script result", () => {
    expect(decodeToolScriptResult({ status: "weird" })).toBeNull();
    expect(decodeToolScriptResult(null)).toBeNull();
  });
});

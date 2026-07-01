import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedTools, type BridgeExecute, createToolScriptBridge } from "./bridge";

/** Records which tools were actually executed (to prove a denied tool never reaches the registry). */
function spyExecute(output = "tool output"): { execute: BridgeExecute; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    execute: (tool) => {
      calls.push(tool);
      return Promise.resolve(output);
    },
  };
}

describe("tool_script toolset capability matrix (M5)", () => {
  it("computes the allowed tool set as the union of the requested toolsets", () => {
    expect([...allowedTools(["safe_read"])].sort()).toEqual(["ast_grep", "glob", "grep", "read"]);
    expect(allowedTools(["retrieval"]).has("session_recall")).toBe(true);
    expect([...allowedTools(["safe_read", "retrieval"])]).toContain("read");
    expect([...allowedTools(["safe_read", "retrieval"])]).toContain("session_recall");
  });

  it("routes an ALLOWED tool call through the host execute and returns its output", async () => {
    const { execute, calls } = spyExecute("file body");
    const bridge = createToolScriptBridge({ toolsets: ["safe_read"], execute, runId: "r1" });
    const response = await bridge.call("read", { path: "a.ts" });
    expect(response).toEqual({ status: "ok", output: "file body" });
    expect(calls).toEqual(["read"]);
  });

  it("DENIES a tool that is not in any requested toolset - before it ever executes", async () => {
    const { execute, calls } = spyExecute();
    const bridge = createToolScriptBridge({ toolsets: ["safe_read"], execute });
    for (const tool of ["write", "edit", "bash", "process", "clipboard_write", "archive_unpack"]) {
      const response = await bridge.call(tool, {});
      expect(response.status).toBe("denied");
    }
    // Nothing disallowed reached the registry.
    expect(calls).toEqual([]);
  });

  it("DENIES a read-only tool that belongs to a DIFFERENT, un-requested toolset", async () => {
    const { execute, calls } = spyExecute();
    // Only safe_read requested; session_recall lives in `retrieval`.
    const bridge = createToolScriptBridge({ toolsets: ["safe_read"], execute });
    expect((await bridge.call("session_recall", { query: "x" })).status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("DENIES an unknown tool + tolerates an unknown toolset (no tools exposed)", async () => {
    const { execute } = spyExecute();
    expect(
      (await createToolScriptBridge({ toolsets: ["safe_read"], execute }).call("made_up", {}))
        .status,
    ).toBe("denied");
    // A toolset that is not known contributes no tools.
    // biome-ignore lint/suspicious/noExplicitAny: exercising a defensive path with a bad toolset.
    expect(allowedTools(["nope" as any]).size).toBe(0);
  });

  it("reports a host execute exception as a bridge failure (not a silent success)", async () => {
    const bridge = createToolScriptBridge({
      toolsets: ["safe_read"],
      execute: () => Promise.reject(new Error("registry blew up")),
    });
    const response = await bridge.call("read", { path: "a" });
    expect(response.status).toBe("failed");
    expect(response.error).toContain("registry blew up");
  });
});

describe("tool_script bridge workspace confinement (M4 hardening)", () => {
  const ROOT = "/work/repo";
  function confinedBridge(): {
    bridge: ReturnType<typeof createToolScriptBridge>;
    calls: string[];
  } {
    const { execute, calls } = spyExecute("body");
    return {
      calls,
      bridge: createToolScriptBridge({ toolsets: ["safe_read"], execute, workspaceRoot: ROOT }),
    };
  }

  it("allows a read within the workspace root", async () => {
    const { bridge, calls } = confinedBridge();
    expect((await bridge.call("read", { path: "src/a.ts" })).status).toBe("ok");
    expect((await bridge.call("read", { path: `${ROOT}/src/a.ts` })).status).toBe("ok");
    expect(calls).toEqual(["read", "read"]);
  });

  it("DENIES a read of an absolute path outside the workspace - before it executes", async () => {
    const { bridge, calls } = confinedBridge();
    const response = await bridge.call("read", { path: "/etc/passwd" });
    expect(response.status).toBe("denied");
    expect(response.error).toContain("escapes the workspace root");
    expect(calls).toEqual([]);
  });

  it("DENIES a read that climbs out with ../", async () => {
    const { bridge, calls } = confinedBridge();
    expect((await bridge.call("read", { path: "../../secrets.txt" })).status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("DENIES an escaping glob pattern and an escaping ast_grep path/glob", async () => {
    const { bridge } = confinedBridge();
    expect((await bridge.call("glob", { pattern: "../../**/*.ts" })).status).toBe("denied");
    expect((await bridge.call("grep", { pattern: "x", glob: "../../**" })).status).toBe("denied");
    expect((await bridge.call("ast_grep", { pattern: "$X", paths: ["/etc"] })).status).toBe(
      "denied",
    );
    expect((await bridge.call("ast_grep", { pattern: "$X", globs: ["../../**"] })).status).toBe(
      "denied",
    );
  });

  it("does NOT confine the grep REGEX pattern (only its file glob)", async () => {
    const { bridge, calls } = confinedBridge();
    // A regex that looks path-like is not a path; the glob stays inside, so the call runs.
    expect((await bridge.call("grep", { pattern: "../foo", glob: "src/**" })).status).toBe("ok");
    expect(calls).toEqual(["grep"]);
  });
});

describe("tool_script bridge SYMLINK confinement (M4 hardening)", () => {
  // A symlink inside the workspace pointing OUTSIDE it must not become a read escape: bridge reads run in
  // the privileged host and follow symlinks, so a lexical check would be bypassable (the merge-blocking
  // finding). The confinement realpath-resolves each path, so a symlinked path is denied by its true target.
  let workspace: string;
  let outside: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "trevor-ts-ws-"));
    outside = mkdtempSync(join(tmpdir(), "trevor-ts-secret-"));
    writeFileSync(join(outside, "id_rsa"), "TOP SECRET KEY");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;");
    // A planted symlink inside the workspace whose target is the outside secret directory.
    symlinkSync(outside, join(workspace, "link"));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function bridgeFor(root: string): {
    bridge: ReturnType<typeof createToolScriptBridge>;
    calls: string[];
  } {
    const { execute, calls } = spyExecute("body");
    return {
      calls,
      bridge: createToolScriptBridge({ toolsets: ["safe_read"], execute, workspaceRoot: root }),
    };
  }

  it("DENIES a read that reaches outside via an in-workspace symlink - before it executes", async () => {
    const { bridge, calls } = bridgeFor(workspace);
    const response = await bridge.call("read", { path: "link/id_rsa" });
    expect(response.status).toBe("denied");
    expect(response.error).toContain("escapes the workspace root");
    // The privileged host read never ran.
    expect(calls).toEqual([]);
  });

  it("DENIES the `..`-through-symlink desync: link/../x is lexically in-workspace but escapes at read time", async () => {
    // The subtle bypass: `resolve()` cancels `link/..` as a string BEFORE following the symlink, so a lexical
    // check thinks the path is in-workspace; but readFile follows `link` FIRST, then `..` climbs out of the
    // target's parent. Reading `link/../<secret-dir>/id_rsa` round-trips back to the outside secret.
    const { bridge, calls } = bridgeFor(workspace);
    const viaDotDot = await bridge.call("read", { path: `link/../${basename(outside)}/id_rsa` });
    expect(viaDotDot.status).toBe("denied");
    expect(viaDotDot.error).toContain("escapes the workspace root");
    // Even a non-existent tail escapes: link/.. already resolves (via the symlink) outside the workspace.
    expect((await bridge.call("read", { path: "link/../whatever" })).status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("DENIES a glob whose pattern reaches outside via the symlinked directory", async () => {
    const { bridge } = bridgeFor(workspace);
    expect((await bridge.call("glob", { pattern: "link/*" })).status).toBe("denied");
  });

  it("still ALLOWS a genuine file inside the workspace", async () => {
    const { bridge, calls } = bridgeFor(workspace);
    expect((await bridge.call("read", { path: "src/a.ts" })).status).toBe("ok");
    expect(calls).toEqual(["read"]);
  });
});

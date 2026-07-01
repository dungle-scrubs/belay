import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { buildToolScriptTool, type ToolScriptToolDeps } from "../../src/tool-script/tool";

/**
 * End-to-end M7: the REAL `tool_script` tool - real out-of-process child, real launch resolution (degrading
 * to child-process where the sandbox can't boot), the toolset-gated bridge over an injected `execute`. Runs
 * the full loop for a successful script, a routed read, a denied bridge call, and a syntax error.
 */

function toolWith(execute: ToolScriptToolDeps["execute"]) {
  return buildToolScriptTool({
    execute,
    cwd: process.cwd(),
    makeScratchDir: () => mkdtempSync(join(tmpdir(), "trevor-ts-it-")),
    cleanupScratchDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  });
}

const echo = (): Promise<string> => Promise.resolve("file body");

describe("tool_script tool end-to-end (M7)", () => {
  it("runs a successful batch script out-of-process and returns its result", async () => {
    const out = await Effect.runPromise(
      toolWith(echo).execute({ script: "return 6 * 7;", toolsets: ["safe_read"] }, undefined),
    );
    expect(out).toBe("42");
  });

  it("routes an allowed read through the bridge and returns the aggregate", async () => {
    const out = await Effect.runPromise(
      toolWith(echo).execute(
        {
          script: "const a = await tools.read({ path: 'x' }); return a.length;",
          toolsets: ["safe_read"],
        },
        undefined,
      ),
    );
    expect(out).toBe(String("file body".length));
  });

  it("DENIES a tool outside the requested toolset - the script sees a bridge_denied failure", async () => {
    const out = await Effect.runPromise(
      toolWith(echo).execute(
        { script: "return await tools.bash({ cmd: 'ls' });", toolsets: ["safe_read"] },
        undefined,
      ),
    );
    expect(out).toContain("error: tool_script bridge_denied");
  });

  it("reports a syntax error as a typed failure", async () => {
    const out = await Effect.runPromise(
      toolWith(echo).execute(
        { script: "this is not valid ((", toolsets: ["safe_read"] },
        undefined,
      ),
    );
    expect(out).toContain("error: tool_script syntax_error");
  });
}, 30_000);

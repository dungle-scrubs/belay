import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTool } from "../../src/tools/index";

/**
 * Hermetic END-TO-END for tool_script (plan 16, M9): drives the REAL registry entry - a script that batch
 * scans several real files through the REAL `read` tool bridge, entirely out-of-process. This exercises the
 * whole path (registry executeTool -> tool_script -> child runner -> toolset bridge -> real read tool -> real
 * fs) with nothing faked, the way the model's loop invokes it.
 */

let dir: string;
let priorAllow: string | undefined;

beforeAll(() => {
  // Inside the workspace root: the bridge confines tool_script reads to the workspace, so the fixtures
  // (which the script reads by absolute path) must live under it. mkdtemp keeps the run hermetic.
  dir = mkdtempSync(join(WORKSPACE_ROOT, "trevor-ts-e2e-"));
  writeFileSync(join(dir, "a.txt"), "alpha\nalpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  writeFileSync(join(dir, "c.txt"), "gammagamma");
  // On a host where the Seatbelt profile cannot boot Node, tool_script fails closed by default. This
  // e2e legitimately exercises the reduced-isolation child-process path, so it opts in explicitly.
  priorAllow = process.env.TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED;
  process.env.TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED = "1";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (priorAllow === undefined) {
    delete process.env.TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED;
  } else {
    process.env.TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED = priorAllow;
  }
});

describe("tool_script hermetic e2e (M9)", () => {
  it("batch-scans multiple files through the real read bridge and returns an aggregate", async () => {
    const script = `
      const files = ${JSON.stringify([join(dir, "a.txt"), join(dir, "b.txt"), join(dir, "c.txt")])};
      const sizes = [];
      for (const path of files) {
        const body = await tools.read({ path });
        sizes.push(body.trim().length);
      }
      return { count: sizes.length, total: sizes.reduce((a, b) => a + b, 0) };
    `;
    const out = await Effect.runPromise(
      executeTool("tool_script", JSON.stringify({ script, toolsets: ["safe_read"] })),
    );
    const parsed = JSON.parse(out) as { count: number; total: number };
    expect(parsed.count).toBe(3);
    // "alpha\nalpha" trims to "alpha\nalpha" (11), "beta" (4), "gammagamma" (10) = 25.
    expect(parsed.total).toBe(25);
  });

  it("denies a mutating tool from inside a script even end-to-end (write is not in safe_read)", async () => {
    const script = `return await tools.write({ path: ${JSON.stringify(join(dir, "hack.txt"))}, content: "x" });`;
    const out = await Effect.runPromise(
      executeTool("tool_script", JSON.stringify({ script, toolsets: ["safe_read"] })),
    );
    expect(out).toContain("error: tool_script bridge_denied");
    // The denied write never happened.
    expect(() => rmSync(join(dir, "hack.txt"))).toThrow();
  });
}, 30_000);

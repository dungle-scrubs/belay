import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS, normalizeHooksConfig } from "@host/hooks/config";
import { describe, expect, test } from "vitest";
import { type HooksRuntimeHarness, hooksRuntimeHarness } from "./runtime-fixture";

/**
 * Plan 25 M10 (D-008): the exclusion net. Hooks are a NARROW command-hook runtime, not a plugin
 * system - this suite pins that the excluded surfaces stay absent: the config schema is exactly
 * the two first-cut events (every other lifecycle/plugin/routing event name is rejected as
 * data), the runtime exposes exactly two dispatch entry points, and the src/hooks sources carry
 * no PostToolUse surface, no plugin/extension API, no model-routing seam, and no shell
 * execution path (the M3 no-shell-splitting behavior proof lives in test/hooks/runner.test.ts
 * "argv" cases; here the source-level guard pins that `spawn(command, args)` with no shell
 * option stays the ONLY execution primitive).
 *
 * Responsible for: proving the D-008 exclusions hold at the schema, runtime-surface, and
 * source levels.
 * Not for: behavioral runner coverage - ./runner.test.ts - or config normalization details -
 * src/hooks/config.test.ts.
 */

const HOOKS_SRC = join(import.meta.dirname, "..", "..", "src", "hooks");

/** Every src/hooks SOURCE file's text, keyed by filename. Co-located tests are excluded: they
 *  legitimately name the excluded surfaces (e.g. asserting PostToolUse is rejected). */
function hooksSources(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(HOOKS_SRC)) {
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      files.set(name, readFileSync(join(HOOKS_SRC, name), "utf8"));
    }
  }
  return files;
}

describe("config schema - only the two first-cut events exist (D-002/D-008)", () => {
  test("the hook event union is exactly PreToolUse and Stop", () => {
    expect([...HOOK_EVENTS]).toEqual(["PreToolUse", "Stop"]);
  });

  test("every excluded or invented event name is rejected as data with a diagnostic", () => {
    // The D-008 exclusion list as event names a config might try: the V1/Claude-style
    // lifecycle events, plugin/extension dispatch, model routing, and daemon shapes.
    const excluded = [
      "PostToolUse",
      "PostToolUseFailure",
      "UserPromptSubmit",
      "Notification",
      "SessionStart",
      "SessionEnd",
      "SubagentStop",
      "PreCompact",
      "ModelRouting",
      "RouteModel",
      "Extension",
      "Plugin",
      "Daemon",
    ];
    for (const event of excluded) {
      const { hooks, issues } = normalizeHooksConfig(
        { hooks: { x: { event, command: "./x.sh" } } },
        "project",
      );
      expect(hooks).toEqual([]);
      expect(issues).toEqual([expect.objectContaining({ kind: "unknown_event", hook: "x" })]);
      // The diagnostic names the supported set, so a migrating config gets steered.
      expect(issues[0]?.detail).toContain('"PreToolUse"');
      expect(issues[0]?.detail).toContain('"Stop"');
    }
  });
});

describe("runtime surface - exactly two dispatch entry points (D-008)", () => {
  let harness: HooksRuntimeHarness | undefined;

  test("the hooks runtime exposes dispatchPreToolUse and dispatchStop and nothing else dispatchable", () => {
    harness = hooksRuntimeHarness([]);
    const keys = Object.keys(harness.runtime).sort();
    expect(keys).toEqual([
      "discoveryReport",
      "dispatchPreToolUse",
      "dispatchStop",
      "statsSnapshot",
      "statusSnapshot",
    ]);
    expect(keys.filter((key) => key.startsWith("dispatch"))).toEqual([
      "dispatchPreToolUse",
      "dispatchStop",
    ]);
    harness.cleanup();
    harness = undefined;
  });
});

describe("source-level guards - the excluded surfaces are absent from src/hooks (D-008)", () => {
  test("no PostToolUse (or any post-tool dispatch) exists anywhere in the hooks sources", () => {
    for (const [name, text] of hooksSources()) {
      expect(text.includes("PostToolUse"), `${name} must not mention PostToolUse`).toBe(false);
    }
  });

  test("no shell execution path exists: spawn without a shell is the only primitive (D-005)", () => {
    for (const [name, text] of hooksSources()) {
      expect(/shell\s*:\s*true/.test(text), `${name} must never spawn a shell`).toBe(false);
      expect(
        /\bexecSync?\(|\bexecFile\(/.test(text),
        `${name} must not use exec/execSync/execFile`,
      ).toBe(false);
    }
    // The runner's one execution primitive is the no-shell spawn of the explicit argv array;
    // the behavioral proof (args arrive verbatim, no word splitting) is runner.test.ts "argv".
    const runner = hooksSources().get("runner.ts") ?? "";
    expect(runner).toContain("spawn(hook.command, [...hook.args]");
  });

  test("no plugin/extension registration or model-routing seam exists in the hooks sources", () => {
    for (const [name, text] of hooksSources()) {
      expect(
        /registerPlugin|loadExtension|nativeExtension|routeModel|modelRouting/i.test(text),
        `${name} must expose no plugin/extension/model-routing surface`,
      ).toBe(false);
    }
  });
});

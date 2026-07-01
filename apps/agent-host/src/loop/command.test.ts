import { describe, expect, it } from "vitest";
import { buildCommandRegistry, type CommandContext } from "../commands";
import { buildLoopCommands, describeLoopParse } from "./command";

/**
 * The host-owned `/loop` command surface (plan 17, M1): an explicit command-text submission - the only
 * thing a headless client can send - is parsed authoritatively by the host and answered with a structured,
 * UI-neutral result. No builder UI, no model.
 */

// A minimal CommandContext; the loop commands read no context slice.
const ctx = {} as CommandContext;

describe("host /loop command registration (M1)", () => {
  it("announces both /loop and /loops in the command registry specs", () => {
    const registry = buildCommandRegistry();
    const names = registry.specs.map((spec) => spec.name);
    expect(names).toContain("/loop");
    expect(names).toContain("/loops");
  });

  it("builds exactly the /loop and /loops entries", () => {
    expect(buildLoopCommands().map((command) => command.spec.name)).toEqual(["/loop", "/loops"]);
  });
});

describe("host /loop explicit-text handling (M1)", () => {
  it("answers a ready creation submission with a structured create result", async () => {
    const registry = buildCommandRegistry();
    const result = await registry.run("/loop", 'max 5 do "run the test suite"', ctx);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("action: create");
    expect(result.text).toContain("ready");
    expect(result.text).toContain("Max: 5");
    expect(result.text).toContain("run the test suite");
  });

  it("answers an unbounded/actionless submission with the missing requirements", async () => {
    const registry = buildCommandRegistry();
    const result = await registry.run("/loop", 'do ""', ctx);
    expect(result.text).toContain("not ready");
    expect(result.text).toContain("missing");
    // No action and no bound: both are reported.
    expect(result.text).toContain("action");
    expect(result.text).toContain("bound");
  });

  it("surfaces a value diagnostic (invalid max) in the structured result", () => {
    const text = describeLoopParse('/loop max zero do "x"');
    expect(text).toContain("not ready");
    expect(text.toLowerCase()).toContain("max");
  });

  it("routes a control verb to its action with the target loop id", () => {
    expect(describeLoopParse("/loop stop loop_7")).toContain("action: stop");
    expect(describeLoopParse("/loop stop loop_7")).toContain("loop_7");
  });

  it("prompts for usage when a control verb has no id", () => {
    expect(describeLoopParse("/loop pause")).toContain("usage: /loop pause <id>");
  });

  it("resolves /loops (list) via the registry", async () => {
    const registry = buildCommandRegistry();
    const result = await registry.run("/loops", "list", ctx);
    expect(result.text).toContain("action: list");
  });
});

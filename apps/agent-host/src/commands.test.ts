import assert from "node:assert/strict";
import { test } from "vitest";
import { buildCommandRegistry, type CommandContext } from "./commands";

/**
 * The /compact command (Phase 3 / D-040): the immediate command lane triggers the host's
 * compaction hook and reports its result, and degrades gracefully when the host cannot compact.
 */

const baseCtx: CommandContext = {
  providers: {},
  cwd: "~",
  workspace: "~",
  instanceId: "abc",
  role: "leader",
};

test("/compact is announced and invokes the host compaction hook, returning its result", async () => {
  const registry = buildCommandRegistry();
  assert.ok(
    registry.specs.some((spec) => spec.name === "/compact"),
    "/compact is in the announced inventory",
  );

  let calls = 0;
  const { text, ok } = await registry.run("/compact", "", {
    ...baseCtx,
    compact: async () => {
      calls += 1;
      return "✓ compacted ~50000 → ~22000 tokens";
    },
  });
  assert.equal(calls, 1, "the host hook ran");
  assert.equal(ok, true);
  assert.match(text, /compacted ~50000 → ~22000 tokens/);
});

test("/compact reports unavailability when the host offers no compaction hook", async () => {
  const registry = buildCommandRegistry();
  const { text, ok } = await registry.run("/compact", "", baseCtx); // no compact hook
  assert.equal(ok, true);
  assert.match(text, /unavailable/i);
});

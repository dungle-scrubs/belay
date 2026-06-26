import assert from "node:assert/strict";
import { test } from "vitest";
import { buildCommandRegistry, type CommandContext } from "./commands";
import { buildSkillCommand } from "./skills";

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

test("/cd is announced as a host-owned workspace switch command", async () => {
  const registry = buildCommandRegistry();
  const spec = registry.specs.find((item) => item.name === "/cd");
  assert.equal(spec?.usage, "/cd <directory>");

  const { text, ok } = await registry.run("/cd", "/tmp", baseCtx);
  assert.equal(ok, true);
  assert.match(text, /handled by the live host/i);
});

/**
 * /skills (M7 / D-010): its construction moved into skills.ts (buildSkillCommand), so commands.ts
 * no longer imports skill-discovery internals. Pin that the relocated builder is wired into the
 * registry and produces output, and that it reads no runtime context.
 */

test("/skills is announced and runs via the relocated builder", async () => {
  const registry = buildCommandRegistry();
  assert.ok(
    registry.specs.some((spec) => spec.name === "/skills"),
    "/skills is in the announced inventory",
  );
  const { text, ok } = await registry.run("/skills", "", baseCtx);
  assert.equal(ok, true);
  // Either a "No skills found in <dir>." line or a newline-joined list - always a non-empty string.
  assert.ok(text.length > 0);
});

test("buildSkillCommand owns the /skills spec and needs no context", () => {
  const command = buildSkillCommand();
  assert.equal(command.spec.name, "/skills");
  // It reads no runtime context, so its result is independent of any CommandContext.
  const out = command.run("", command.select(baseCtx));
  assert.equal(typeof out, "string");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSkillCommand } from "@host/skills/skills";
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

function tree(): string {
  return mkdtempSync(join(tmpdir(), "init-command-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

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

test("/init drafts AGENTS.md from repo evidence without writing", async () => {
  const root = tree();
  write(join(root, "README.md"), "# Demo");
  write(
    join(root, "package.json"),
    JSON.stringify({ scripts: { lint: "biome check .", test: "vitest run" } }),
  );
  write(join(root, "vitest.config.ts"), "export default {};");
  write(join(root, "apps", "AGENTS.md"), "nested");
  write(join(root, ".trevor", "rules", "review.md"), "---\nid: review\n---\nRun tests.");
  write(join(root, "CLAUDE.md"), "legacy");

  const registry = buildCommandRegistry();
  const { text, ok } = await registry.run("/init", "", { ...baseCtx, cwd: root, workspace: root });

  assert.equal(ok, true);
  assert.match(text, /No files were written/);
  assert.match(text, /README\.md/);
  assert.match(text, /pnpm lint/);
  assert.match(text, /vitest\.config\.ts/);
  assert.match(text, /apps\/AGENTS\.md/);
  assert.match(text, /\.trevor\/rules\/review\.md/);
  assert.match(text, /CLAUDE\.md/);
  assert.equal(text.includes("```markdown"), true);
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

test("/clip is announced as a host-owned command with its optional request usage (06 M2)", async () => {
  const registry = buildCommandRegistry();
  const spec = registry.specs.find((item) => item.name === "/clip");
  assert.ok(spec, "/clip is in the announced inventory");
  assert.equal(spec.usage, "/clip [request]");

  // The spec itself is host-owned (the live host runs the copy / restricted turn); the registry
  // runner just reports that, never copying or starting a turn here.
  const { ok, text } = await registry.run("/clip", "", baseCtx);
  assert.equal(ok, true);
  assert.match(text, /handled by the live host/i);
});

test("/handoff is announced in the inventory with its generate/direct usage (02 M1)", () => {
  const registry = buildCommandRegistry();
  const spec = registry.specs.find((item) => item.name === "/handoff");
  assert.ok(spec, "/handoff is in the announced inventory");
  assert.match(spec.usage ?? "", /--generate/);
  assert.match(spec.usage ?? "", /--direct/);
});

test("/style is announced and bare /style returns a nested command-menu payload (03 M3)", async () => {
  const registry = buildCommandRegistry();
  assert.ok(
    registry.specs.some((spec) => spec.name === "/style"),
    "/style is announced",
  );
  const { ok, menu } = await registry.run("/style", "", baseCtx);
  assert.equal(ok, true);
  assert.equal(menu?.family, "style");
  assert.ok((menu?.rows.length ?? 0) > 0, "the menu carries style rows from host data");
});

test("/vim is announced, and an unrecognized argument is a usage error that persists nothing (07 M4)", async () => {
  const registry = buildCommandRegistry();
  assert.ok(
    registry.specs.some((spec) => spec.name === "/vim"),
    "/vim is announced so the slash menu + palette can surface it",
  );
  // A bad arg short-circuits before saveVimPref, so this never touches the real config home.
  const { ok, text } = await registry.run("/vim", "definitely-not-a-toggle", baseCtx);
  assert.equal(ok, false);
  assert.match(text, /usage: \/vim/);
});

test("an unknown /style id is a plain error result with no menu (03 M3)", async () => {
  const registry = buildCommandRegistry();
  const { ok, menu } = await registry.run("/style", "definitely-not-a-style", baseCtx);
  assert.equal(ok, false);
  assert.equal(menu, undefined);
});

test("a plain command result carries no menu, unchanged (03 M1 backward-compat)", async () => {
  const registry = buildCommandRegistry();
  const { ok, menu, text } = await registry.run("/help", "", baseCtx);
  assert.equal(ok, true);
  assert.equal(menu, undefined);
  assert.ok(text.length > 0);
});

test("/doctor's select threads the MCP rollup through to the snapshot (plan 23 M8)", async () => {
  const registry = buildCommandRegistry();
  const { ok, text } = await registry.run("/doctor", "", {
    ...baseCtx,
    mcp: { kind: "auth-needed", detail: 'MCP server "linear" needs authentication' },
  });
  assert.equal(ok, true);
  const areas = JSON.parse(text).areas as { id: string; status: string; verdict: string }[];
  const mcp = areas.find((area) => area.id === "mcp");
  assert.equal(mcp?.status, "warn", "the injected MCP state survives the command's context slice");
  assert.match(mcp?.verdict ?? "", /"linear"/);
});

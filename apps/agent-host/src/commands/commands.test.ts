import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { supervisor } from "@host/processes/processes";
import { buildSkillCommand } from "@host/skills/skills";
import { afterEach, test } from "vitest";
import { buildCommandRegistry, type CommandContext } from "./commands";

/**
 * The /compact command (Phase 3 / D-040): the immediate command lane triggers the host's
 * compaction hook and reports its result, and degrades gracefully when the host cannot compact.
 */

const baseCtx: CommandContext = {
  providers: {},
  cwd: "~",
  doctor: {
    cwd: "~",
    workspace: "~",
    instanceId: "abc",
    role: "leader",
  },
};

afterEach(() => {
  supervisor.killAll();
  supervisor.clearCompleted();
});

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

test("/clear and /cd are retired from the announced specs (plan 58 M4)", () => {
  const registry = buildCommandRegistry();
  assert.equal(
    registry.specs.find((s) => s.name === "/clear"),
    undefined,
  );
  assert.equal(
    registry.specs.find((s) => s.name === "/cd"),
    undefined,
  );
});

test("/worktree-* are announced as host-owned specs so they are typeable from the prompt", () => {
  const registry = buildCommandRegistry();
  const names = registry.specs.filter((s) => s.name.startsWith("/worktree-"));
  assert.deepEqual(
    names.map((s) => s.name).sort(),
    [
      "/worktree-delete",
      "/worktree-merge",
      "/worktree-new",
      "/worktree-reconcile",
      "/worktree-switch",
    ],
    "all five /worktree-* commands are in the announced inventory",
  );
  // /worktree-new carries a usage so the menu shows the <branch> argument.
  const newSpec = registry.specs.find((s) => s.name === "/worktree-new");
  assert.match(newSpec?.usage ?? "", /<branch>/);
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
  write(join(root, ".belay", "rules", "review.md"), "---\nid: review\n---\nRun tests.");
  write(join(root, "CLAUDE.md"), "legacy");

  const registry = buildCommandRegistry();
  const { text, ok } = await registry.run("/init", "", { ...baseCtx, cwd: root });

  assert.equal(ok, true);
  assert.match(text, /No files were written/);
  assert.match(text, /README\.md/);
  assert.match(text, /pnpm lint/);
  assert.match(text, /vitest\.config\.ts/);
  assert.match(text, /apps\/AGENTS\.md/);
  assert.match(text, /\.belay\/rules\/review\.md/);
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
    doctor: {
      ...baseCtx.doctor,
      mcp: { kind: "auth-needed", detail: 'MCP server "linear" needs authentication' },
    },
  });
  assert.equal(ok, true);
  const areas = JSON.parse(text).areas as { id: string; status: string; verdict: string }[];
  const mcp = areas.find((area) => area.id === "mcp");
  assert.equal(mcp?.status, "warn", "the injected MCP state survives the command's context slice");
  assert.match(mcp?.verdict ?? "", /"linear"/);
});

test("/jobs-dismiss removes a completed job and refuses running or unknown jobs", async () => {
  const registry = buildCommandRegistry();
  const completed = supervisor.start("true", process.cwd()).id;
  const running = supervisor.start("sleep 5", process.cwd()).id;
  await supervisor.awaitExit(completed);

  const dismissed = await registry.run("/jobs-dismiss", completed, baseCtx);
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.text, `${completed} dismissed`);
  assert.equal(
    supervisor.list().find((job) => job.id === completed),
    undefined,
    "dismissed jobs leave /jobs",
  );

  const runningResult = await registry.run("/jobs-dismiss", running, baseCtx);
  assert.equal(runningResult.ok, false);
  assert.match(runningResult.text, /stop it first/u);
  assert.equal(supervisor.list().find((job) => job.id === running)?.status, "running");

  const unknown = await registry.run("/jobs-dismiss", "nope", baseCtx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /no such process "nope"/u);
});

test("/jobs-clear-completed removes terminal jobs and reports a concise count", async () => {
  const registry = buildCommandRegistry();
  const completed = supervisor.start("true", process.cwd()).id;
  const killed = supervisor.start("sleep 5", process.cwd()).id;
  const running = supervisor.start("sleep 5", process.cwd()).id;
  supervisor.kill(killed);
  await supervisor.awaitExit(completed);

  const result = await registry.run("/jobs-clear-completed", "", baseCtx);

  assert.equal(result.ok, true);
  assert.equal(result.text, "Dismissed 2 completed jobs.");
  assert.equal(
    supervisor.list().find((job) => job.id === completed),
    undefined,
  );
  assert.equal(
    supervisor.list().find((job) => job.id === killed),
    undefined,
  );
  assert.equal(supervisor.list().find((job) => job.id === running)?.status, "running");
});

test("a loaded command file is announced as a spec and resolvable via commandFile (44.5 M4)", () => {
  const registry = buildCommandRegistry([
    { id: "/fix", rootKind: "project", body: "Fix issue #$0", summary: "fix an issue" },
  ]);
  const spec = registry.specs.find((s) => s.name === "/fix");
  assert.equal(spec?.summary, "fix an issue");
  assert.equal(registry.commandFile("/fix")?.body, "Fix issue #$0");
  // A built-in command is NOT a command file - it dispatches through run(), not the SUBMIT branch.
  assert.equal(registry.commandFile("/help"), undefined);
});

test("a loaded command file carrying an argument-hint announces it on its spec (44.5 M5)", () => {
  const registry = buildCommandRegistry([
    { id: "/fix", rootKind: "project", body: "Fix #$0", summary: "fix", argumentHint: "<issue>" },
  ]);
  assert.equal(registry.specs.find((s) => s.name === "/fix")?.argumentHint, "<issue>");
});

test("a loaded command file cannot shadow a built-in command of the same name", () => {
  const registry = buildCommandRegistry([
    { id: "/help", rootKind: "project", body: "not the real help", summary: "x" },
  ]);
  // The built-in /help spec is the only one, and /help is not treated as a submit-branch command file.
  assert.equal(registry.specs.filter((s) => s.name === "/help").length, 1);
  assert.equal(registry.commandFile("/help"), undefined);
});

test("a loaded command file matching a reserved name is dropped, never announced (44.5 simplify)", () => {
  const registry = buildCommandRegistry(
    [{ id: "/restart", rootKind: "project", body: "not the real restart", summary: "x" }],
    new Set(["/restart"]),
  );
  // A reserved name is owned by a handler outside the registry (a programmatic/debug command). The file
  // is neither announced as a spec (no double-listing) nor routed through the SUBMIT branch - dispatch
  // reaches the real handler.
  assert.equal(registry.specs.filter((s) => s.name === "/restart").length, 0);
  assert.equal(registry.commandFile("/restart"), undefined);
});

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultHookDiscoveryRoots, discoverHooks, PROJECT_HOOKS_FILE } from "./discovery";

const roots = {
  projectHooksPath: "/repo/.belay/hooks.json",
  userHooksPath: "/home/user/.config-home/hooks.json",
};

function readFrom(files: Record<string, unknown>): (path: string) => string {
  return (path) => {
    const value = files[path];
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  };
}

const projectFile = {
  hooks: {
    guard: { event: "PreToolUse", command: "./scripts/guard.sh", args: [] },
  },
};

const userFile = {
  hooks: {
    review: { event: "Stop", command: "node", args: ["./review.mjs"] },
  },
};

describe("discoverHooks - order and provenance", () => {
  test("project hooks come before user hooks, each stamped with its source", () => {
    const report = discoverHooks(
      roots,
      readFrom({ [roots.projectHooksPath]: projectFile, [roots.userHooksPath]: userFile }),
    );
    expect(report.hooks.map((hook) => [hook.id, hook.source])).toEqual([
      ["guard", "project"],
      ["review", "user"],
    ]);
    expect(report.issues).toEqual([]);
  });

  test("the report names every consulted root with its source", () => {
    const report = discoverHooks(roots, readFrom({}));
    expect(report.roots).toEqual([
      { source: "project", path: roots.projectHooksPath },
      { source: "user", path: roots.userHooksPath },
    ]);
  });

  test("discovery is deterministic: repeated runs yield the same order", () => {
    const read = readFrom({
      [roots.projectHooksPath]: projectFile,
      [roots.userHooksPath]: userFile,
    });
    const first = discoverHooks(roots, read);
    const second = discoverHooks(roots, read);
    expect(second).toEqual(first);
  });

  test("the same id in both roots keeps both entries, distinguished by source", () => {
    const report = discoverHooks(
      roots,
      readFrom({
        [roots.projectHooksPath]: {
          hooks: { fmt: { event: "Stop", command: "./project-fmt.sh" } },
        },
        [roots.userHooksPath]: {
          hooks: { fmt: { event: "Stop", command: "./user-fmt.sh" } },
        },
      }),
    );
    expect(report.hooks.map((hook) => [hook.id, hook.source, hook.command])).toEqual([
      ["fmt", "project", "./project-fmt.sh"],
      ["fmt", "user", "./user-fmt.sh"],
    ]);
  });
});

describe("discoverHooks - tolerance", () => {
  test("a missing project file yields only user hooks, silently", () => {
    const report = discoverHooks(roots, readFrom({ [roots.userHooksPath]: userFile }));
    expect(report.hooks.map((hook) => [hook.id, hook.source])).toEqual([["review", "user"]]);
    expect(report.issues).toEqual([]);
  });

  test("both files missing yields an empty report, never a throw", () => {
    const report = discoverHooks(roots, readFrom({}));
    expect(report.hooks).toEqual([]);
    expect(report.issues).toEqual([]);
  });

  test("a malformed root contributes nothing while the other root survives", () => {
    const report = discoverHooks(
      roots,
      readFrom({ [roots.projectHooksPath]: "{ not json", [roots.userHooksPath]: userFile }),
    );
    expect(report.hooks.map((hook) => hook.id)).toEqual(["review"]);
  });

  test("malformed and disabled entries surface as source-attributed diagnostics", () => {
    const report = discoverHooks(
      roots,
      readFrom({
        [roots.projectHooksPath]: {
          hooks: {
            post: { event: "PostToolUse", command: "./post.sh" },
            off: { event: "Stop", command: "./off.sh", enabled: false },
          },
        },
        [roots.userHooksPath]: {
          hooks: { broken: { event: "Stop" } },
        },
      }),
    );
    expect(report.issues.map((issue) => [issue.kind, issue.hook, issue.source])).toEqual([
      ["unknown_event", "post", "project"],
      ["disabled_hook", "off", "project"],
      ["missing_command", "broken", "user"],
    ]);
    expect(report.hooks.map((hook) => [hook.id, hook.enabled])).toEqual([["off", false]]);
  });
});

describe("defaultHookDiscoveryRoots", () => {
  test("project hooks live under .belay/ in the workspace; user hooks under the config home", () => {
    const defaults = defaultHookDiscoveryRoots("/some/workspace");
    expect(defaults.projectHooksPath).toBe(join("/some/workspace", PROJECT_HOOKS_FILE));
    expect(PROJECT_HOOKS_FILE).toBe(join(".belay", "hooks.json"));
    expect(defaults.userHooksPath.endsWith("hooks.json")).toBe(true);
  });
});

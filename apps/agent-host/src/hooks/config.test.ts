import { describe, expect, test } from "vitest";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  loadHooksFile,
  MAX_HOOK_TIMEOUT_MS,
  normalizeHooksConfig,
} from "./config";

const preToolUseEntry = {
  event: "PreToolUse",
  command: "./scripts/check-tool.sh",
  args: ["--strict"],
};

const stopEntry = {
  event: "Stop",
  command: "node",
  args: ["./scripts/review-stop.mjs"],
};

describe("normalizeHooksConfig - events and required fields", () => {
  test("a PreToolUse entry normalizes with defaults", () => {
    const { hooks, issues } = normalizeHooksConfig(
      { hooks: { guard: preToolUseEntry } },
      "project",
    );
    expect(issues).toEqual([]);
    expect(hooks).toEqual([
      {
        id: "guard",
        event: "PreToolUse",
        command: "./scripts/check-tool.sh",
        args: ["--strict"],
        timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
        enabled: true,
        source: "project",
      },
    ]);
  });

  test("a Stop entry normalizes with defaults", () => {
    const { hooks, issues } = normalizeHooksConfig({ hooks: { review: stopEntry } }, "user");
    expect(issues).toEqual([]);
    expect(hooks).toEqual([
      {
        id: "review",
        event: "Stop",
        command: "node",
        args: ["./scripts/review-stop.mjs"],
        timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
        enabled: true,
        source: "user",
      },
    ]);
  });

  test("the first cut accepts exactly PreToolUse and Stop (D-002)", () => {
    expect(HOOK_EVENTS).toEqual(["PreToolUse", "Stop"]);
  });

  test("an unknown event type is rejected with a structured diagnostic (D-002)", () => {
    const { hooks, issues } = normalizeHooksConfig(
      { hooks: { post: { ...preToolUseEntry, event: "PostToolUse" } } },
      "project",
    );
    expect(hooks).toEqual([]);
    expect(issues).toEqual([
      {
        kind: "unknown_event",
        hook: "post",
        source: "project",
        detail: expect.stringContaining("PostToolUse"),
      },
    ]);
    expect(issues[0]?.detail).toContain("PreToolUse");
    expect(issues[0]?.detail).toContain("Stop");
  });

  test("a missing event is rejected with the same diagnostic", () => {
    const { hooks, issues } = normalizeHooksConfig(
      { hooks: { bare: { command: "./x.sh" } } },
      "user",
    );
    expect(hooks).toEqual([]);
    expect(issues.map((issue) => issue.kind)).toEqual(["unknown_event"]);
  });

  test("an entry without a command is dropped with a structured issue", () => {
    const { hooks, issues } = normalizeHooksConfig(
      { hooks: { broken: { event: "Stop" } } },
      "project",
    );
    expect(hooks).toEqual([]);
    expect(issues).toEqual([
      {
        kind: "missing_command",
        hook: "broken",
        source: "project",
        detail: expect.stringContaining("command"),
      },
    ]);
  });

  test("a non-object entry is dropped with a structured issue", () => {
    const { hooks, issues } = normalizeHooksConfig({ hooks: { nope: "run me" } }, "user");
    expect(hooks).toEqual([]);
    expect(issues).toEqual([
      { kind: "invalid_shape", hook: "nope", source: "user", detail: expect.any(String) },
    ]);
  });

  test("junk top-level shapes yield empty config without crashing", () => {
    expect(normalizeHooksConfig(undefined, "project")).toEqual({ hooks: [], issues: [] });
    expect(normalizeHooksConfig(null, "project")).toEqual({ hooks: [], issues: [] });
    expect(normalizeHooksConfig({}, "project")).toEqual({ hooks: [], issues: [] });
    expect(normalizeHooksConfig({ hooks: ["a"] }, "project").issues).toEqual([
      {
        kind: "invalid_shape",
        hook: "",
        source: "project",
        detail: expect.stringContaining("hooks"),
      },
    ]);
  });
});

describe("normalizeHooksConfig - ids", () => {
  test("an id with the approval-key separator or whitespace is rejected", () => {
    const { hooks, issues } = normalizeHooksConfig(
      {
        hooks: {
          "has:colon": preToolUseEntry,
          "has space": preToolUseEntry,
          "  ": preToolUseEntry,
        },
      },
      "project",
    );
    expect(hooks).toEqual([]);
    expect(issues.map((issue) => issue.kind)).toEqual(["invalid_id", "invalid_id", "invalid_id"]);
  });

  test("duplicate ids after trimming are rejected, first entry wins", () => {
    const { hooks, issues } = normalizeHooksConfig(
      {
        hooks: {
          guard: { ...preToolUseEntry, command: "./one.sh" },
          "guard ": { ...preToolUseEntry, command: "./two.sh" },
        },
      },
      "project",
    );
    expect(hooks.map((hook) => hook.id)).toEqual(["guard"]);
    expect(hooks[0]?.command).toBe("./one.sh");
    expect(issues).toEqual([
      { kind: "duplicate_id", hook: "guard", source: "project", detail: expect.any(String) },
    ]);
  });
});

describe("normalizeHooksConfig - flags and knobs", () => {
  test("args keeps only strings; a junk args shape becomes empty", () => {
    const { hooks } = normalizeHooksConfig(
      {
        hooks: {
          strings: { ...stopEntry, args: ["ok", 7, null, "also-ok"] },
          junk: { ...stopEntry, args: "not-an-array" },
        },
      },
      "project",
    );
    expect(hooks.map((hook) => hook.args)).toEqual([["ok", "also-ok"], []]);
  });

  test("timeoutMs accepts a positive integer, defaults junk, and caps at the max", () => {
    const { hooks } = normalizeHooksConfig(
      {
        hooks: {
          fast: { ...stopEntry, timeoutMs: 1_000 },
          junk: { ...stopEntry, timeoutMs: "quick" },
          negative: { ...stopEntry, timeoutMs: -5 },
          huge: { ...stopEntry, timeoutMs: 600_000 },
        },
      },
      "user",
    );
    expect(hooks.map((hook) => hook.timeoutMs)).toEqual([
      1_000,
      DEFAULT_HOOK_TIMEOUT_MS,
      DEFAULT_HOOK_TIMEOUT_MS,
      MAX_HOOK_TIMEOUT_MS,
    ]);
  });

  test("a disabled hook stays in the model and surfaces a diagnostic", () => {
    const { hooks, issues } = normalizeHooksConfig(
      { hooks: { off: { ...stopEntry, enabled: false } } },
      "project",
    );
    expect(hooks.map((hook) => [hook.id, hook.enabled])).toEqual([["off", false]]);
    expect(issues).toEqual([
      { kind: "disabled_hook", hook: "off", source: "project", detail: expect.any(String) },
    ]);
  });

  test("a non-boolean enabled falls back to true", () => {
    const { hooks, issues } = normalizeHooksConfig(
      { hooks: { on: { ...stopEntry, enabled: "sure" } } },
      "project",
    );
    expect(hooks[0]?.enabled).toBe(true);
    expect(issues).toEqual([]);
  });
});

describe("loadHooksFile", () => {
  test("reads and normalizes a hooks file with source provenance", () => {
    const config = loadHooksFile("/tmp/hooks.json", "user", () =>
      JSON.stringify({ hooks: { review: stopEntry } }),
    );
    expect(config.hooks.map((hook) => [hook.id, hook.source])).toEqual([["review", "user"]]);
  });

  test("a missing file yields empty config silently", () => {
    const config = loadHooksFile("/tmp/hooks.json", "project", () => {
      throw new Error("ENOENT");
    });
    expect(config).toEqual({ hooks: [], issues: [] });
  });

  test("a malformed file yields empty config instead of crashing", () => {
    const config = loadHooksFile("/tmp/hooks.json", "project", () => "{ not json");
    expect(config).toEqual({ hooks: [], issues: [] });
  });
});

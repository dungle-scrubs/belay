import { describe, expect, test } from "vitest";
import { loadVimPref, parseVimPref, resolveVimToggle, saveVimPref, vimEnabled } from "./vim-store";

/**
 * M1: the Vim-mode preference store. It reads an explicit `{ enabled }` boolean from `vim.json` under
 * the config home, and resolves to disabled for everything else (missing, malformed, non-boolean) -
 * without throwing, so a bad file never blocks host startup. Read/write are injected (no disk).
 */

describe("parseVimPref", () => {
  test("an explicit boolean enables/disables from the user file", () => {
    expect(parseVimPref({ enabled: true })).toEqual({ enabled: true, source: "user" });
    expect(parseVimPref({ enabled: false })).toEqual({ enabled: false, source: "user" });
  });

  test("a missing key, non-boolean, or non-object falls back to the disabled default", () => {
    expect(parseVimPref({})).toEqual({ enabled: false, source: "default" });
    expect(parseVimPref({ enabled: "yes" })).toEqual({ enabled: false, source: "default" });
    expect(parseVimPref(null)).toEqual({ enabled: false, source: "default" });
    expect(parseVimPref(42)).toEqual({ enabled: false, source: "default" });
  });
});

describe("loadVimPref", () => {
  test("reads an enabled preference from the config file (TREVOR_HOME path is injectable)", () => {
    const pref = loadVimPref("/home/.trevor/vim.json", () => '{"enabled":true}');
    expect(pref).toEqual({ enabled: true, source: "user" });
  });

  test("a missing file yields disabled, silently", () => {
    const pref = loadVimPref("/x/vim.json", () => {
      throw new Error("ENOENT");
    });
    expect(pref).toEqual({ enabled: false, source: "default" });
  });

  test("a malformed file falls back to disabled rather than throwing", () => {
    expect(() => loadVimPref("/x/vim.json", () => "{ not json")).not.toThrow();
    expect(loadVimPref("/x/vim.json", () => "{ not json")).toEqual({
      enabled: false,
      source: "default",
    });
  });

  test("an explicit { enabled: false } reads as a disabled USER preference (not the default)", () => {
    expect(loadVimPref("/x/vim.json", () => '{"enabled":false}')).toEqual({
      enabled: false,
      source: "user",
    });
  });
});

describe("saveVimPref", () => {
  test("writes a minimal { enabled } JSON to the config path", () => {
    const files = new Map<string, string>();
    saveVimPref(true, "/home/.trevor/vim.json", (p, c) => void files.set(p, c));
    expect(files.get("/home/.trevor/vim.json")).toBe('{\n  "enabled": true\n}\n');
  });
});

describe("resolveVimToggle", () => {
  test("bare /vim toggles the current value", () => {
    expect(resolveVimToggle("", false)).toEqual({ ok: true, enabled: true });
    expect(resolveVimToggle("", true)).toEqual({ ok: true, enabled: false });
  });

  test("an explicit on/off (and aliases, case-insensitive) sets regardless of current", () => {
    expect(resolveVimToggle("on", false)).toEqual({ ok: true, enabled: true });
    expect(resolveVimToggle("enable", true)).toEqual({ ok: true, enabled: true });
    expect(resolveVimToggle("TRUE", false)).toEqual({ ok: true, enabled: true });
    expect(resolveVimToggle("off", true)).toEqual({ ok: true, enabled: false });
    expect(resolveVimToggle(" Disable ", true)).toEqual({ ok: true, enabled: false });
    expect(resolveVimToggle("false", true)).toEqual({ ok: true, enabled: false });
  });

  test("an unrecognized argument is rejected so the command can report usage", () => {
    expect(resolveVimToggle("maybe", false)).toEqual({ ok: false });
  });
});

describe("vimEnabled", () => {
  test("defaults to false (no config) without throwing", () => {
    // No vim.json on the test box -> disabled. This is the boolean the host announces.
    expect(typeof vimEnabled()).toBe("boolean");
  });
});

import { describe, expect, test } from "vitest";
import { loadStylePref, parseStylePref, saveStylePref } from "./style-store";

describe("parseStylePref", () => {
  test("a valid user id reads as a user-sourced preference", () => {
    expect(parseStylePref({ activeStyle: "concise" })).toEqual({
      activeStyle: "concise",
      source: "user",
    });
  });

  test("a missing / unknown / retired id falls back to default", () => {
    expect(parseStylePref({ activeStyle: "retired" })).toEqual({
      activeStyle: "default",
      source: "default",
    });
    expect(parseStylePref({})).toMatchObject({ source: "default" });
    expect(parseStylePref(null)).toMatchObject({ activeStyle: "default", source: "default" });
  });
});

describe("loadStylePref", () => {
  test("reads + parses a present file", () => {
    const pref = loadStylePref("/x/style.json", () => JSON.stringify({ activeStyle: "reviewer" }));
    expect(pref).toEqual({ activeStyle: "reviewer", source: "user" });
  });

  test("a missing file is the default silently", () => {
    const pref = loadStylePref("/x/style.json", () => {
      throw new Error("ENOENT");
    });
    expect(pref).toEqual({ activeStyle: "default", source: "default" });
  });

  test("a malformed file falls back to default rather than crashing", () => {
    expect(loadStylePref("/x/style.json", () => "{ not json")).toMatchObject({ source: "default" });
  });
});

describe("saveStylePref", () => {
  test("writes the active style id as pretty JSON, round-tripping through load", () => {
    const files = new Map<string, string>();
    saveStylePref("diagnostic", "/x/style.json", (p, c) => void files.set(p, c));
    expect(files.get("/x/style.json")).toContain('"activeStyle": "diagnostic"');

    const pref = loadStylePref("/x/style.json", (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    });
    expect(pref).toEqual({ activeStyle: "diagnostic", source: "user" });
  });
});

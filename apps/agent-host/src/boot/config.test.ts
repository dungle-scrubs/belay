import { describe, expect, test } from "vitest";
import { loadJsonConfig, writeJsonConfig } from "./config-file";

const parse = (raw: unknown): { n: number } => ({
  n: typeof (raw as { n?: unknown })?.n === "number" ? (raw as { n: number }).n : 0,
});

describe("loadJsonConfig", () => {
  test("reads + parses a present file", () => {
    expect(loadJsonConfig("/x.json", parse, { n: -1 }, () => '{"n":5}')).toEqual({ n: 5 });
  });

  test("a missing/unreadable file yields the fallback silently", () => {
    expect(
      loadJsonConfig("/x.json", parse, { n: -1 }, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ n: -1 });
  });

  test("a malformed file falls back rather than throwing", () => {
    expect(loadJsonConfig("/x.json", parse, { n: -1 }, () => "{ not json")).toEqual({ n: -1 });
  });
});

describe("writeJsonConfig", () => {
  test("writes pretty JSON with a trailing newline", () => {
    const files = new Map<string, string>();
    writeJsonConfig("/x.json", { n: 7 }, (p, c) => void files.set(p, c));
    expect(files.get("/x.json")).toBe('{\n  "n": 7\n}\n');
  });
});

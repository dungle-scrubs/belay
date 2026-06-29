import { describe, expect, test } from "vitest";
import { parseSerialQueue } from "./queue";

const AVAILABLE = [
  "02-serial-worktree-implement",
  "03-nested-command-menu",
  "04-archive-browser-and-delete",
  "05-compact-transcript-layout",
  "40-command-shell-interpolation",
  "40.1-some-decimal-followup",
];

describe("parseSerialQueue", () => {
  test("resolves bare numbers, in first-appearance order", () => {
    const result = parseSerialQueue("implement plans 03 04 05", AVAILABLE);
    expect(result).toEqual({
      ok: true,
      queue: [
        "03-nested-command-menu",
        "04-archive-browser-and-delete",
        "05-compact-transcript-layout",
      ],
    });
  });

  test("accepts full plan ids and a mix with bare numbers", () => {
    const result = parseSerialQueue("do 03-nested-command-menu and then 05", AVAILABLE);
    expect(result).toEqual({
      ok: true,
      queue: ["03-nested-command-menu", "05-compact-transcript-layout"],
    });
  });

  test("preserves the requested order even when not ascending", () => {
    const result = parseSerialQueue("05, 03, 04", AVAILABLE);
    if (!result.ok) throw new Error(result.error);
    expect(result.queue).toEqual([
      "05-compact-transcript-layout",
      "03-nested-command-menu",
      "04-archive-browser-and-delete",
    ]);
  });

  test("collapses a repeated plan to its first position", () => {
    const result = parseSerialQueue("04 03 04", AVAILABLE);
    if (!result.ok) throw new Error(result.error);
    expect(result.queue).toEqual(["04-archive-browser-and-delete", "03-nested-command-menu"]);
  });

  test("resolves a decimal plan number distinctly from its base", () => {
    const result = parseSerialQueue("implement 40.1", AVAILABLE);
    expect(result).toEqual({ ok: true, queue: ["40.1-some-decimal-followup"] });
  });

  test("a bare base number does not match its decimal sub-plans", () => {
    const result = parseSerialQueue("40", AVAILABLE);
    expect(result).toEqual({ ok: true, queue: ["40-command-shell-interpolation"] });
  });

  test("fails the whole parse on an unknown number", () => {
    expect(parseSerialQueue("03 99", AVAILABLE)).toEqual({
      ok: false,
      error: "no plan numbered 99",
    });
  });

  test("fails on an unknown full id", () => {
    expect(parseSerialQueue("07-does-not-exist", AVAILABLE)).toEqual({
      ok: false,
      error: "unknown plan: 07-does-not-exist",
    });
  });

  test("fails with a clear message when no plans are named", () => {
    const result = parseSerialQueue("please implement some stuff", AVAILABLE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no plans named/);
  });
});

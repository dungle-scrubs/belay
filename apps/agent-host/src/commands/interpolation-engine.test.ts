import { runCommand } from "@host/tools/run-shell";
import { describe, expect, it } from "vitest";
import {
  type InterpolationSegment,
  interpolate,
  parseInterpolation,
  type RunnableSegment,
  renderInterpolation,
  type SegmentExecutor,
} from "./interpolation-engine";

/**
 * The shared interpolation parser + renderer (plan 40, M3). The parser is proven PURE (no shell) with a
 * fake executor, and a small execution-floor section drives the same forms through the real runCommand
 * floor to lock the enabled-skill behavior (M1): `!cmd`, fenced blocks, refusals, error output, and caps.
 */

/** Labels each runnable segment so parser output is asserted without running anything. */
const label: SegmentExecutor = (segment: RunnableSegment) =>
  Promise.resolve(
    segment.kind === "command" ? `<cmd:${segment.command}>` : `<blk:${segment.script}>`,
  );

function kinds(segments: readonly InterpolationSegment[]): string[] {
  return segments.map((s) => s.kind);
}

describe("parseInterpolation is pure and shell-free (M3)", () => {
  it("keeps plain literal text as literal segments, byte-for-byte", () => {
    const body = "line one\nline two\n  indented three";
    const segments = parseInterpolation(body);
    expect(kinds(segments)).toEqual(["literal", "literal", "literal"]);
    expect(segments.map((s) => (s.kind === "literal" ? s.text : ""))).toEqual([
      "line one",
      "line two",
      "  indented three",
    ]);
  });

  it("parses a whole-line !cmd (the ! stripped, trimmed)", () => {
    const segments = parseInterpolation("before\n!echo hi\nafter");
    expect(kinds(segments)).toEqual(["literal", "command", "literal"]);
    expect(segments[1]).toEqual({ kind: "command", command: "echo hi" });
  });

  it("treats a markdown image ![alt](src) as LITERAL, never a command", () => {
    const segments = parseInterpolation("![alt](./x.png)");
    expect(kinds(segments)).toEqual(["literal"]);
  });

  it("parses a fenced ```! block into one block segment carrying the inner script", () => {
    const segments = parseInterpolation("a\n```!\necho one\necho two\n```\nb");
    expect(kinds(segments)).toEqual(["literal", "block", "literal"]);
    expect(segments[1]).toEqual({ kind: "block", script: "echo one\necho two" });
  });

  it("captures an UNTERMINATED fence to end of body (no crash, no runaway)", () => {
    const segments = parseInterpolation("intro\n```!\necho tail");
    expect(kinds(segments)).toEqual(["literal", "block"]);
    expect(segments[1]).toEqual({ kind: "block", script: "echo tail" });
  });

  it("parses ADJACENT blocks as two separate block segments", () => {
    const segments = parseInterpolation("```!\na\n```\n```!\nb\n```");
    expect(kinds(segments)).toEqual(["block", "block"]);
    expect(segments.map((s) => (s.kind === "block" ? s.script : ""))).toEqual(["a", "b"]);
  });

  it("only a WHOLE line starting with ! is a command; a mid-line ! stays literal", () => {
    const segments = parseInterpolation("echo not-a-command ! here");
    expect(kinds(segments)).toEqual(["literal"]);
  });
});

describe("renderInterpolation preserves order + line count with an injected executor (M3)", () => {
  it("re-joins literals verbatim and substitutes runnable segments in place", async () => {
    const body = "top\n!alpha\nmid\n```!\nbeta\n```\nend";
    const rendered = await renderInterpolation(parseInterpolation(body), label);
    expect(rendered).toBe("top\n<cmd:alpha>\nmid\n<blk:beta>\nend");
  });

  it("runs segments strictly in order (deterministic, not concurrent)", async () => {
    const seen: string[] = [];
    const record: SegmentExecutor = async (segment) => {
      const token = segment.kind === "command" ? segment.command : segment.script;
      seen.push(token);
      return token;
    };
    await interpolate("!first\n!second\n!third", record);
    expect(seen).toEqual(["first", "second", "third"]);
  });

  it("a body with no interpolation round-trips unchanged", async () => {
    const body = "just\nplain\ntext";
    expect(await interpolate(body, label)).toBe(body);
  });
});

describe("the shared execution floor for enabled skill interpolation (M1)", () => {
  // The executor skills use when TREVOR_SKILL_SHELL is on: every segment runs through runCommand, so the
  // always-prevented floor, timeout, and cap apply. This is the exact behavior the skill gate switches on.
  const shellExecutor: SegmentExecutor = async (segment) =>
    (await runCommand(segment.kind === "command" ? segment.command : segment.script)).output;

  it("expands a !cmd line by splicing its stdout", async () => {
    expect(await interpolate("pre\n!printf hello\npost", shellExecutor)).toBe("pre\nhello\npost");
  });

  it("expands a fenced block by splicing the script's stdout", async () => {
    const rendered = await interpolate("```!\nprintf block-out\n```", shellExecutor);
    expect(rendered).toBe("block-out");
  });

  it("a refused (always-prevented) command becomes a bounded refusal string, never runs", async () => {
    const rendered = await interpolate("!rm -rf /", shellExecutor);
    expect(rendered).toMatch(/^refused: /);
  });

  it("a non-zero command becomes bounded error output, not a throw", async () => {
    const rendered = await interpolate("!sh -c 'echo boom >&2; exit 3'", shellExecutor);
    expect(rendered).toMatch(/boom/);
  });

  it("large command output is capped by the runCommand floor", async () => {
    const rendered = await interpolate("!seq 1 5000", shellExecutor);
    expect(rendered.length).toBeLessThanOrEqual(8000 + 32);
    expect(rendered).toMatch(/\[truncated\]/);
  });
});

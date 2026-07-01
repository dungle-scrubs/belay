import { describe, expect, it } from "vitest";
import { resultWithinBudget, summarizeToolOutput } from "./output-budget";

describe("tool_script output summarization (M6)", () => {
  it("passes a small output through unchanged", () => {
    const s = summarizeToolOutput("small", 2048);
    expect(s.output).toBe("small");
    expect(s.artifact).toBeUndefined();
  });

  it("summarizes a large output to a bounded artifact ref with a preview + byte count", () => {
    const big = "SECRETLINE\n".repeat(1000); // ~11kB
    const s = summarizeToolOutput(big, 2048);
    expect(s.artifact).toBeDefined();
    expect(s.artifact?.originalBytes).toBe(Buffer.byteLength(big));
    expect(s.artifact?.preview.length).toBeLessThanOrEqual(512);
    expect(s.artifact?.artifactId).toMatch(/^script_art_[0-9a-f]{16}$/);
    // The handed-back output is the small JSON ref, NOT the full content.
    expect(Buffer.byteLength(s.output)).toBeLessThan(Buffer.byteLength(big));
  });

  it("never leaks the full content in the summary - only the capped preview", () => {
    const big = `head${"x".repeat(5000)}TAIL_SECRET`;
    const s = summarizeToolOutput(big, 1024);
    // The tail (past the preview window) is absent from the summary.
    expect(s.output).not.toContain("TAIL_SECRET");
    expect(s.artifact?.preview).not.toContain("TAIL_SECRET");
  });

  it("is deterministic - the same output yields the same artifact id", () => {
    const big = "y".repeat(4000);
    expect(summarizeToolOutput(big, 100).artifact?.artifactId).toBe(
      summarizeToolOutput(big, 100).artifact?.artifactId,
    );
  });
});

describe("tool_script final-result bounding (M6)", () => {
  it("accepts a result within budget and rejects one over it", () => {
    expect(resultWithinBudget({ a: 1 }, 8000)).toBe(true);
    expect(resultWithinBudget({ blob: "z".repeat(10_000) }, 8000)).toBe(false);
  });
});

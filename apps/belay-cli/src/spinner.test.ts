import assert from "node:assert/strict";
import { test } from "vitest";
import { createSpinner } from "./spinner";

/**
 * The launcher spinner's non-TTY behavior (the deterministic, testable path): each step prints one
 * line and succeed/fail print a marked final line, so piped/CI output stays readable. The animated
 * TTY path is exercised by eye, not asserted here.
 */

/** A non-TTY stream that records everything written to it. */
function fakeStream(): NodeJS.WriteStream & { lines: string[] } {
  const lines: string[] = [];
  return {
    isTTY: false,
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    },
    lines,
  } as unknown as NodeJS.WriteStream & { lines: string[] };
}

test("on a non-TTY, each step prints one line and succeed marks the final line", () => {
  const stream = fakeStream();
  const spinner = createSpinner(stream);
  spinner.step("starting Trevor…");
  spinner.step("waiting for host…");
  spinner.succeed("Trevor ready");

  assert.equal(stream.lines.length, 3);
  assert.ok(stream.lines[0]?.includes("•") && stream.lines[0]?.includes("starting Trevor…"));
  assert.ok(stream.lines[1]?.includes("waiting for host…"));
  assert.ok(stream.lines[2]?.includes("✔") && stream.lines[2]?.includes("Trevor ready"));
});

test("fail marks the final line", () => {
  const stream = fakeStream();
  const spinner = createSpinner(stream);
  spinner.step("starting Trevor…");
  spinner.fail("Trevor failed to start");
  const last = stream.lines.at(-1) ?? "";
  assert.ok(last.includes("✖") && last.includes("Trevor failed to start"));
});

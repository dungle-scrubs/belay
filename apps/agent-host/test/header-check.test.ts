import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";

/**
 * Responsible for: enforcing the structured module-header convention (plan 22.1 M5, D-008) - every
 * host source file's first block comment carries a `Responsible for:` line (and optionally
 * `Not for:`), the fixed shape AGENTS.md documents and a docs generator can parse.
 * Not for: directory-structure enforcement - that is structure.test.ts.
 */

const SRC_ROOT = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => join(dir, path));
}

/** The first line-leading block comment in the file, or null. Anchoring to a line start keeps a
 *  `/*` inside a string or regex literal from mis-slicing the scan. */
function firstBlockComment(text: string): string | null {
  const start = text.search(/^\s*\/\*/m);
  if (start < 0) {
    return null;
  }
  const end = text.indexOf("*/", start + 2);
  return end < 0 ? null : text.slice(start, end + 2);
}

/**
 * The parseable header contract: the file's first block comment contains one
 * `Responsible for: <text>` line. `Not for:` is optional (required judgment, not required syntax).
 */
export function headerViolation(text: string): string | null {
  const block = firstBlockComment(text);
  if (block === null) {
    return "no block comment - add the structured module header";
  }
  if (!/^\s*\*?\s*Responsible for: \S.*$/m.test(block)) {
    return "first block comment lacks a 'Responsible for: <text>' line";
  }
  return null;
}

test("every host source file opens with a parseable Responsible-for header", () => {
  const failures = sourceFiles(SRC_ROOT)
    .map((file) => {
      const violation = headerViolation(readFileSync(file, "utf8"));
      return violation === null ? null : `${relative(SRC_ROOT, file)}: ${violation}`;
    })
    .filter((failure): failure is string => failure !== null);

  assert.deepEqual(
    failures,
    [],
    `header check (${failures.length} files):\n${failures.join("\n")}`,
  );
});

test("the check fails a file with no block comment and one missing the Responsible-for line", () => {
  assert.match(headerViolation("export const x = 1;") ?? "", /no block comment/);
  assert.match(headerViolation("/** just prose */") ?? "", /lacks a 'Responsible for/);
  assert.equal(headerViolation("/**\n * Responsible for: parsing.\n */"), null);
});

import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import {
  highlightCode,
  isFenceClosed,
  preloadHighlightEngine,
  resolveHighlightLanguage,
} from "./code-highlight";

// The hljs engine (core + grammars) lazy-loads behind the facade (Tier 5.2); these tests cover the
// engine's behavior, so load it up front. The not-yet-loaded window is covered by
// code-highlight-lazy.test.ts, which must NOT share this file's module registry.
beforeAll(() => preloadHighlightEngine());

test("resolves explicit fenced languages and their aliases to a grammar id", () => {
  // The normalized token is returned when hljs recognizes it (case-folded, whitespace-trimmed).
  assert.equal(resolveHighlightLanguage("ts"), "ts");
  assert.equal(resolveHighlightLanguage("TS"), "ts");
  assert.equal(resolveHighlightLanguage("  Python  "), "python");
  // Registered aliases (declared by the grammar or added in code-highlight) all resolve non-null.
  for (const alias of ["tsx", "jsx", "py", "sh", "shell", "json", "diff", "yml", "html"]) {
    assert.ok(resolveHighlightLanguage(alias), `${alias} resolves to a grammar`);
  }
});

test("never guesses a grammar for unknown, blank, or Mermaid fences", () => {
  assert.equal(resolveHighlightLanguage(""), null);
  assert.equal(resolveHighlightLanguage("   "), null);
  assert.equal(resolveHighlightLanguage("mermaid"), null);
  assert.equal(resolveHighlightLanguage("MERMAID"), null);
  assert.equal(resolveHighlightLanguage("mermaidish"), null);
  assert.equal(resolveHighlightLanguage("not-a-language"), null);
});

test("highlights a known language into hljs token spans", () => {
  const result = highlightCode("ts", "const answer = 42;\n");
  assert.equal(result.highlighted, true);
  assert.ok(result.highlighted && result.html.includes('<span class="hljs-keyword">const</span>'));
  assert.ok(result.highlighted && result.html.includes('<span class="hljs-number">42</span>'));
});

test("does not highlight unknown, blank, or Mermaid blocks", () => {
  assert.equal(highlightCode("", "plain text\n").highlighted, false);
  assert.equal(highlightCode("not-a-language", "plain text\n").highlighted, false);
  assert.equal(highlightCode("mermaid", "graph TD\n  A-->B\n").highlighted, false);
});

test("reuses the cached markup for the same grammar and source (no re-tokenizing)", () => {
  const source = "export const x: number = 1;\n";
  const first = highlightCode("ts", source);
  const second = highlightCode("ts", source);
  assert.ok(first.highlighted && second.highlighted);
  // Same string reference proves the second call hit the cache instead of tokenizing again.
  assert.ok(first.highlighted && second.highlighted && Object.is(first.html, second.html));
});

test("skips highlighting for oversized blocks so tokenization cannot freeze the transcript", () => {
  const huge = `${"const a = 1;\n".repeat(4000)}`; // ~48k chars, over the char guard
  assert.equal(highlightCode("ts", huge).highlighted, false);

  const manyLines = `${"x\n".repeat(2100)}`; // over the line guard
  assert.equal(highlightCode("ts", manyLines).highlighted, false);
});

test("detects a closed fence versus a still-streaming (unterminated) one", () => {
  assert.equal(isFenceClosed("```ts\nconst a = 1;\n```"), true);
  assert.equal(isFenceClosed("```ts\nconst a = 1;\n```\n"), true);
  assert.equal(isFenceClosed("```ts\nconst a = 1;"), false, "no closing fence yet");
  assert.equal(isFenceClosed("~~~python\nx = 1\n~~~"), true);
  assert.equal(isFenceClosed("~~~python\nx = 1"), false);
});

test("closing fence must match the opener's char and length", () => {
  assert.equal(isFenceClosed("````ts\nx\n````"), true, "4-backtick fence closed by 4");
  assert.equal(
    isFenceClosed("````ts\nx\n```"),
    false,
    "3 backticks cannot close a 4-backtick fence",
  );
  assert.equal(
    isFenceClosed("```ts\nx\n``` "),
    true,
    "trailing spaces on the closing fence are fine",
  );
  // An indented (non-fenced) block has no opener fence and is never treated as closed.
  assert.equal(isFenceClosed("    const a = 1;\n    const b = 2;"), false);
});

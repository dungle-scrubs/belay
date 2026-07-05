import assert from "node:assert/strict";
import { test } from "vitest";
import { expandArgs, scanArgs, tokenizeArgs } from "./command-args";

/**
 * The pure argument tokenizer + substituter (plan 44.5). Shell-style tokenization (M1) and
 * `$N`/`$ARGUMENTS` substitution (M2), each driven RED-first as a pure module - the same engine the
 * host expands authoritatively and the web previews on every keystroke.
 */

// --- M1: shell-style tokenizer ---

test("whitespace splits a plain line into tokens", () => {
  assert.deepEqual(tokenizeArgs("a b c"), ["a", "b", "c"]);
});

test("runs of whitespace collapse, leading/trailing trimmed", () => {
  assert.deepEqual(tokenizeArgs("  a   b\tc  "), ["a", "b", "c"]);
  assert.deepEqual(tokenizeArgs(""), []);
});

test("a double-quoted span is one token with the quotes stripped", () => {
  assert.deepEqual(tokenizeArgs('"two words" x'), ["two words", "x"]);
});

test("a single-quoted span is one token with the quotes stripped", () => {
  assert.deepEqual(tokenizeArgs("'two words' x"), ["two words", "x"]);
});

test("backslash escapes the next char (space and quote become literal)", () => {
  assert.deepEqual(tokenizeArgs("a\\ b"), ["a b"]);
  assert.deepEqual(tokenizeArgs('\\"x'), ['"x']);
});

test("single quotes keep a backslash literal (no escape inside single quotes)", () => {
  assert.deepEqual(tokenizeArgs("'a\\b'"), ["a\\b"]);
});

test("an unterminated quote consumes to end of input and flags a diagnostic", () => {
  const scan = scanArgs('"open ended');
  assert.deepEqual(scan.tokens, ["open ended"]);
  assert.equal(scan.unterminatedQuote, true);
});

test("a closed quote reports no unterminated diagnostic", () => {
  const scan = scanArgs('"closed" ok');
  assert.deepEqual(scan.tokens, ["closed", "ok"]);
  assert.equal(scan.unterminatedQuote, false);
});

// --- M2: substituter + public API ---

test("positional $N maps to tokens[N], 0-based (D-001: $0 is the first arg)", () => {
  assert.equal(expandArgs("#$0 $1", "a b").text, "#a b");
});

test("$ARGUMENTS is the raw string verbatim, never the re-joined tokens (D-002)", () => {
  // The double space and the quotes survive in $ARGUMENTS, while $0 tokenizes to `a b`.
  assert.equal(expandArgs("x $ARGUMENTS", '"a b"  c').text, 'x "a b"  c');
  assert.equal(expandArgs("$0", '"a b"  c').text, "a b");
});

test("a missing / out-of-range positional substitutes empty string, never a literal leak (D-004)", () => {
  const result = expandArgs("[$2]", "only");
  assert.equal(result.text, "[]");
  assert.deepEqual(result.diagnostics.missing, ["$2"]);
});

test("an escaped placeholder stays literal while an unescaped one expands (D-003)", () => {
  // `\$1` is the literal text `$1`; the unescaped `$1` expands to tokens[1] ("b"). 0-based per D-001,
  // so the raw carries two tokens (the plan's `$1`-with-one-arg sketch is made index-consistent here).
  assert.equal(expandArgs("\\$1 $1", "a b").text, "$1 b");
  // `\\$1` is one literal backslash followed by the EXPANDED `$1`.
  assert.equal(expandArgs("\\\\$1", "a b").text, "\\b");
});

test("a lone $ or an unknown $word is passed through literally", () => {
  assert.equal(expandArgs("cost is $ and $x", "a").text.startsWith("cost is $ and $x"), true);
});

test("expandArgs reports referenced placeholders, provided-arg count, and missing refs", () => {
  const result = expandArgs("$0 $2 $ARGUMENTS", "one");
  assert.deepEqual(result.diagnostics.referenced, ["$0", "$2", "$ARGUMENTS"]);
  assert.equal(result.diagnostics.providedCount, 1);
  assert.deepEqual(result.diagnostics.missing, ["$2"]);
  assert.equal(result.diagnostics.appendedArguments, false);
});

test("a template with NO placeholder auto-appends the raw args (CC-parity default)", () => {
  const result = expandArgs("Refactor the module", "src/foo.ts quickly");
  assert.equal(result.text, "Refactor the module\n\nARGUMENTS: src/foo.ts quickly");
  assert.equal(result.diagnostics.appendedArguments, true);
});

test("the no-placeholder auto-append is skipped when the args are empty", () => {
  const result = expandArgs("Refactor the module", "   ");
  assert.equal(result.text, "Refactor the module");
  assert.equal(result.diagnostics.appendedArguments, false);
});

test("an escaped placeholder does NOT count as a reference, so it can trigger the auto-append", () => {
  const result = expandArgs("literal \\$0 only", "here");
  assert.equal(result.text, "literal $0 only\n\nARGUMENTS: here");
  assert.deepEqual(result.diagnostics.referenced, []);
  assert.equal(result.diagnostics.appendedArguments, true);
});

test("the unterminated-quote flag surfaces in the expansion diagnostics", () => {
  assert.equal(expandArgs("$0", '"open').diagnostics.unterminatedQuote, true);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  bashDetailArgs,
  editDetailArgs,
  matchCount,
  multiEditDetailArgs,
  readDetailArgs,
  readRangeLabel,
  requestDetailArgs,
  searchDetailArgs,
  truncationLabel,
  writeDetailArgs,
} from "./detail-args";

/**
 * M3: the pure filesystem/shell arg extractors. Each pulls the fields its detail body renders, and
 * degrades to empty (never throws) on a missing / malformed / still-streaming arg.
 */

test("bash extracts command + optional cwd", () => {
  assert.deepEqual(bashDetailArgs('{"command":"ls -la","cwd":"~/dev"}'), {
    command: "ls -la",
    cwd: "~/dev",
  });
  assert.deepEqual(bashDetailArgs('{"command":"pwd"}'), { command: "pwd" });
});

test("read extracts path + offset/limit range", () => {
  assert.deepEqual(readDetailArgs('{"path":"a.ts","offset":20,"limit":20}'), {
    path: "a.ts",
    offset: 20,
    limit: 20,
  });
  assert.equal(readRangeLabel(20, 20), "L20-39");
  assert.equal(readRangeLabel(20, undefined), "from L20");
  assert.equal(readRangeLabel(undefined, undefined), "", "whole-file read has no range label");
});

test("write/edit/multi_edit extract paths + content/diff fields", () => {
  assert.deepEqual(writeDetailArgs('{"path":"a.ts","content":"x"}'), {
    path: "a.ts",
    content: "x",
  });
  assert.deepEqual(editDetailArgs('{"path":"a.ts","old":"x","new":"y"}'), {
    path: "a.ts",
    old: "x",
    new: "y",
  });
  // Real host shape (plan 08.1): no top-level path; each edit carries its own. `paths` is the
  // distinct set (first-seen); `edits` keep their per-edit path for correct per-file grouping.
  assert.deepEqual(
    multiEditDetailArgs(
      '{"edits":[{"path":"a.ts","old":"x","new":"y"},{"path":"b.ts","old":"a","new":"b"},{"path":"a.ts","old":"c","new":"d"}]}',
    ),
    {
      paths: ["a.ts", "b.ts"],
      edits: [
        { path: "a.ts", old: "x", new: "y" },
        { path: "b.ts", old: "a", new: "b" },
        { path: "a.ts", old: "c", new: "d" },
      ],
    },
  );
});

test("a malformed / partial arg degrades to empty, never throws", () => {
  assert.deepEqual(bashDetailArgs("{ not json"), { command: "" });
  assert.deepEqual(readDetailArgs("{}"), { path: "", offset: undefined, limit: undefined });
  assert.deepEqual(multiEditDetailArgs("{}"), { paths: [], edits: [] });
  // A still-streaming edit (its path not yet arrived) keeps the edit but contributes no chip path.
  assert.deepEqual(multiEditDetailArgs('{"edits":[{"old":"x","new":"y"}]}'), {
    paths: [],
    edits: [{ path: "", old: "x", new: "y" }],
  });
});

test("truncationLabel reports the hidden-line count only past the cap", () => {
  assert.equal(truncationLabel("a\nb\nc\nd\ne", 3), "2 more lines below the fold");
  assert.equal(truncationLabel("a\nb", 3), "");
  assert.equal(truncationLabel(undefined, 3), "");
});

test("search extracts the pattern + scope; request prefers query/url/subject", () => {
  assert.deepEqual(searchDetailArgs('{"pattern":"TODO","path":"apps/web"}'), {
    pattern: "TODO",
    path: "apps/web",
  });
  assert.deepEqual(searchDetailArgs('{"pattern":"*.ts"}'), { pattern: "*.ts" });
  assert.deepEqual(requestDetailArgs('{"query":"effect schema"}'), { request: "effect schema" });
  assert.deepEqual(requestDetailArgs('{"url":"https://x.com"}'), { request: "https://x.com" });
  assert.deepEqual(requestDetailArgs('{"action":"read","subject":"react"}'), {
    request: "react",
    action: "read",
  });
});

test("matchCount counts non-blank result lines only on a done search", () => {
  assert.equal(matchCount("a.ts:1: x\nb.ts:2: y\n\n", "done"), 2);
  assert.equal(matchCount("partial", "running"), undefined, "no count while running");
  assert.equal(matchCount("error: bad regex", "error"), undefined, "no count on error");
});

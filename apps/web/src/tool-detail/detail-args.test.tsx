import assert from "node:assert/strict";
import { test } from "vitest";
import {
  bashDetailArgs,
  editDetailArgs,
  multiEditDetailArgs,
  readDetailArgs,
  readRangeLabel,
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
  assert.deepEqual(
    multiEditDetailArgs('{"path":"a.ts","edits":[{"old":"x","new":"y"},{"old":"a","new":"b"}]}'),
    {
      path: "a.ts",
      edits: [
        { old: "x", new: "y" },
        { old: "a", new: "b" },
      ],
    },
  );
});

test("a malformed / partial arg degrades to empty, never throws", () => {
  assert.deepEqual(bashDetailArgs("{ not json"), { command: "" });
  assert.deepEqual(readDetailArgs("{}"), { path: "", offset: undefined, limit: undefined });
  assert.deepEqual(multiEditDetailArgs('{"path":"a.ts"}'), { path: "a.ts", edits: [] });
});

test("truncationLabel reports the hidden-line count only past the cap", () => {
  assert.equal(truncationLabel("a\nb\nc\nd\ne", 3), "2 more lines below the fold");
  assert.equal(truncationLabel("a\nb", 3), "");
  assert.equal(truncationLabel(undefined, 3), "");
});

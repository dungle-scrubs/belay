import assert from "node:assert/strict";
import { test } from "vitest";
import { type CommandRow, filterRows, groupRows, toneClass } from "./types";

const rows: CommandRow[] = [
  { id: "a", label: "sidebar git", metadata: "~/dev/belay", status: "running", group: "proj" },
  { id: "b", label: "compaction", metadata: "~/dev/belay", keywords: ["fold"], group: "proj" },
  { id: "c", label: "opchain audit", metadata: "~/dev/opchain", status: "stale", group: "other" },
];

test("filterRows returns the same list for an empty/whitespace query", () => {
  assert.equal(filterRows(rows, ""), rows);
  assert.equal(filterRows(rows, "   "), rows);
});

test("filterRows matches label, metadata, status, and keywords case-insensitively", () => {
  assert.deepEqual(
    filterRows(rows, "GIT").map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    filterRows(rows, "opchain").map((r) => r.id),
    ["c"],
  );
  assert.deepEqual(
    filterRows(rows, "running").map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    filterRows(rows, "fold").map((r) => r.id),
    ["b"],
  );
});

test("filterRows is AND-of-tokens across the haystack", () => {
  // both tokens must appear; "belay" + "compaction" only co-occur in row b
  assert.deepEqual(
    filterRows(rows, "belay compaction").map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(filterRows(rows, "opchain running"), []);
});

test("filterRows never mutates the source rows", () => {
  const before = JSON.stringify(rows);
  filterRows(rows, "git");
  assert.equal(JSON.stringify(rows), before);
});

test("groupRows partitions by group, preserving first-seen order", () => {
  const groups = groupRows(rows);
  assert.deepEqual(
    groups.map((g) => g.heading),
    ["proj", "other"],
  );
  assert.deepEqual(
    groups[0]?.rows.map((r) => r.id),
    ["a", "b"],
  );
  assert.deepEqual(
    groups[1]?.rows.map((r) => r.id),
    ["c"],
  );
});

test("groupRows folds ungrouped rows under a single null heading", () => {
  const flat = groupRows([
    { id: "x", label: "x" },
    { id: "y", label: "y" },
  ]);
  assert.equal(flat.length, 1);
  assert.equal(flat[0]?.heading, null);
});

test("toneClass maps tones to palette colors with a foreground default", () => {
  assert.match(toneClass("danger"), /smui-red/);
  assert.match(toneClass("attention"), /smui-yellow/);
  assert.match(toneClass(undefined), /text-foreground/);
});

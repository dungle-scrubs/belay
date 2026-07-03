import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type FileMatch,
  fileMentionText,
  searchWorkspaceFiles,
  splitWorkspacePath,
} from "./file-mention";

const paths = (matches: readonly FileMatch[]): string[] => matches.map((m) => m.path);
const index = (...items: string[]): FileMatch[] => items.map((path) => ({ path }));

test("splitWorkspacePath splits a nested path into basename + dir", () => {
  assert.deepEqual(splitWorkspacePath("apps/web/src/app.tsx"), {
    basename: "app.tsx",
    dir: "apps/web/src",
  });
});

test("splitWorkspacePath returns an empty dir for a root-level file", () => {
  assert.deepEqual(splitWorkspacePath("README.md"), { basename: "README.md", dir: "" });
});

test("splitWorkspacePath keeps a dotfile basename intact", () => {
  assert.deepEqual(splitWorkspacePath("packages/session/.gitignore"), {
    basename: ".gitignore",
    dir: "packages/session",
  });
});

test("fileMentionText prefixes the workspace path with @", () => {
  assert.equal(fileMentionText("apps/web/src/app.tsx"), "@apps/web/src/app.tsx");
});

test("an empty query returns the whole index, shallow (shorter path) first", () => {
  const result = searchWorkspaceFiles(index("apps/web/src/app.tsx", "a.ts", "README.md"), "", 10);
  assert.deepEqual(paths(result.matches), ["a.ts", "README.md", "apps/web/src/app.tsx"]);
  assert.equal(result.truncated, false);
});

test("an exact basename ranks above a prefix, above a substring, above a fuzzy subsequence", () => {
  const result = searchWorkspaceFiles(
    index(
      "src/appearance.ts", // basename prefix "app", but a longer basename
      "src/app.ts", // basename prefix "app"
      "src/app.tsx", // basename prefix "app"
      "src/a-p-p.ts", // fuzzy subsequence a..p..p
      "app", // exact basename === "app"
    ),
    "app",
    10,
  );
  // Exact "app" first, then the prefix matches (shorter basename first), then substring, then fuzzy.
  assert.equal(result.matches[0]?.path, "app");
  assert.deepEqual(paths(result.matches).slice(1, 3), ["src/app.ts", "src/app.tsx"]);
  assert.equal(result.matches.at(-1)?.path, "src/a-p-p.ts");
});

test("a basename match outranks a match that is only in the directory path", () => {
  const result = searchWorkspaceFiles(index("web/src/index.ts", "apps/web.config.ts"), "web", 10);
  // "web.config.ts" has "web" in its basename; "index.ts" only has it as a path segment.
  assert.equal(paths(result.matches)[0], "apps/web.config.ts");
});

test("an exact path segment match ranks above a plain path substring", () => {
  const result = searchWorkspaceFiles(
    index("packages/webhooks/mod.ts", "apps/web/main.ts"),
    "web",
    10,
  );
  // "apps/web/main.ts" has an exact "web" segment; "webhooks" is only a substring.
  assert.equal(paths(result.matches)[0], "apps/web/main.ts");
});

test("non-matching files are dropped, and the tie-break order is stable and deterministic", () => {
  const first = searchWorkspaceFiles(index("b/app.ts", "a/app.ts", "c/none.ts"), "app.ts", 10);
  const second = searchWorkspaceFiles(index("c/none.ts", "a/app.ts", "b/app.ts"), "app.ts", 10);
  assert.deepEqual(paths(first.matches), ["a/app.ts", "b/app.ts"]);
  assert.deepEqual(paths(second.matches), ["a/app.ts", "b/app.ts"]);
});

test("results are capped, with truncation reported when more matched", () => {
  const result = searchWorkspaceFiles(index("app1.ts", "app2.ts", "app3.ts"), "app", 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.truncated, true);
});

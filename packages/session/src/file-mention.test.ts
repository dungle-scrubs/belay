import assert from "node:assert/strict";
import { test } from "vitest";
import { fileMentionText, splitWorkspacePath } from "./file-mention";

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

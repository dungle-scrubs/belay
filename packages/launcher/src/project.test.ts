import assert from "node:assert/strict";
import { test } from "vitest";
import type { LauncherFs } from "./fs";
import { loadProjectMap, resolveProjectRoot, resolveSession } from "./project";

/**
 * Project identity (D-085 M1): root resolution from cwd, the stable URL-safe session id, and the
 * persisted root→session mapping. Driven through an in-memory fake fs - no real disk.
 */

/** An in-memory LauncherFs; `dirs` pre-marks paths that `exists` should report (e.g. `.git` markers). */
function fakeFs(dirs: Iterable<string> = []): LauncherFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const present = new Set(dirs);
  return {
    files,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => {
      files.set(path, content);
      present.add(path);
    },
    exists: (path) => files.has(path) || present.has(path),
    remove: (path) => {
      files.delete(path);
      present.delete(path);
    },
  };
}

test("resolveProjectRoot walks up to the nearest .git, else falls back to cwd", () => {
  const fs = fakeFs(["/a/b/.git"]);
  assert.equal(resolveProjectRoot("/a/b/c/d", fs), "/a/b");
  assert.equal(resolveProjectRoot("/a/b", fs), "/a/b");
  // No .git anywhere above: use cwd.
  assert.equal(resolveProjectRoot("/x/y/z", fakeFs()), "/x/y/z");
});

test("resolveSession derives a stable URL-safe id and persists the mapping", () => {
  const fs = fakeFs();
  const id = resolveSession(fs, "/home/.trevor", "/Users/kevin/dev/trevor", "2026-06-26T00:00:00Z");
  assert.match(id, /^[a-z0-9-]+$/);
  assert.equal(id.includes("/"), false);

  // The mapping is persisted and reused verbatim on the next resolve (same project → same session).
  const map = loadProjectMap(fs, "/home/.trevor");
  assert.equal(map["/Users/kevin/dev/trevor"]?.sessionId, id);
  const again = resolveSession(
    fs,
    "/home/.trevor",
    "/Users/kevin/dev/trevor",
    "2026-07-01T00:00:00Z",
  );
  assert.equal(again, id);
});

test("distinct project roots get distinct persisted sessions", () => {
  const fs = fakeFs();
  const a = resolveSession(fs, "/home/.trevor", "/work/app-a", "t");
  const b = resolveSession(fs, "/home/.trevor", "/work/app-b", "t");
  assert.notEqual(a, b);
  const map = loadProjectMap(fs, "/home/.trevor");
  assert.equal(Object.keys(map).length, 2);
});

test("a malformed projects.json reads as an empty map (never throws)", () => {
  const fs = fakeFs();
  fs.writeFile("/home/.trevor/projects.json", "not json{");
  assert.deepEqual(loadProjectMap(fs, "/home/.trevor"), {});
});

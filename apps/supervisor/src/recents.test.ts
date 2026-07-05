import assert from "node:assert/strict";
import type { LauncherFs } from "@trevor/launcher";
import { test } from "vitest";
import { readRecents } from "./recents";

/**
 * The recent-projects reader (plan 44.1): `projects.json` entries returned recency-sorted (newest
 * `updatedAt` first), and an empty list when the registry is absent. Pure over an in-memory fs.
 */

function fakeFs(files: Record<string, string> = {}): LauncherFs {
  const store = new Map(Object.entries(files));
  return {
    readFile: (path) => store.get(path) ?? null,
    writeFile: (path, content) => void store.set(path, content),
    exists: (path) => store.has(path),
    remove: (path) => void store.delete(path),
  };
}

const HOME = "/state/trevor";

test("readRecents returns projects.json entries recency-sorted (newest first)", () => {
  const fs = fakeFs({
    [`${HOME}/projects.json`]: JSON.stringify({
      "/work/a": { root: "/work/a", sessionId: "a-1", updatedAt: "2026-07-01T00:00:00Z" },
      "/work/c": { root: "/work/c", sessionId: "c-3", updatedAt: "2026-07-03T00:00:00Z" },
      "/work/b": { root: "/work/b", sessionId: "b-2", updatedAt: "2026-07-02T00:00:00Z" },
    }),
  });
  assert.deepEqual(readRecents(fs, HOME), [
    { root: "/work/c", sessionId: "c-3", updatedAt: "2026-07-03T00:00:00Z" },
    { root: "/work/b", sessionId: "b-2", updatedAt: "2026-07-02T00:00:00Z" },
    { root: "/work/a", sessionId: "a-1", updatedAt: "2026-07-01T00:00:00Z" },
  ]);
});

test("readRecents is empty when the registry is absent", () => {
  assert.deepEqual(readRecents(fakeFs(), HOME), []);
});

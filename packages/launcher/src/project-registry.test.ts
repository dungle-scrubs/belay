import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "vitest";
import { fakeLauncherFs } from "../test/fake-fs";
import { loadProjectMap } from "./project";
import {
  addProject,
  importLegacyProjectMap,
  listProjects,
  loadProjectRegistry,
  projectRegistryPath,
  removeProject,
  renameProject,
  setCollapsed,
  touchProject,
} from "./project-registry";

/**
 * Project registry (plan 58 M1): canonical-path-keyed project metadata with no session ids.
 * Driven through an in-memory fake fs - no real disk.
 */

const STATE_HOME = "/state/belay";
const HOME = "/home/kevin";

test("projectRegistryPath joins stateHome with the registry filename", () => {
  assert.equal(projectRegistryPath("/state/belay"), "/state/belay/project-registry.json");
});

test("loadProjectRegistry returns empty map for absent file (never throws)", () => {
  const fs = fakeLauncherFs();
  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 0);
});

test("loadProjectRegistry returns empty map for malformed file (never throws)", () => {
  const fs = fakeLauncherFs();
  fs.writeFile(projectRegistryPath(STATE_HOME), "not json{");
  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 0);
});

test("addProject creates a record with correct displayPath and displayName", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-alpha";
  const record = addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  assert.equal(record.path, path);
  // Path is not under home, so displayPath is the path unchanged.
  assert.equal(record.displayPath, "/work/app-alpha");
  assert.equal(record.displayName, "app-alpha");
  assert.equal(record.collapsed, false);
  assert.equal(record.createdAt, "2026-06-26T00:00:00Z");
  assert.equal(record.updatedAt, "2026-06-26T00:00:00Z");

  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 1);
  assert.deepEqual(registry.get(path), record);
});

test("addProject abbreviates home-relative displayPath", () => {
  const fs = fakeLauncherFs();
  const path = `${HOME}/dev/belay`;
  const record = addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  assert.equal(record.displayPath, "~/dev/belay");
});

test("addProject on an existing path bumps updatedAt without duplicating", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-alpha";
  const first = addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  const second = addProject(fs, STATE_HOME, path, "2026-07-01T00:00:00Z", HOME);
  assert.equal(second.path, path);
  assert.equal(second.updatedAt, "2026-07-01T00:00:00Z");
  // createdAt is preserved from the original.
  assert.equal(second.createdAt, first.createdAt);
  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 1);
});

test("touchProject bumps updatedAt on existing project", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-alpha";
  addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  const touched = touchProject(fs, STATE_HOME, path, "2026-07-02T00:00:00Z", HOME);
  assert.equal(touched.updatedAt, "2026-07-02T00:00:00Z");
  assert.equal(touched.path, path);
});

test("touchProject adds if missing", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-beta";
  const touched = touchProject(fs, STATE_HOME, path, "2026-07-02T00:00:00Z", HOME);
  assert.equal(touched.path, path);
  assert.equal(touched.displayName, "app-beta");
  assert.equal(touched.updatedAt, "2026-07-02T00:00:00Z");
  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 1);
});

test("renameProject sets displayName and updatedAt", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-alpha";
  addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  const renamed = renameProject(fs, STATE_HOME, path, "My Alpha", "2026-07-03T00:00:00Z");
  assert.equal(renamed?.displayName, "My Alpha");
  assert.equal(renamed?.updatedAt, "2026-07-03T00:00:00Z");
});

test("renameProject returns null for unknown path", () => {
  const fs = fakeLauncherFs();
  const renamed = renameProject(fs, STATE_HOME, "/work/unknown", "X", "2026-07-03T00:00:00Z");
  assert.equal(renamed, null);
});

test("setCollapsed sets collapsed and updatedAt", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-alpha";
  addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  const updated = setCollapsed(fs, STATE_HOME, path, true, "2026-07-03T00:00:00Z");
  assert.equal(updated?.collapsed, true);
  assert.equal(updated?.updatedAt, "2026-07-03T00:00:00Z");
  // Toggle back.
  const toggled = setCollapsed(fs, STATE_HOME, path, false, "2026-07-04T00:00:00Z");
  assert.equal(toggled?.collapsed, false);
});

test("setCollapsed returns null for unknown path", () => {
  const fs = fakeLauncherFs();
  const updated = setCollapsed(fs, STATE_HOME, "/work/unknown", true, "2026-07-03T00:00:00Z");
  assert.equal(updated, null);
});

test("removeProject deletes and returns true", () => {
  const fs = fakeLauncherFs();
  const path = "/work/app-alpha";
  addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  assert.equal(removeProject(fs, STATE_HOME, path), true);
  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 0);
});

test("removeProject returns false for unknown path", () => {
  const fs = fakeLauncherFs();
  assert.equal(removeProject(fs, STATE_HOME, "/work/unknown"), false);
});

test("listProjects returns records sorted by updatedAt descending", () => {
  const fs = fakeLauncherFs();
  addProject(fs, STATE_HOME, "/work/app-a", "2026-06-01T00:00:00Z", HOME);
  addProject(fs, STATE_HOME, "/work/app-b", "2026-07-01T00:00:00Z", HOME);
  addProject(fs, STATE_HOME, "/work/app-c", "2026-06-15T00:00:00Z", HOME);
  const list = listProjects(fs, STATE_HOME);
  assert.equal(list.length, 3);
  assert.ok(list[0]);
  assert.ok(list[1]);
  assert.ok(list[2]);
  assert.equal(list[0].path, "/work/app-b");
  assert.equal(list[1].path, "/work/app-c");
  assert.equal(list[2].path, "/work/app-a");
});

test("listProjects returns empty array when registry is absent", () => {
  const fs = fakeLauncherFs();
  const list = listProjects(fs, STATE_HOME);
  assert.deepEqual(list, []);
});

test("importLegacyProjectMap imports all entries from projects.json", () => {
  const fs = fakeLauncherFs();
  // Seed a legacy projects.json under HOME.
  const legacyMap = {
    "/work/app-a": { root: "/work/app-a", sessionId: "sess-a", updatedAt: "2026-06-01T00:00:00Z" },
    "/work/app-b": { root: "/work/app-b", sessionId: "sess-b", updatedAt: "2026-07-01T00:00:00Z" },
  };
  fs.writeFile(`${HOME}/projects.json`, JSON.stringify(legacyMap));

  const result = importLegacyProjectMap(fs, STATE_HOME, HOME);
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);

  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 2);
  assert.equal(registry.get("/work/app-a")?.displayName, "app-a");
  assert.equal(registry.get("/work/app-b")?.displayName, "app-b");
});

test("importLegacyProjectMap is idempotent on re-run", () => {
  const fs = fakeLauncherFs();
  const legacyMap = {
    "/work/app-a": { root: "/work/app-a", sessionId: "sess-a", updatedAt: "2026-06-01T00:00:00Z" },
  };
  fs.writeFile(`${HOME}/projects.json`, JSON.stringify(legacyMap));

  importLegacyProjectMap(fs, STATE_HOME, HOME);
  const second = importLegacyProjectMap(fs, STATE_HOME, HOME);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);

  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.size, 1);
});

test("importLegacyProjectMap skips malformed entries", () => {
  const fs = fakeLauncherFs();
  // One well-formed, one malformed (missing sessionId).
  const legacyMap = {
    "/work/app-a": { root: "/work/app-a", sessionId: "sess-a", updatedAt: "2026-06-01T00:00:00Z" },
    "/work/bad": { root: "/work/bad", updatedAt: "2026-06-01T00:00:00Z" },
  };
  fs.writeFile(`${HOME}/projects.json`, JSON.stringify(legacyMap));

  const result = importLegacyProjectMap(fs, STATE_HOME, HOME);
  // loadProjectMap filters malformed entries, so importLegacyProjectMap only sees the good one.
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);

  const registry = loadProjectRegistry(fs, STATE_HOME);
  assert.equal(registry.has("/work/bad"), false);
  assert.equal(registry.has("/work/app-a"), true);
});

test("importLegacyProjectMap does not delete projects.json", () => {
  const fs = fakeLauncherFs();
  fs.writeFile(
    `${HOME}/projects.json`,
    JSON.stringify({
      "/work/app-a": {
        root: "/work/app-a",
        sessionId: "sess-a",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    }),
  );
  importLegacyProjectMap(fs, STATE_HOME, HOME);
  assert.equal(fs.exists(`${HOME}/projects.json`), true);
});

test("the registry stores NO session ids (only project metadata)", () => {
  const fs = fakeLauncherFs();
  addProject(fs, STATE_HOME, "/work/app-a", "2026-06-01T00:00:00Z", HOME);
  const raw = fs.readFile(projectRegistryPath(STATE_HOME));
  assert.ok(raw != null, "registry file was written");
  assert.equal(raw.includes("sessionId"), false);
});

test("addProject displayName defaults to basename", () => {
  const fs = fakeLauncherFs();
  const path = "/work/some-nested-dir";
  const record = addProject(fs, STATE_HOME, path, "2026-06-26T00:00:00Z", HOME);
  assert.equal(record.displayName, basename(path));
});

test("importLegacyProjectMap works with an empty projects.json", () => {
  const fs = fakeLauncherFs();
  fs.writeFile(`${HOME}/projects.json`, "{}");
  const result = importLegacyProjectMap(fs, STATE_HOME, HOME);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 0);
});

test("loadProjectMap import is available for cross-check", () => {
  // Sanity: the legacy loader is still exported and intact (no regression from the registry addition).
  assert.equal(typeof loadProjectMap, "function");
});

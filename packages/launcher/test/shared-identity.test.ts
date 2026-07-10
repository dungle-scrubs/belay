import assert from "node:assert/strict";
import {
  type LauncherFs,
  projectSessionId,
  resolveProjectRoot,
  resolveSession,
} from "@trevor/launcher";
import { test } from "vitest";

/**
 * The launcher core is the SINGLE source of project/session identity (plan 44.1 D-002): the `trevor`
 * CLI and a non-CLI caller (the supervisor daemon, later a desktop core) both resolve identity through
 * the `@trevor/launcher` public API, so they can never derive a different root or session id for the
 * same cwd. This pins that both callers - each importing ONLY from `@trevor/launcher` - agree
 * byte-for-byte, and that the persisted derivation matches the pure `projectSessionId`.
 */

function fakeFs(present: Iterable<string> = []): LauncherFs {
  const files = new Map<string, string>();
  const marks = new Set(present);
  return {
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => {
      files.set(path, content);
      marks.add(path);
    },
    exists: (path) => files.has(path) || marks.has(path),
    directoryExists: (path) => [...files.keys(), ...marks].some((k) => k.startsWith(`${path}/`)),
    remove: (path) => {
      files.delete(path);
      marks.delete(path);
    },
  };
}

test("the CLI and a non-CLI caller resolve the SAME project root + session id via @trevor/launcher", () => {
  const cwd = "/work/app/src/deep";
  const home = "/state/trevor";
  const gitRoot = "/work/app";

  // Two independent callers (the CLI and the supervisor), each with its own fresh fs + registry, both
  // driving the public @trevor/launcher API for the same cwd.
  const cli = fakeFs([`${gitRoot}/.git`]);
  const supervisor = fakeFs([`${gitRoot}/.git`]);

  const cliRoot = resolveProjectRoot(cwd, cli);
  const supervisorRoot = resolveProjectRoot(cwd, supervisor);
  assert.equal(cliRoot, gitRoot);
  assert.equal(supervisorRoot, cliRoot);

  const cliSession = resolveSession(cli, home, cliRoot, "2026-07-04T00:00:00Z");
  // A different clock on the supervisor side must not change the derived id (only provenance).
  const supervisorSession = resolveSession(
    supervisor,
    home,
    supervisorRoot,
    "2026-07-04T01:00:00Z",
  );
  assert.equal(cliSession, supervisorSession);
  // ...and both equal the deterministic derivation the same public API exposes.
  assert.equal(cliSession, projectSessionId(cliRoot));
});

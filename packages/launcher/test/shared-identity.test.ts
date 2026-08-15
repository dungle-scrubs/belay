import assert from "node:assert/strict";
import { projectSessionId, resolveProjectRoot, resolveSession } from "@belay/launcher";
import { test } from "vitest";
import { fakeLauncherFs } from "./fake-fs";

/**
 * The launcher core is the SINGLE source of project/session identity (plan 44.1 D-002): the `belay`
 * CLI and a non-CLI caller (the supervisor daemon, later a desktop core) both resolve identity through
 * the `@belay/launcher` public API, so they can never derive a different root or session id for the
 * same cwd. This pins that both callers - each importing ONLY from `@belay/launcher` - agree
 * byte-for-byte, and that the persisted derivation matches the pure `projectSessionId`.
 */

test("the CLI and a non-CLI caller resolve the SAME project root + session id via @belay/launcher", () => {
  const cwd = "/work/app/src/deep";
  const home = "/state/belay";
  const gitRoot = "/work/app";

  // Two independent callers (the CLI and the supervisor), each with its own fresh fs + registry, both
  // driving the public @belay/launcher API for the same cwd.
  const cli = fakeLauncherFs([`${gitRoot}/.git`]);
  const supervisor = fakeLauncherFs([`${gitRoot}/.git`]);

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

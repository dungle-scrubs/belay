import assert from "node:assert/strict";
import { test } from "vitest";
import { buildHostSpawnCommand } from "../src/platform";

test("host spawn command uses opchain when the Trevor env file exists", () => {
  const command = buildHostSpawnCommand({
    envFile: "/home/.trevor/.env.op",
    envFileExists: true,
    hostMain: "/repo/apps/agent-host/src/main.ts",
    nodePath: "/usr/local/bin/node",
    tsxCli: "/repo/node_modules/tsx/cli.mjs",
  });

  assert.equal(command.file, "opchain");
  assert.deepEqual(command.args, [
    "primary",
    "--read",
    "op",
    "run",
    "--env-file=/home/.trevor/.env.op",
    "--",
    "/usr/local/bin/node",
    "/repo/node_modules/tsx/cli.mjs",
    "/repo/apps/agent-host/src/main.ts",
  ]);
  assert.equal(
    command.command,
    "opchain primary --read op run --env-file=<TREVOR_HOME>/.env.op -- tsx agent-host",
  );
});

test("host spawn command falls back to direct node when the Trevor env file is absent", () => {
  const command = buildHostSpawnCommand({
    envFile: "/home/.trevor/.env.op",
    envFileExists: false,
    hostMain: "/repo/apps/agent-host/src/main.ts",
    nodePath: "/usr/local/bin/node",
    tsxCli: "/repo/node_modules/tsx/cli.mjs",
  });

  assert.equal(command.file, "/usr/local/bin/node");
  assert.deepEqual(command.args, [
    "/repo/node_modules/tsx/cli.mjs",
    "/repo/apps/agent-host/src/main.ts",
  ]);
  assert.equal(command.command, "tsx agent-host");
});

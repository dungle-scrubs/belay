import assert from "node:assert/strict";
import { test } from "vitest";
import { buildHostSpawnCommand, findListenerPids, parseListenerPids } from "../src/platform";

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

test("parseListenerPids reads lsof -t output into unique positive pids", () => {
  // One pid per line, possibly repeated across fds (IPv4 + IPv6 sockets of the same process).
  assert.deepEqual(parseListenerPids("123\n456\n123\n"), [123, 456]);
  assert.deepEqual(parseListenerPids(" 789 \n"), [789]);
  assert.deepEqual(parseListenerPids(""), []);
  assert.deepEqual(parseListenerPids("garbage\n-5\n0\n"), []);
});

test("findListenerPids scans the given port and degrades to empty on a scanner failure", async () => {
  const scanned: number[] = [];
  const pids = await findListenerPids(17424, (port) => {
    scanned.push(port);
    return Promise.resolve("17\n17\n99\n");
  });
  assert.deepEqual(pids, [17, 99]);
  assert.deepEqual(scanned, [17424]);

  // A missing lsof binary (or any scan failure) reads as "no listener", never a throw.
  assert.deepEqual(
    await findListenerPids(17424, () => Promise.reject(new Error("lsof missing"))),
    [],
  );
});

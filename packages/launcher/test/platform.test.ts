import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { isLaunchError } from "../src/launch";
import {
  awaitSpawned,
  buildHostSpawnCommand,
  findListenerPids,
  parseListenerPids,
} from "../src/platform";

test("host spawn command uses opchain when the Belay env file exists", () => {
  const command = buildHostSpawnCommand({
    envFile: "/home/.belay/.env.op",
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
    "--env-file=/home/.belay/.env.op",
    "--",
    "/usr/local/bin/node",
    "/repo/node_modules/tsx/cli.mjs",
    "/repo/apps/agent-host/src/main.ts",
  ]);
  assert.equal(
    command.command,
    "opchain primary --read op run --env-file=<BELAY_HOME>/.env.op -- tsx agent-host",
  );
});

test("host spawn command falls back to direct node when the Belay env file is absent", () => {
  const command = buildHostSpawnCommand({
    envFile: "/home/.belay/.env.op",
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

test("awaitSpawned resolves on the spawn event and rejects with a typed spawn-failed error on child error", async () => {
  // The happy path: the child announces `spawn`.
  const okChild = new EventEmitter();
  const ok = awaitSpawned(okChild as unknown as ChildProcess, "/work/app");
  okChild.emit("spawn");
  await ok;

  // The failure path (root vanished between check and spawn, bad executable): the child emits
  // `error`, which without a listener would be an uncaught event that kills the whole process -
  // the supervisor crash this plan removes. It must surface as a typed rejection instead.
  const badChild = new EventEmitter();
  const failed = awaitSpawned(badChild as unknown as ChildProcess, "/gone/project");
  badChild.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(
    failed,
    (error: unknown) =>
      isLaunchError(error) &&
      error.code === "spawn-failed" &&
      error.root === "/gone/project" &&
      error.message.includes("spawn ENOENT"),
  );
  // A late error event after settling must stay handled (no uncaught 'error' crash).
  badChild.emit("error", new Error("late error"));
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

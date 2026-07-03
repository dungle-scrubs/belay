import assert from "node:assert/strict";
import { test } from "vitest";
import { createProgrammaticCommandDispatcher } from "./programmatic-command";

test("programmatic dispatcher routes named handlers and falls back for ordinary commands", async () => {
  const calls: string[] = [];
  const dispatcher = createProgrammaticCommandDispatcher({
    handlers: [
      {
        name: "/known",
        run: (args) => {
          calls.push(`known:${args}`);
        },
      },
    ],
    fallback: (command, args) => {
      calls.push(`fallback:${command}:${args}`);
    },
  });

  dispatcher.dispatch("/known", "a");
  dispatcher.dispatch("/other", "b");
  await Promise.resolve();

  assert.deepEqual(calls, ["known:a", "fallback:/other:b"]);
});

test("programmatic dispatcher catches async handler failures", async () => {
  const calls: string[] = [];
  const dispatcher = createProgrammaticCommandDispatcher({
    handlers: [
      {
        name: "/fails",
        run: async () => {
          calls.push("called");
          throw new Error("boom");
        },
      },
    ],
    fallback: () => {
      calls.push("fallback");
    },
  });

  dispatcher.dispatch("/fails", "");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ["called"]);
});

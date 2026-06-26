import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vitest";
import { json, startServer } from "../src/index";

test("startServer binds an ephemeral port, serves, then closes", async () => {
  const server = createServer((_req, res) => json(res, 200, { ok: true }));
  const running = await startServer(server, { port: 0 });

  assert.ok(running.port > 0);
  assert.equal(running.url, `http://127.0.0.1:${running.port}`);

  const res = await fetch(`${running.url}/`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  await running.close();

  // After close the port no longer accepts connections.
  await assert.rejects(() => fetch(running.url));
});

test("startServer invokes onListen with the resolved port", async () => {
  let reported = -1;
  const server = createServer((_req, res) => res.end());
  const running = await startServer(server, {
    port: 0,
    onListen: (port) => {
      reported = port;
    },
  });

  assert.equal(reported, running.port);
  await running.close();
});

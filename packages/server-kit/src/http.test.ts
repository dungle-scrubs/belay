import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "vitest";
import { cors, json, readBody, readJson } from "./http";

/** A minimal ServerResponse stub recording the status, headers, and body it was given. */
function fakeRes(): ServerResponse & {
  status?: number;
  headers: Record<string, string>;
  body?: string;
} {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    writeHead(status: number, head?: Record<string, string>) {
      res.status = status;
      Object.assign(headers, head ?? {});
      return res;
    },
    end(body?: string) {
      res.body = body;
    },
  } as unknown as ServerResponse & {
    status?: number;
    headers: Record<string, string>;
    body?: string;
  };

  return res;
}

/** A minimal IncomingMessage stub that emits the given chunks then `end` on next tick. */
function fakeReq(chunks: (string | Buffer)[], emitError?: Error): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  // readBody calls req.destroy() when the body overruns the limit; stub it as a no-op.
  (req as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => {
    if (emitError) {
      req.emit("error", emitError);
      return;
    }
    for (const chunk of chunks) {
      req.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    req.emit("end");
  });

  return req;
}

test("cors sets permissive origin/headers and the given methods", () => {
  const res = fakeRes();
  cors(res, "GET, POST, OPTIONS");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.equal(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.equal(res.headers["access-control-allow-headers"], "content-type");
});

test("cors threads through a different method set (e.g. HEAD)", () => {
  const res = fakeRes();
  cors(res, "GET, HEAD, POST, OPTIONS");
  assert.equal(res.headers["access-control-allow-methods"], "GET, HEAD, POST, OPTIONS");
});

test("json writes status, content-type, and serialized body", () => {
  const res = fakeRes();
  json(res, 201, { ok: true, seq: 7 });
  assert.equal(res.status, 201);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.body ?? ""), { ok: true, seq: 7 });
});

test("readJson parses a JSON body", async () => {
  const parsed = await readJson(fakeReq(['{"sessionId":', '"s1"}']));
  assert.deepEqual(parsed, { sessionId: "s1" });
});

test("readJson resolves an empty body to {}", async () => {
  assert.deepEqual(await readJson(fakeReq([])), {});
});

test("readJson rejects on malformed JSON", async () => {
  await assert.rejects(() => readJson(fakeReq(["{not json"])));
});

test("readBody concatenates chunks into the full byte payload", async () => {
  const bytes = await readBody(fakeReq([Buffer.from([1, 2]), Buffer.from([3])]), 1024);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("readBody rejects once the payload exceeds the limit", async () => {
  await assert.rejects(() => readBody(fakeReq([Buffer.alloc(10)]), 4), /payload exceeds 4 bytes/);
});

test("readBody rejects when the request errors", async () => {
  await assert.rejects(() => readBody(fakeReq([], new Error("boom")), 1024), /boom/);
});

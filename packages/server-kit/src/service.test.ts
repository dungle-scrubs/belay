import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "vitest";
import { createService, type Route } from "./service";

/**
 * Unit coverage for the request lifecycle createService owns - CORS, OPTIONS, /health, first-match
 * dispatch (with RegExp capture params), the 404 fallthrough, and the 500 safety net for a handler
 * that rejects. The stores cover the happy paths end-to-end; this pins the generic behavior without
 * booting a server, by invoking the request listener directly with stubs.
 */

/** A ServerResponse stub recording the status, headers, and body it was given; `headersSent` flips
 *  once writeHead runs (what the service's 500 safety net checks). Kept as its own mutable shape and
 *  cast to ServerResponse only when handed to the listener. */
function fakeRes() {
  const headers: Record<string, string> = {};
  let sent = false;
  const res = {
    status: undefined as number | undefined,
    body: undefined as string | undefined,
    headers,
    get headersSent() {
      return sent;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, head?: Record<string, string>) {
      res.status = status;
      sent = true;
      Object.assign(headers, head ?? {});
      return res;
    },
    end(body?: string) {
      res.body = body;
      return res;
    },
  };
  return res;
}

/** A minimal request stub: only method + url are read by the lifecycle. */
function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

/** Drives one request through the service's request listener and resolves once it settles. */
async function handle(routes: Route[], method: string, url: string) {
  const server = createService({ routes, corsMethods: "GET, POST, OPTIONS" });
  const listener = server.listeners("request")[0] as (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void;
  const res = fakeRes();
  listener(fakeReq(method, url), res as unknown as ServerResponse);
  // Let any async handler + the safety-net catch settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

const ok: Route = {
  method: "GET",
  match: "/ok",
  handler: ({ res }) => {
    res.end("ok");
  },
};

test("OPTIONS preflight is 204 with permissive CORS, before any route", async () => {
  const res = await handle([ok], "OPTIONS", "/ok");
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.equal(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
});

test("GET /health is served by the service, not a route", async () => {
  const res = await handle([], "GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body, JSON.stringify({ ok: true }));
});

test("a RegExp route receives its capture groups as params", async () => {
  let captured: readonly string[] = [];
  const route: Route = {
    method: "GET",
    match: /^\/items\/([^/]+)$/,
    handler: ({ res, params }) => {
      captured = params;
      res.end();
    },
  };
  await handle([route], "GET", "/items/abc");
  assert.deepEqual(captured, ["abc"]);
});

test("a path match with the wrong method falls through to 404", async () => {
  const res = await handle([ok], "POST", "/ok");
  assert.equal(res.status, 404);
});

test("an unmatched path is 404", async () => {
  const res = await handle([ok], "GET", "/nope");
  assert.equal(res.status, 404);
});

test("a handler that rejects is answered with a 500 safety net", async () => {
  const boom: Route = {
    method: "GET",
    match: "/boom",
    handler: () => Promise.reject(new Error("kaboom")),
  };
  const res = await handle([boom], "GET", "/boom");
  assert.equal(res.status, 500);
  assert.equal(res.body, JSON.stringify({ error: "internal error" }));
});

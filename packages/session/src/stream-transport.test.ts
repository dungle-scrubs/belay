import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeStreamParams, encodeStreamParams } from "./identity";
import type { SessionIdentity } from "./transport";

/**
 * The stream-param codec is the URL identity + cursor wire contract: the client
 * builder (encodeStreamParams) and the store's parser (decodeStreamParams) share it
 * so a renamed/added identity field breaks BOTH sides at compile time instead of
 * silently desyncing them. These pin the round-trip and the conformance property the
 * store leans on: it reads back exactly the param names the client writes.
 */

const identity: SessionIdentity = {
  displayName: "Trevor Host",
  runtimeKind: "trevor",
  instanceId: "instance-7",
  participantId: "trevor-host",
  capabilities: { web_search: true, depth: 3 },
};

test("encodeStreamParams -> decodeStreamParams round-trips the identity + cursor", () => {
  const params = encodeStreamParams(identity, 42);
  const decoded = decodeStreamParams(params);

  assert.deepEqual(decoded.identity, identity);
  assert.equal(decoded.afterSeq, 42);
});

test("decodeStreamParams reads exactly the param names encodeStreamParams writes", () => {
  // Re-parsing the encoded query string (as the store does off the WebSocket URL)
  // recovers the same identity fields the client stamped - the conformance property
  // that keeps client and store from drifting apart on a param rename.
  const encoded = encodeStreamParams(identity, 9).toString();
  const { identity: read, afterSeq } = decodeStreamParams(new URLSearchParams(encoded));

  assert.equal(read.displayName, identity.displayName);
  assert.equal(read.runtimeKind, identity.runtimeKind);
  assert.equal(read.instanceId, identity.instanceId);
  assert.equal(read.participantId, identity.participantId);
  assert.deepEqual(read.capabilities, identity.capabilities);
  assert.equal(afterSeq, 9);
});

test("decodeStreamParams falls back to empty fields + zero cursor for a bare query", () => {
  const { identity: read, afterSeq } = decodeStreamParams(new URLSearchParams());

  assert.deepEqual(read, {
    displayName: "",
    runtimeKind: "",
    instanceId: "",
    participantId: "",
    capabilities: {},
  });
  assert.equal(afterSeq, 0);
});

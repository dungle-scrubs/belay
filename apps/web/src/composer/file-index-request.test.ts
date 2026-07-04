import assert from "node:assert/strict";
import { test } from "vitest";
import { shouldRequestFileIndex } from "./file-index-request";

test("does not request with no active mention", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: null,
      ready: false,
      leaderId: "h1",
      sessionId: "s",
      askedFor: null,
    }),
    false,
  );
});

test("does not request once the index is ready", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: "app",
      ready: true,
      leaderId: "h1",
      sessionId: "s",
      askedFor: null,
    }),
    false,
  );
});

test("does not request with no leader present", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: "app",
      ready: false,
      leaderId: null,
      sessionId: "s",
      askedFor: null,
    }),
    false,
  );
});

test("requests once for a fresh (session, leader) pair", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: "app",
      ready: false,
      leaderId: "h1",
      sessionId: "s",
      askedFor: null,
    }),
    true,
  );
});

test("does not re-request the SAME (session, leader) pair while still awaiting an answer", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: "app",
      ready: false,
      leaderId: "h1",
      sessionId: "s",
      askedFor: { sessionId: "s", leaderId: "h1" },
    }),
    false,
  );
});

test("retries when the leader CHANGES while still not ready - a lost request never wedges the picker", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: "app",
      ready: false,
      leaderId: "h2",
      sessionId: "s",
      askedFor: { sessionId: "s", leaderId: "h1" },
    }),
    true,
  );
});

test("retries when the session changes even if the leader stayed the same", () => {
  assert.equal(
    shouldRequestFileIndex({
      activeMentionQuery: "app",
      ready: false,
      leaderId: "h1",
      sessionId: "s2",
      askedFor: { sessionId: "s1", leaderId: "h1" },
    }),
    true,
  );
});

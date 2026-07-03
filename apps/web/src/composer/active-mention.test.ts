import assert from "node:assert/strict";
import { test } from "vitest";
import { activeMention } from "./active-mention";

test("no mention on an empty draft or a caret before the @", () => {
  assert.equal(activeMention("", 0), null);
  assert.equal(activeMention("@foo", 0), null); // caret sits on the @, not inside the token
});

test("an @ at the start of the draft opens a mention", () => {
  assert.deepEqual(activeMention("@foo", 4), { start: 0, end: 4, query: "foo" });
});

test("an empty @ token (caret right after @) is active with an empty query", () => {
  assert.deepEqual(activeMention("@", 1), { start: 0, end: 1, query: "" });
});

test("an @ after whitespace opens a mention; the query is the whole token", () => {
  assert.deepEqual(activeMention("hi @app", 7), { start: 3, end: 7, query: "app" });
});

test("the query stays the whole token when the caret is in the middle of it", () => {
  assert.deepEqual(activeMention("@foo/bar", 2), { start: 0, end: 8, query: "foo/bar" });
});

test("path characters (slash, dot, dash) stay inside the token", () => {
  assert.deepEqual(activeMention("@apps/web/src/app.tsx", 21), {
    start: 0,
    end: 21,
    query: "apps/web/src/app.tsx",
  });
});

test("the token ends at the next whitespace, not at end of draft", () => {
  assert.deepEqual(activeMention("@foo bar", 4), { start: 0, end: 4, query: "foo" });
});

test("an email does not open a mention (the @ is preceded by a word char)", () => {
  assert.equal(activeMention("mail me at joe@work.com", 18), null);
});

test("a mid-word @ does not open a mention", () => {
  assert.equal(activeMention("foo@", 4), null);
});

test("open punctuation before the @ counts as a boundary", () => {
  assert.deepEqual(activeMention("see (@app", 9), { start: 5, end: 9, query: "app" });
});

test("a mention opens on any line of a multiline draft", () => {
  assert.deepEqual(activeMention("first line\n@app", 15), { start: 11, end: 15, query: "app" });
});

test("a caret in a later word does not reopen an earlier @ token", () => {
  assert.equal(activeMention("@foo bar", 8), null);
});

test("the shell lane (leading !) never opens a mention", () => {
  assert.equal(activeMention("!ls @app", 8), null);
});

test("a bare slash-command lane has no @ and no mention", () => {
  assert.equal(activeMention("/doctor", 7), null);
});

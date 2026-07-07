import assert from "node:assert/strict";
import { test } from "vitest";
import { isNewSessionCommand, NEW_SESSION_COMMAND } from "./new-session-command";

/**
 * Plan 44.2 M1: the `/new` browser-side UI command. The descriptor is what the slash autocomplete
 * lists; the matcher is the composer submit intercept that opens the picker. Pure, so the shown
 * command and the intercept condition are proven together and cannot drift.
 */

test("the descriptor is the /new command shown in the command list", () => {
  assert.deepEqual(NEW_SESSION_COMMAND, {
    name: "/new",
    summary: "Start a session in a folder",
  });
});

test("the matcher accepts the bare command and a command with an argument", () => {
  assert.equal(isNewSessionCommand("/new"), true, "bare /new launches a fresh session");
  assert.equal(isNewSessionCommand("/new ~/dev/foo"), true, "an argument launches for that path");
});

test("the matcher rejects prefixes, embeds, and other commands", () => {
  assert.equal(isNewSessionCommand("/news"), false, "a longer command is not /new");
  assert.equal(isNewSessionCommand("/newer"), false, "a longer command is not /new");
  assert.equal(isNewSessionCommand("hi /new"), false, "an embedded /new is not the command");
  assert.equal(isNewSessionCommand("/resume"), false, "another UI command is not /new");
  assert.equal(isNewSessionCommand(""), false, "empty text is not a command");
});

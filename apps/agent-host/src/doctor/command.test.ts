import assert from "node:assert/strict";
import { test } from "vitest";
import { type DoctorCommand, parseDoctorCommand } from "./command";

/**
 * D-073 M1: `/doctor` command-variant parsing. Pins the default view, each view alias, the
 * refresh/copy flags, token combination, last-view-wins, case-insensitivity, and lenient handling of
 * unknown tokens.
 */

const cmd = (over: Partial<DoctorCommand>): DoctorCommand => ({
  view: "summary",
  refresh: false,
  copy: false,
  ...over,
});

test("no args is the default structured summary view", () => {
  assert.deepEqual(parseDoctorCommand(""), cmd({}));
  assert.deepEqual(parseDoctorCommand("   "), cmd({}));
});

test("view tokens and their aliases map to the right view", () => {
  assert.equal(parseDoctorCommand("text").view, "text");
  assert.equal(parseDoctorCommand("plain").view, "text");
  assert.equal(parseDoctorCommand("full").view, "full");
  assert.equal(parseDoctorCommand("detail").view, "full");
  assert.equal(parseDoctorCommand("details").view, "full");
  assert.equal(parseDoctorCommand("json").view, "json");
  assert.equal(parseDoctorCommand("summary").view, "summary");
});

test("refresh and copy are orthogonal flags that combine with any view", () => {
  assert.deepEqual(parseDoctorCommand("refresh"), cmd({ refresh: true }));
  assert.deepEqual(parseDoctorCommand("recheck"), cmd({ refresh: true }));
  assert.deepEqual(parseDoctorCommand("copy"), cmd({ copy: true }));
  assert.deepEqual(
    parseDoctorCommand("full refresh copy"),
    cmd({ view: "full", refresh: true, copy: true }),
  );
  assert.deepEqual(parseDoctorCommand("json copy"), cmd({ view: "json", copy: true }));
});

test("tokens are case-insensitive and order-independent; the last view wins", () => {
  assert.equal(parseDoctorCommand("FULL").view, "full");
  assert.deepEqual(parseDoctorCommand("COPY Refresh"), cmd({ refresh: true, copy: true }));
  assert.equal(parseDoctorCommand("full json").view, "json", "a later view token wins");
  assert.equal(parseDoctorCommand("json full").view, "full");
});

test("an unrecognised token is ignored (no error), keeping the rest of the command", () => {
  assert.deepEqual(parseDoctorCommand("wat"), cmd({}));
  assert.deepEqual(parseDoctorCommand("full wat refresh"), cmd({ view: "full", refresh: true }));
});

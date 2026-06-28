import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveTrevorHome,
  resolveTrevorStateHome,
  TREVOR_HOME_DIRNAME,
  TREVOR_STATE_DIRNAME,
} from "./node-paths";

test("resolveTrevorHome defaults to the Trevor V2 config home", () => {
  assert.equal(resolveTrevorHome({}, "/Users/kevin"), "/Users/kevin/.trevorV2");
  assert.equal(TREVOR_HOME_DIRNAME, ".trevorV2");
});

test("resolveTrevorHome honors the TREVOR_HOME override", () => {
  assert.equal(
    resolveTrevorHome({ TREVOR_HOME: "/tmp/trevor-home" }, "/Users/kevin"),
    "/tmp/trevor-home",
  );
});

test("resolveTrevorStateHome defaults under the XDG state base, not the config dir", () => {
  assert.equal(resolveTrevorStateHome({}, "/Users/kevin"), "/Users/kevin/.local/state/trevorV2");
  assert.equal(TREVOR_STATE_DIRNAME, "trevorV2");
});

test("resolveTrevorStateHome honors XDG_STATE_HOME", () => {
  assert.equal(
    resolveTrevorStateHome({ XDG_STATE_HOME: "/var/state" }, "/Users/kevin"),
    "/var/state/trevorV2",
  );
});

test("resolveTrevorStateHome honors an explicit TREVOR_STATE_HOME over XDG", () => {
  assert.equal(
    resolveTrevorStateHome(
      { TREVOR_STATE_HOME: "/tmp/state", XDG_STATE_HOME: "/var/state" },
      "/Users/kevin",
    ),
    "/tmp/state",
  );
});

test("the state home and config home are distinct roots", () => {
  assert.notEqual(
    resolveTrevorStateHome({}, "/Users/kevin"),
    resolveTrevorHome({}, "/Users/kevin"),
  );
});

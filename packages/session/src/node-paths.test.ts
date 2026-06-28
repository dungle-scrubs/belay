import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveTrevorHome, TREVOR_HOME_DIRNAME } from "./node-paths";

test("resolveTrevorHome defaults to the Trevor V2 home directory", () => {
  assert.equal(resolveTrevorHome({}, "/Users/kevin"), "/Users/kevin/.trevorV2");
  assert.equal(TREVOR_HOME_DIRNAME, ".trevorV2");
});

test("resolveTrevorHome honors the TREVOR_HOME override", () => {
  assert.equal(
    resolveTrevorHome({ TREVOR_HOME: "/tmp/trevor-home" }, "/Users/kevin"),
    "/tmp/trevor-home",
  );
});

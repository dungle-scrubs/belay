import assert from "node:assert/strict";
import { test } from "vitest";
import {
  LEGACY_TREVOR_DIRNAME,
  type RootCategoryId,
  resolveRootPolicy,
  resolveTrevorHome,
  resolveTrevorStateHome,
  rootCategory,
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

test("resolveRootPolicy resolves all approved root categories in a stable order", () => {
  const policy = resolveRootPolicy({}, "/Users/kevin");
  assert.deepEqual(
    policy.map((category) => category.id),
    ["config", "state", "legacy", "temp", "browser", "external-pi", "external-agents"],
  );
  for (const category of policy) {
    if (category.id === "browser") {
      assert.equal(category.path, null, "browser is not a filesystem root");
    } else {
      assert.ok(category.path && category.path.length > 0, `${category.id} has a path`);
    }
  }
});

test("config and state categories resolve through the home/state owners", () => {
  assert.equal(rootCategory("config", {}, "/Users/kevin").path, "/Users/kevin/.trevorV2");
  assert.equal(
    rootCategory("state", {}, "/Users/kevin").path,
    "/Users/kevin/.local/state/trevorV2",
  );
});

test("legacy and external roots are read-only and correctly owned", () => {
  const legacy = rootCategory("legacy", {}, "/Users/kevin");
  assert.equal(legacy.path, `/Users/kevin/${LEGACY_TREVOR_DIRNAME}`);
  assert.equal(legacy.ownership, "trevor");
  assert.equal(legacy.writable, false);

  const pi = rootCategory("external-pi", {}, "/Users/kevin");
  assert.equal(pi.path, "/Users/kevin/.pi");
  assert.equal(pi.ownership, "external");
  assert.equal(pi.writable, false);

  assert.equal(rootCategory("external-agents", {}, "/Users/kevin").path, "/Users/kevin/.agents");
});

test("env overrides affect only the intended root", () => {
  const configOverride = { TREVOR_HOME: "/tmp/cfg" };
  assert.equal(rootCategory("config", configOverride, "/Users/kevin").path, "/tmp/cfg");
  assert.equal(
    rootCategory("state", configOverride, "/Users/kevin").path,
    "/Users/kevin/.local/state/trevorV2",
    "TREVOR_HOME must not move the state root",
  );

  const stateOverride = { TREVOR_STATE_HOME: "/tmp/state" };
  assert.equal(rootCategory("state", stateOverride, "/Users/kevin").path, "/tmp/state");
  assert.equal(
    rootCategory("config", stateOverride, "/Users/kevin").path,
    "/Users/kevin/.trevorV2",
    "TREVOR_STATE_HOME must not move the config root",
  );
});

test("rootCategory throws on an unknown id", () => {
  assert.throws(() => rootCategory("nope" as RootCategoryId, {}, "/Users/kevin"));
});

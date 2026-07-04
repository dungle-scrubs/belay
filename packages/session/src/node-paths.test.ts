import assert from "node:assert/strict";
import { test } from "vitest";
import {
  LEGACY_TREVOR_DIRNAME,
  type RootCategoryId,
  resolveRootPolicy,
  resolveTrevorHome,
  resolveTrevorStateHome,
  rootCategory,
  STORAGE_INVENTORY,
  storagePath,
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

test("every storage-inventory entry maps to a known root category", () => {
  const validIds = new Set(resolveRootPolicy({}, "/Users/kevin").map((category) => category.id));
  for (const entry of STORAGE_INVENTORY) {
    assert.ok(validIds.has(entry.category), `${entry.name} -> unknown category ${entry.category}`);
  }
});

test("storage-inventory names are unique", () => {
  const names = STORAGE_INVENTORY.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
});

test("the state-home runtime artifacts are all classified", () => {
  const stateNames = STORAGE_INVENTORY.filter((entry) => entry.category === "state").map(
    (entry) => entry.name,
  );
  for (const expected of [
    "sessions-db",
    "blobs",
    "host-registry",
    "locks",
    "cwd-locks",
    "projects-map",
    "logs",
    "provider-observations",
    "turn-stop-metrics",
    "worktrees",
  ]) {
    assert.ok(stateNames.includes(expected), `state inventory missing ${expected}`);
  }
});

test("storagePath resolves an entry under its category root and follows root overrides", () => {
  const sessionsDb = STORAGE_INVENTORY.find((entry) => entry.name === "sessions-db");
  assert.ok(sessionsDb);
  assert.equal(
    storagePath(sessionsDb, {}, "/Users/kevin"),
    "/Users/kevin/.local/state/trevorV2/sessions.db",
  );
  assert.equal(
    storagePath(sessionsDb, { TREVOR_STATE_HOME: "/tmp/state" }, "/Users/kevin"),
    "/tmp/state/sessions.db",
  );
});

test("the model-prefs entry is a config-home file that follows the TREVOR_HOME override (plan 51)", () => {
  const entry = STORAGE_INVENTORY.find((e) => e.name === "model-prefs");
  assert.ok(entry, "model-prefs is in the storage inventory");
  assert.equal(entry.category, "config", "model-prefs lives under the config home, not state");
  assert.equal(storagePath(entry, {}, "/Users/kevin"), "/Users/kevin/.trevorV2/model-prefs.json");
  assert.equal(
    storagePath(entry, { TREVOR_HOME: "/tmp/cfg" }, "/Users/kevin"),
    "/tmp/cfg/model-prefs.json",
    "the config override moves it, the state override must not",
  );
  assert.equal(
    storagePath(entry, { TREVOR_STATE_HOME: "/tmp/state" }, "/Users/kevin"),
    "/Users/kevin/.trevorV2/model-prefs.json",
  );
});

test("the docs-corpus root is classified under the state home and follows the state override", () => {
  const docs = STORAGE_INVENTORY.find((entry) => entry.name === "docs-corpus");
  assert.ok(docs, "docs-corpus is in the storage inventory");
  assert.equal(docs.category, "state");
  assert.equal(storagePath(docs, {}, "/Users/kevin"), "/Users/kevin/.local/state/trevorV2/docs");
  assert.equal(
    storagePath(docs, { TREVOR_STATE_HOME: "/tmp/state" }, "/Users/kevin"),
    "/tmp/state/docs",
  );
});

test("the observation corpus resolves under the state home and follows the state override", () => {
  const dir = STORAGE_INVENTORY.find((entry) => entry.name === "observation-corpus");
  const jsonl = STORAGE_INVENTORY.find((entry) => entry.name === "observation-provider-failures");
  const index = STORAGE_INVENTORY.find((entry) => entry.name === "observation-index");
  assert.ok(dir && jsonl && index, "the observation corpus entries are in the inventory");
  assert.equal(dir.category, "state");
  assert.equal(
    storagePath(dir, {}, "/Users/kevin"),
    "/Users/kevin/.local/state/trevorV2/observations",
  );
  assert.equal(
    storagePath(jsonl, { XDG_STATE_HOME: "/xdg/state" }, "/Users/kevin"),
    "/xdg/state/trevorV2/observations/provider-failures.jsonl",
  );
  assert.equal(
    storagePath(index, { TREVOR_STATE_HOME: "/tmp/state" }, "/Users/kevin"),
    "/tmp/state/observations/index.json",
  );
});

test("legacy-root resolves to ~/.trevor and external entries stay read-only", () => {
  const legacy = STORAGE_INVENTORY.find((entry) => entry.name === "legacy-root");
  assert.ok(legacy);
  assert.equal(storagePath(legacy, {}, "/Users/kevin"), `/Users/kevin/${LEGACY_TREVOR_DIRNAME}`);

  const piAuth = STORAGE_INVENTORY.find((entry) => entry.name === "pi-auth");
  assert.ok(piAuth);
  assert.equal(storagePath(piAuth, {}, "/Users/kevin"), "/Users/kevin/.pi/auth.json");
  assert.equal(rootCategory(piAuth.category, {}, "/Users/kevin").writable, false);
});

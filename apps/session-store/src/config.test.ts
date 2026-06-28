import assert from "node:assert/strict";
import { resolveTrevorHome } from "@trevor/session/node-paths";
import { test } from "vitest";
import { sessionStoreDbPath } from "./config";

test("session-store defaults its database under TREVOR_HOME", () => {
  assert.equal(sessionStoreDbPath({}, "/Users/kevin"), "/Users/kevin/.trevorV2/sessions.db");
});

test("session-store honors TREVOR_HOME before the default home directory", () => {
  assert.equal(
    sessionStoreDbPath({ TREVOR_HOME: "/tmp/trevor-home" }, "/Users/kevin"),
    "/tmp/trevor-home/sessions.db",
  );
  assert.equal(
    resolveTrevorHome({ TREVOR_HOME: "/tmp/trevor-home" }, "/Users/kevin"),
    "/tmp/trevor-home",
  );
});

test("session-store keeps SESSION_STORE_DB as the explicit database override", () => {
  assert.equal(
    sessionStoreDbPath(
      { SESSION_STORE_DB: "/tmp/custom.db", TREVOR_HOME: "/tmp/trevor-home" },
      "/Users/kevin",
    ),
    "/tmp/custom.db",
  );
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { sessionStoreDbPath } from "./config";

test("session-store defaults its database under the STATE home, not the config dir", () => {
  assert.equal(
    sessionStoreDbPath({}, "/Users/kevin"),
    "/Users/kevin/.local/state/belay/sessions.db",
  );
});

test("session-store follows BELAY_STATE_HOME / XDG_STATE_HOME", () => {
  assert.equal(
    sessionStoreDbPath({ BELAY_STATE_HOME: "/tmp/state" }, "/Users/kevin"),
    "/tmp/state/sessions.db",
  );
  assert.equal(
    sessionStoreDbPath({ XDG_STATE_HOME: "/var/state" }, "/Users/kevin"),
    "/var/state/belay/sessions.db",
  );
});

test("session-store keeps SESSION_STORE_DB as the explicit database override", () => {
  assert.equal(
    sessionStoreDbPath(
      { SESSION_STORE_DB: "/tmp/custom.db", BELAY_STATE_HOME: "/tmp/state" },
      "/Users/kevin",
    ),
    "/tmp/custom.db",
  );
});

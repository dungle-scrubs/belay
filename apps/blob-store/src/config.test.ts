import assert from "node:assert/strict";
import { test } from "vitest";
import { blobStoreRoot } from "./config";

test("blob-store defaults its root under the STATE home, not the config dir", () => {
  assert.equal(blobStoreRoot({}, "/Users/kevin"), "/Users/kevin/.local/state/belay/blobs");
});

test("blob-store follows BELAY_STATE_HOME / XDG_STATE_HOME", () => {
  assert.equal(
    blobStoreRoot({ BELAY_STATE_HOME: "/tmp/state" }, "/Users/kevin"),
    "/tmp/state/blobs",
  );
  assert.equal(
    blobStoreRoot({ XDG_STATE_HOME: "/var/state" }, "/Users/kevin"),
    "/var/state/belay/blobs",
  );
});

test("blob-store keeps BLOB_STORE_DIR as the explicit root override", () => {
  assert.equal(
    blobStoreRoot(
      { BLOB_STORE_DIR: "/tmp/custom-blobs", BELAY_STATE_HOME: "/tmp/state" },
      "/Users/kevin",
    ),
    "/tmp/custom-blobs",
  );
});

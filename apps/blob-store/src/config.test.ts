import assert from "node:assert/strict";
import { resolveTrevorHome } from "@trevor/session/node-paths";
import { test } from "vitest";
import { blobStoreRoot } from "./config";

test("blob-store defaults its root under TREVOR_HOME", () => {
  assert.equal(blobStoreRoot({}, "/Users/kevin"), "/Users/kevin/.trevorV2/blobs");
});

test("blob-store honors TREVOR_HOME before the default home directory", () => {
  assert.equal(
    blobStoreRoot({ TREVOR_HOME: "/tmp/trevor-home" }, "/Users/kevin"),
    "/tmp/trevor-home/blobs",
  );
  assert.equal(
    resolveTrevorHome({ TREVOR_HOME: "/tmp/trevor-home" }, "/Users/kevin"),
    "/tmp/trevor-home",
  );
});

test("blob-store keeps BLOB_STORE_DIR as the explicit root override", () => {
  assert.equal(
    blobStoreRoot(
      { BLOB_STORE_DIR: "/tmp/custom-blobs", TREVOR_HOME: "/tmp/trevor-home" },
      "/Users/kevin",
    ),
    "/tmp/custom-blobs",
  );
});

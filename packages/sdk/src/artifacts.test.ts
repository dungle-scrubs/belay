import { recordingTransport } from "@belay/test-kit";
import { describe, expect, it } from "vitest";
import { createTrevorClient } from "./client";

const SESSION_URL = "http://127.0.0.1:17424";

describe("artifact workflow guards (M3)", () => {
  it("uploading without a configured blob URL throws a typed SdkError", async () => {
    const client = createTrevorClient({
      sessionUrl: SESSION_URL,
      transport: recordingTransport().transport,
    });
    await expect(
      client.uploadArtifact(new Uint8Array([1, 2, 3]), "text/plain"),
    ).rejects.toMatchObject({
      operation: "uploadArtifact",
      backend: "blob",
    });
  });

  it("downloading a malformed hash is rejected before any request", async () => {
    const client = createTrevorClient({
      sessionUrl: SESSION_URL,
      blobUrl: "http://127.0.0.1:17423",
      transport: recordingTransport().transport,
    });
    await expect(client.downloadArtifact("not-a-hash")).rejects.toMatchObject({
      operation: "downloadArtifact",
      backend: "blob",
      backendUrlClass: "http://127.0.0.1:17423",
    });
  });
});

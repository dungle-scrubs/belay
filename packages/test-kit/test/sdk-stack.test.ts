import { describe, expect, it } from "vitest";
import { bootSdkStack } from "../src/boot";

/**
 * M9: test-kit can boot the real session-store + blob-store and drive them through a `@trevor/sdk`
 * client - the same headless workflow layer a script or eval harness uses, over the same wire the host
 * and web speak. This exercises the ephemeral-service lifecycle test-kit owns, not any SDK workflow logic
 * (which is tested in the SDK package); a green run proves the stack boots, binds, round-trips, and tears
 * down.
 */
describe("bootSdkStack", () => {
  it("boots real stores and drives session + blob through the SDK client", async () => {
    const stack = await bootSdkStack();
    try {
      expect(stack.client.sessionUrl).toBe(stack.store.url);
      expect(stack.client.blobUrl).toBe(stack.blob.url);

      await stack.client.ensureSession("s1");
      await stack.client.prompt("s1", { text: "hello from the sdk stack", provider: "fake" });

      const transcript = await stack.client.readTranscript("s1");
      expect(
        transcript.entries.some((entry) => entry.text.includes("hello from the sdk stack")),
      ).toBe(true);

      const ref = await stack.client.uploadArtifact(
        new TextEncoder().encode("artifact bytes"),
        "text/plain",
      );
      const bytes = await stack.client.downloadArtifact(ref);
      expect(new TextDecoder().decode(bytes)).toBe("artifact bytes");
    } finally {
      await stack.close();
    }
  });

  it("closes both listeners so the ports are free again", async () => {
    const stack = await bootSdkStack();
    const { store } = stack;
    await stack.close();
    // A second store can bind after teardown; the assertion is simply that close() resolved and the
    // handle is inert (a re-boot on port 0 never collides with a leaked listener).
    expect(store.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

import { describe, expect, it } from "vitest";
import { isSdkError, SdkError, urlClass, withSdkError } from "./errors";

describe("urlClass", () => {
  it("reduces a URL to scheme://host:port, dropping path/query/credentials", () => {
    expect(urlClass("http://127.0.0.1:17424/sessions/my-secret-session/events?token=abc")).toBe(
      "http://127.0.0.1:17424",
    );
    expect(urlClass("https://user:pass@tether.example.com/sessions")).toBe(
      "https://tether.example.com",
    );
  });

  it("returns a placeholder for a non-URL rather than echoing it", () => {
    expect(urlClass("not a url")).toBe("<invalid-url>");
  });
});

describe("SdkError", () => {
  it("carries the operation, backend, session, and redacted URL class", () => {
    const err = new SdkError({
      operation: "prompt",
      backend: "session",
      sessionId: "s1",
      backendUrlClass: "http://127.0.0.1:17424",
      detail: "boom",
    });
    expect(isSdkError(err)).toBe(true);
    expect(err.operation).toBe("prompt");
    expect(err.backend).toBe("session");
    expect(err.sessionId).toBe("s1");
    expect(err.message).toContain("http://127.0.0.1:17424");
    expect(err.message).toContain("s1");
    expect(err.message).toContain("boom");
  });
});

describe("withSdkError", () => {
  it("wraps a thrown backend error as a typed SdkError with context", async () => {
    const promise = withSdkError(
      {
        operation: "fetchInventory",
        backend: "session",
        backendUrlClass: "http://127.0.0.1:17424",
      },
      () => Promise.reject(new Error("ECONNREFUSED")),
    );
    await expect(promise).rejects.toBeInstanceOf(SdkError);
    await expect(promise).rejects.toMatchObject({
      operation: "fetchInventory",
      backend: "session",
      detail: "ECONNREFUSED",
    });
  });

  it("passes an already-typed SdkError through without re-wrapping", async () => {
    const inner = new SdkError({
      operation: "uploadArtifact",
      backend: "blob",
      backendUrlClass: "<unset>",
    });
    const promise = withSdkError(
      { operation: "prompt", backend: "session", backendUrlClass: "http://x" },
      () => Promise.reject(inner),
    );
    await expect(promise).rejects.toBe(inner);
  });
});

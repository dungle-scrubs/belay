import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  isRetryableClass,
  type ProviderFailureClass,
  redactSecrets,
} from "./failure-taxonomy";

/**
 * D-076 M1: the normalized provider-failure taxonomy. Pins the typed classification for each shape -
 * auth, context overflow, transient transport, rate limit, overload, provider/upstream unavailable,
 * local runtime unreachable, model/quota/request-rejected, and unknown - the derived retry verdict
 * (unknown defaults NON-retryable), and that redaction strips secrets so the payload can't leak keys.
 */

function classOf(over: Parameters<typeof classifyProviderFailure>[0]): ProviderFailureClass {
  return classifyProviderFailure(over).class;
}

describe("classifyProviderFailure", () => {
  it("classifies refused credentials as auth (terminal, re-auth)", () => {
    expect(classOf({ detail: "401 Unauthorized" })).toBe("auth");
    expect(classOf({ detail: "invalid api key" })).toBe("auth");
    expect(classOf({ detail: "boom", status: 403 })).toBe("auth");
    const v = classifyProviderFailure({ detail: "401" });
    expect(v.retryable).toBe(false);
    expect(v.userAction).toBe("reauth");
  });

  it("classifies a context-length rejection as overflow (handled by recovery, not retried)", () => {
    const v = classifyProviderFailure({ detail: "trying to keep the first 8000 tokens to keep" });
    expect(v.class).toBe("context_overflow");
    expect(v.retryable).toBe(false);
    expect(v.userAction).toBe("compact");
  });

  it("classifies transient transport faults as retryable", () => {
    for (const detail of [
      "socket hang up",
      "ECONNRESET",
      "request timed out",
      "stream closed unexpectedly",
      "websocket 1006",
      "premature close",
    ]) {
      const v = classifyProviderFailure({ detail });
      expect(v.class, detail).toBe("transient_transport");
      expect(v.retryable, detail).toBe(true);
    }
  });

  it("classifies a 429 as rate_limited and carries retry-after", () => {
    const v = classifyProviderFailure({
      detail: "Too Many Requests",
      status: 429,
      retryAfterMs: 2000,
    });
    expect(v.class).toBe("rate_limited");
    expect(v.retryable).toBe(true);
    expect(v.retryAfterMs).toBe(2000);
    expect(v.userAction).toBe("wait");
  });

  it("classifies overload (529 / 'overloaded') as provider_overloaded, retryable", () => {
    expect(classOf({ detail: "Overloaded" })).toBe("provider_overloaded");
    expect(classOf({ detail: "boom", status: 529 })).toBe("provider_overloaded");
    expect(isRetryableClass("provider_overloaded")).toBe(true);
  });

  it("classifies a gateway/upstream 5xx as provider_unavailable, retryable", () => {
    expect(classOf({ detail: "Bad Gateway", status: 502 })).toBe("provider_unavailable");
    expect(classOf({ detail: "Service Unavailable" })).toBe("provider_unavailable");
    expect(classOf({ detail: "upstream connect error" })).toBe("provider_unavailable");
  });

  it("classifies a connection refusal as local_runtime_unavailable only for a local provider", () => {
    const local = classifyProviderFailure({
      detail: "connect ECONNREFUSED 127.0.0.1:1234",
      local: true,
    });
    expect(local.class).toBe("local_runtime_unavailable");
    expect(local.retryable).toBe(false);
    expect(local.userAction).toBe("start_local_runtime");
    // The SAME text from a CLOUD provider stays a retryable transport fault (no local flag).
    const cloud = classifyProviderFailure({ detail: "connect ECONNREFUSED 127.0.0.1:1234" });
    expect(cloud.class).toBe("transient_transport");
    expect(cloud.retryable).toBe(true);
    // The host's own "not reachable" wording also classifies as local runtime down.
    expect(classOf({ detail: "LM Studio not reachable", local: true })).toBe(
      "local_runtime_unavailable",
    );
  });

  it("classifies model-not-loaded and quota/billing as terminal, actionable", () => {
    expect(classOf({ detail: "model not found: qwen-3" })).toBe("model_unavailable");
    expect(classOf({ detail: "insufficient_quota", code: "insufficient_quota" })).toBe(
      "quota_billing",
    );
    expect(classOf({ detail: "billing hard limit reached" })).toBe("quota_billing");
    expect(classOf({ detail: "boom", status: 402 })).toBe("quota_billing");
  });

  it("classifies an explicit 400 as request_rejected (terminal)", () => {
    expect(classOf({ detail: "invalid request: bad params", status: 400 })).toBe(
      "request_rejected",
    );
    expect(isRetryableClass("request_rejected")).toBe(false);
  });

  it("defaults an unrecognized shape to unknown and NON-retryable", () => {
    const v = classifyProviderFailure({ detail: "something nobody has classified yet" });
    expect(v.class).toBe("unknown");
    expect(v.retryable).toBe(false);
    expect(v.userAction).toBe("none");
  });

  it("prefers the structured status over message text (a 429 quota stays quota, not rate-limit)", () => {
    // A hard quota that also reports 429 must NOT be retried into the same failure.
    expect(classOf({ detail: "exceeded your current quota", status: 429 })).toBe("quota_billing");
  });
});

describe("redactSecrets", () => {
  it("strips bearer tokens, api keys, header values, and query secrets", () => {
    const dirty = [
      "Authorization: Bearer sk-ant-abc123DEF456ghi789",
      "x-api-key: pi-7f2a91c4e3b8aa00bb11",
      'request failed: {"api_key":"sk-deadbeefdeadbeef"}',
      "GET https://api.example.com/v1/models?key=topsecretvalue123",
    ].join("\n");
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("sk-ant-abc123DEF456ghi789");
    expect(clean).not.toContain("pi-7f2a91c4e3b8aa00bb11");
    expect(clean).not.toContain("sk-deadbeefdeadbeef");
    expect(clean).not.toContain("topsecretvalue123");
    expect(clean).toContain("«redacted»");
  });

  it("is idempotent and leaves ordinary text untouched", () => {
    const plain = "connect ECONNREFUSED 127.0.0.1:1234";
    expect(redactSecrets(plain)).toBe(plain);
    const once = redactSecrets("Bearer sk-abcdef123456");
    expect(redactSecrets(once)).toBe(once);
  });
});
